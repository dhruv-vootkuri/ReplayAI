require('dotenv').config({ path: '../.env' });
const express = require('express');
const Redis = require('ioredis');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const FRIENDLI_API_KEY = process.env.FRIENDLI_API_KEY;
const TRACE_TTL = 86400;

if (!FRIENDLI_API_KEY) {
  console.error('[ERROR] FRIENDLI_API_KEY is required. Set it in .env');
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  retryStrategy: (t) => Math.min(t * 150, 3000),
  maxRetriesPerRequest: 2,
});
redis.on('error', (err) => console.error('[Redis]', err.message));

// ─── Hotel knowledge base ─────────────────────────────────────────────────────
//
// This is what the LLM is given as its "knowledge" about the hotel.
// THE BUG: the cancellation policy here says 48 hours, but the hotel
// updated their policy in 2024 to 24 hours. This document was never refreshed.
//
const HOTEL_KNOWLEDGE = `THE GRAND HOTEL — CONCIERGE REFERENCE GUIDE

Check-in & Check-out:
- Check-in: 3:00 PM | Check-out: 11:00 AM
- Early check-in: Subject to availability, $50 fee
- Late check-out: Subject to availability, $75 fee

Cancellation Policy:
- Standard bookings: Free cancellation up to 48 hours before check-in
- Within 48 hours of check-in: First night charged as cancellation fee
- Non-refundable rates: No refund under any circumstances
- Group bookings (5+ rooms): 7-day cancellation notice required

Dining:
- The Garden Bistro: Open daily 7:00 AM – 10:00 PM
- Room service: Available 24 hours
- Breakfast: Complimentary for suite guests; $28/person for standard rooms

Amenities:
- Heated outdoor pool: Open 6:00 AM – 9:00 PM (seasonal, May–October)
- Fitness center: Open 24 hours
- Spa: Open 9:00 AM – 8:00 PM, advance booking required
- Business center: Open 24 hours

Parking & Transport:
- Valet parking: $45/night | Self-parking: $30/night
- Airport shuttle: $35/person, requires 24-hour advance booking

WiFi:
- Complimentary in all rooms and common areas
- Network: TheGrandHotel_Guest | Password provided at check-in

Pets:
- Allowed in designated rooms only
- $75/night pet fee, max 2 pets under 25 lbs

Billing & Refunds:
- All charges posted to room account
- Disputed charges: Contact front desk within 72 hours of check-out
- Refund processing: 7–10 business days to original payment method`;

// ─── POST /chat ───────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const run_id = `run_${Date.now().toString(36)}`;
  const start_time = new Date().toISOString();

  console.log(`\n[${run_id}] Guest: "${message}"`);

  let response, duration_ms, error_detail;

  try {
    const start = Date.now();
    const result = await axios.post(
      'https://inference.friendli.ai/v1/chat/completions',
      {
        model: 'meta-llama-3.1-8b-instruct',
        messages: [
          {
            role: 'system',
            content: `You are the virtual concierge for The Grand Hotel. Answer the guest's question using only the information in the hotel reference guide below. If the answer is not in the guide, say so politely and offer to connect them with the front desk. Be warm and professional.\n\n${HOTEL_KNOWLEDGE}`,
          },
          { role: 'user', content: message },
        ],
        max_tokens: 512,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${FRIENDLI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    duration_ms = Date.now() - start;
    response = result.data.choices[0].message.content;
    console.log(`[${run_id}] Response (${duration_ms}ms): "${response.slice(0, 80)}..."`);
  } catch (err) {
    const msg = err.response?.data?.error?.message ?? err.message ?? 'FriendliAI call failed';
    console.error(`[${run_id}] FriendliAI error:`, msg);
    return res.status(502).json({ error: `Concierge unavailable: ${msg}` });
  }

  // ── Store trace in Redis ──────────────────────────────────────────────────
  const trace = {
    run_id,
    start_time,
    end_time: new Date().toISOString(),
    agent_name: 'Grand Hotel Concierge',
    user_query: message,
    context_given: HOTEL_KNOWLEDGE,
    response,
    duration_ms,
    model: 'meta-llama-3.1-8b-instruct',
    // Highlight which part of the knowledge base is most relevant to the answer
    relevant_context: extractRelevantContext(message, response, HOTEL_KNOWLEDGE),
  };

  try {
    await redis.set(`trace:${run_id}`, JSON.stringify(trace), 'EX', TRACE_TTL);
    // Index entry for natural language search
    const index = {
      run_id,
      timestamp: start_time,
      user_query: message,
      keywords: tokenize(message),
    };
    await redis.lpush('traces:index', JSON.stringify(index));
    await redis.ltrim('traces:index', 0, 499);
    console.log(`[${run_id}] Trace saved to Redis`);
  } catch (err) {
    console.warn(`[${run_id}] Redis save failed:`, err.message);
  }

  res.json({ response });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractRelevantContext(query, response, knowledge) {
  // Find the paragraphs/lines from the knowledge base most relevant to the query + response
  const lines = knowledge.split('\n').filter(l => l.trim().length > 10);
  const words = tokenize(query + ' ' + response);
  const scored = lines.map(line => {
    const lineWords = tokenize(line);
    const overlap = words.filter(w => lineWords.includes(w)).length;
    return { line: line.trim(), score: overlap };
  });
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.line);
}

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
}

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`[Grand Hotel Concierge] http://localhost:${PORT}`);
});
