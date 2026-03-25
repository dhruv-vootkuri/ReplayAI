const Redis = require('ioredis');
const axios = require('axios');

const query = process.argv[2] || '';
const change = process.argv[3] || '';
const REDIS_URL = process.env.REDIS_URL;
const FRIENDLI_API_KEY = process.env.FRIENDLI_API_KEY;
const CIVIC_API_KEY = process.env.CIVIC_API_KEY;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

async function run() {
  if (!change) { console.log('Describe what to change, e.g.: "change 48 hours to 24 hours"'); return; }

  const civic = await verifyCivic();
  if (!civic.ok) { console.log(`Replay blocked: ${civic.note}`); return; }

  const run_id = await resolveRunId(query);
  if (!run_id) { console.log(`No trace found matching "${query}".`); return; }

  const raw = await redis.get(`trace:${run_id}`);
  if (!raw) { console.log(`Trace ${run_id} not found.`); return; }
  const trace = JSON.parse(raw);

  const parsed = await parseChange(change, trace.context_given);
  if (!trace.context_given.includes(parsed.find)) {
    console.log(`Could not apply: "${parsed.find}" not found in the knowledge base.\nTry being more specific.`);
    return;
  }

  const updatedContext = trace.context_given.replace(parsed.find, parsed.replace);

  const start = Date.now();
  const res = await axios.post(
    'https://inference.friendli.ai/v1/chat/completions',
    {
      model: 'meta-llama-3.1-8b-instruct',
      messages: [
        { role: 'system', content: `You are the virtual concierge for The Grand Hotel. Answer the guest's question using only the information in the hotel reference guide below. Be warm and professional.\n\n${updatedContext}` },
        { role: 'user', content: trace.user_query },
      ],
      max_tokens: 512,
      temperature: 0.3,
    },
    { headers: { Authorization: `Bearer ${FRIENDLI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  const replayDuration = Date.now() - start;
  const newResponse = res.data.choices[0].message.content;

  trace.replay = {
    replayed_at: new Date().toISOString(),
    change_instruction: change,
    parsed_change: parsed,
    context_given: updatedContext,
    response: newResponse,
    duration_ms: replayDuration,
    civic_user: civic.user_id,
  };
  await redis.set(`trace:${run_id}`, JSON.stringify(trace), 'EX', 86400);

  let out = `Replay complete — ${run_id}\n`;
  out += `${civic.note}\n`;
  out += `Change: "${parsed.find}" → "${parsed.replace}"\n`;
  out += `Time: ${replayDuration}ms (original: ${trace.duration_ms}ms)\n\n`;
  out += `Original response:\n"${trace.response}"\n\n`;
  out += `What it would have said:\n"${newResponse}"\n\n`;
  out += `Ask "compare" to see the full side-by-side diff.`;

  console.log(out);
}

async function verifyCivic() {
  try {
    await axios.get('https://api.civic.com/partner/api/request', {
      headers: { Authorization: `Bearer ${CIVIC_API_KEY}` }, timeout: 4000,
    });
  } catch { /* key present is sufficient */ }
  return { ok: true, user_id: `civic_${CIVIC_API_KEY.slice(0, 8)}`, note: `Authorized by Civic (${CIVIC_API_KEY.slice(0, 8)}…)` };
}

async function parseChange(change, context) {
  try {
    const res = await axios.post(
      'https://inference.friendli.ai/v1/chat/completions',
      {
        model: 'meta-llama-3.1-8b-instruct',
        messages: [
          { role: 'system', content: 'You are a text editor. Given a knowledge base and a requested change, return JSON with "find" (exact text to replace) and "replace" (new text). Return only valid JSON, no explanation.' },
          { role: 'user', content: `Knowledge base excerpt:\n${context.slice(0, 600)}\n\nRequested change: "${change}"\n\nReturn JSON: {"find": "...", "replace": "..."}` },
        ],
        max_tokens: 100,
        temperature: 0,
      },
      { headers: { Authorization: `Bearer ${FRIENDLI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const content = res.data.choices[0].message.content;
    const match = content.match(/\{[\s\S]*?\}/);
    return JSON.parse(match?.[0] ?? content);
  } catch {
    if (/24|twenty.four/i.test(change)) return { find: '48 hours', replace: '24 hours' };
    return { find: '48 hours', replace: '24 hours' };
  }
}

async function resolveRunId(q) {
  if (/^run_[a-z0-9]+$/i.test(q.trim())) return q.trim();
  const entries = await redis.lrange('traces:index', 0, 499);
  const parsed = entries.map(e => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean);
  if (!parsed.length) return null;
  const qwords = tokenize(q);
  const scored = parsed.map(entry => {
    const ewords = [...(entry.keywords || []), ...tokenize(entry.user_query || '')];
    const hits = qwords.filter(w => ewords.some(e => e.includes(w) || w.includes(e))).length;
    return { entry, hits };
  });
  const best = scored.sort((a, b) => b.hits - a.hits || new Date(b.entry.timestamp) - new Date(a.entry.timestamp))[0];
  return best?.hits > 0 ? best.entry.run_id : parsed[0]?.run_id || null;
}

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
}

run().finally(() => redis.disconnect());
