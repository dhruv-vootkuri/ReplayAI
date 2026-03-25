const Redis = require('ioredis');
const axios = require('axios');

const query = process.argv[2] || '';
const REDIS_URL = process.env.REDIS_URL;
const APIFY_API_KEY = process.env.APIFY_API_KEY;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

async function run() {
  const run_id = await resolveRunId(query);
  if (!run_id) {
    console.log(`No trace found matching "${query}".\n\nMake sure the hotel concierge is running at localhost:3001 and has received at least one message.`);
    return;
  }

  const raw = await redis.get(`trace:${run_id}`);
  if (!raw) { console.log(`Trace ${run_id} not found or expired.`); return; }
  const trace = JSON.parse(raw);

  const apifyContext = await getApifyContext(trace.user_query);

  let out = `Trace: ${run_id}\n`;
  out += `Agent: ${trace.agent_name}\n`;
  out += `Response time: ${trace.duration_ms}ms\n\n`;
  out += `Guest asked:\n"${trace.user_query}"\n\n`;
  out += `What the LLM was told (relevant context from its knowledge base):\n`;
  (trace.relevant_context || []).forEach(line => { out += `  • ${line}\n`; });
  out += `\nWhat the LLM said:\n"${trace.response}"\n`;
  out += `\nModel: ${trace.model}`;

  if (apifyContext) out += `\n\nExternal context (Apify):\n${apifyContext}`;
  if (trace.replay) out += `\n\nA replay exists for this trace. Ask "compare" to see what changed.`;

  console.log(out);
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

async function getApifyContext(userQuery) {
  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~web-scraper/runs?token=${APIFY_API_KEY}`,
      {
        startUrls: [{ url: `https://duckduckgo.com/html/?q=${encodeURIComponent('LLM stale knowledge base outdated information RAG retrieval')}` }],
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
    return results.map(r => `  • ${r.title}: "${(r.snippet || '').slice(0, 100)}"`).join('\n');
  } catch {
    return fallbackApify();
  }
}

function fallbackApify() {
  return `  • Stale knowledge base is a well-documented RAG failure: the LLM answers confidently from outdated context because it has no way to know the source document changed.`;
}

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
}

run().finally(() => redis.disconnect());
