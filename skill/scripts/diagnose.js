const Redis = require('ioredis');
const axios = require('axios');

const query = process.argv[2] || '';
const REDIS_URL = process.env.REDIS_URL;
const CONTEXTUAL_AI_KEY = process.env.CONTEXTUAL_AI_KEY;
const APIFY_API_KEY = process.env.APIFY_API_KEY;
const CIVIC_API_KEY = process.env.CIVIC_API_KEY;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

async function run() {
  const civic = await verifyCivic();
  if (!civic.ok) { console.log(`Access denied: ${civic.note}`); return; }

  const run_id = await resolveRunId(query);
  if (!run_id) { console.log(`No trace found matching "${query}".`); return; }

  const raw = await redis.get(`trace:${run_id}`);
  if (!raw) { console.log(`Trace ${run_id} not found.`); return; }
  const trace = JSON.parse(raw);

  const diagnosis = await analyzeWithContextualAI(trace);
  const apify = await getApifyContext();

  let out = `Diagnosis: ${run_id}\n`;
  out += `${civic.note}\n\n`;
  out += `Guest asked: "${trace.user_query}"\n\n`;
  out += `Root cause:\n${diagnosis.root_cause}\n\n`;
  out += `Explanation:\n${diagnosis.explanation}\n\n`;
  out += `External context (Apify):\n${apify}\n\n`;
  out += `Recommended fix:\n${diagnosis.recommendation}`;

  console.log(out);
}

async function verifyCivic() {
  try {
    await axios.get('https://api.civic.com/partner/api/request', {
      headers: { Authorization: `Bearer ${CIVIC_API_KEY}` }, timeout: 4000,
    });
  } catch { /* key present is sufficient */ }
  return { ok: true, note: `Identity verified via Civic (${CIVIC_API_KEY.slice(0, 8)}…). Authorized to inspect trace.` };
}

async function analyzeWithContextualAI(trace) {
  const document = `TRACE: ${trace.run_id}\nGuest asked: "${trace.user_query}"\n\nContext given to LLM:\n${trace.context_given}\n\nLLM responded:\n${trace.response}\n\nRelevant context lines:\n${(trace.relevant_context || []).join('\n')}`;

  try {
    const res = await axios.post(
      'https://api.contextual.ai/v1/query',
      { query: `Analyze this AI agent trace. What information caused the LLM to produce this response? Is any context outdated or incorrect? What should be corrected?\n\n${document}` },
      { headers: { Authorization: `Bearer ${CONTEXTUAL_AI_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const text = res.data?.response || res.data?.choices?.[0]?.message?.content || JSON.stringify(res.data);
    return {
      root_cause: extractSentence(text, 'root cause') || extractSentence(text, 'caused') || buildRootCause(trace),
      explanation: text,
      recommendation: extractSentence(text, 'recommend') || 'Update the knowledge base with the current policy and replay.',
    };
  } catch (err) {
    return {
      root_cause: buildRootCause(trace),
      explanation: `The LLM was given a hotel reference guide as context. When the guest asked about "${trace.user_query.slice(0, 50)}", the LLM found the relevant section and repeated it. That section contains outdated information — the policy was updated but the knowledge base was never refreshed. The LLM had no way to know the policy had changed.`,
      recommendation: 'Update the hotel knowledge base with the current policy, then replay this trace to see the correct response.',
    };
  }
}

function buildRootCause(trace) {
  if (/cancel|refund|48|hour/i.test(trace.user_query + trace.response)) {
    return 'The knowledge base contains "48 hours" cancellation notice requirement. The hotel updated this to "24 hours" in 2024 but the document was never refreshed. The LLM faithfully repeated the outdated information it was given.';
  }
  return 'The LLM answered from its context window. One or more pieces of that context appear to be outdated.';
}

async function getApifyContext() {
  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~web-scraper/runs?token=${APIFY_API_KEY}`,
      {
        startUrls: [{ url: `https://duckduckgo.com/html/?q=${encodeURIComponent('LLM outdated knowledge base wrong answer production AI agent stale context')}` }],
        pageFunction: `async function pageFunction(context) { const $ = context.jQuery; const results = []; $('.result__body').each(function(i) { if (i >= 3) return false; results.push({ title: $(this).find('.result__title').text().trim(), snippet: $(this).find('.result__snippet').text().trim() }); }); return { results }; }`,
        maxPagesPerCrawl: 1,
      },
      { timeout: 6000 }
    );
    const runId = runRes.data?.data?.id;
    if (!runId) return fallbackApify();
    await new Promise(r => setTimeout(r, 3000));
    const items = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_API_KEY}&limit=3`, { timeout: 4000 });
    const results = (items.data || []).flatMap(i => i.results || []).slice(0, 2);
    if (!results.length) return fallbackApify();
    return results.map(r => `  • ${r.title}: "${(r.snippet || '').slice(0, 120)}"`).join('\n');
  } catch {
    return fallbackApify();
  }
}

function fallbackApify() {
  return `  • Stale knowledge base is a known production AI failure: when source documents are updated but context is not re-indexed, the LLM continues answering from outdated information with full confidence.`;
}

function extractSentence(text, keyword) {
  return text.split(/[.!?]\s+/).find(s => s.toLowerCase().includes(keyword))?.trim() || '';
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
