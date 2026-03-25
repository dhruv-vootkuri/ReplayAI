const Redis = require('ioredis');

const query = process.argv[2] || '';
const REDIS_URL = process.env.REDIS_URL;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

async function run() {
  const run_id = await resolveRunId(query);
  if (!run_id) { console.log(`No trace found matching "${query}".`); return; }

  const raw = await redis.get(`trace:${run_id}`);
  if (!raw) { console.log(`Trace ${run_id} not found.`); return; }
  const trace = JSON.parse(raw);

  if (!trace.replay) {
    console.log(`No replay found for ${run_id}.\n\nAsk to replay this trace first, then compare.`);
    return;
  }

  const r = trace.replay;
  const { find, replace } = r.parsed_change;

  let out = `Comparison: ${run_id}\n`;
  out += `Guest asked: "${trace.user_query}"\n`;
  out += `Original: ${trace.duration_ms}ms  |  Replay: ${r.duration_ms}ms\n\n`;
  out += `─────────────────────────────────────────────────\n\n`;
  out += `Knowledge base change:\n`;
  out += `  Before: "${find}"\n`;
  out += `  After:  "${replace}"\n\n`;
  out += `Original response:\n"${trace.response}"\n\n`;
  out += `What it would have said:\n"${r.response}"\n\n`;
  out += `─────────────────────────────────────────────────\n`;
  out += trace.response !== r.response
    ? `The guest would have received a different, corrected answer.`
    : `The response did not change — this query may not be affected by that context change.`;
  out += `\n\nReplay authorized by: ${r.civic_user}`;

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

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
}

run().finally(() => redis.disconnect());
