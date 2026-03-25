require('dotenv').config({ path: '../.env' });
const express = require('express');
const Redis = require('ioredis');
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.WEBAPP_PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL;

const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 2000),
  maxRetriesPerRequest: 2,
});
redis.on('error', (err) => console.error('[Redis] error:', err.message));

// ─── GET /trace/:run_id ─────────────────────────────────────────────────────
// Returns full trace data (steps + metadata + replay) for the webapp

app.get('/trace/:run_id', async (req, res) => {
  const { run_id } = req.params;
  try {
    // Fetch steps
    const stepKeys = await redis.keys(`trace:${run_id}:step:*`);
    const replayKeys = await redis.keys(`trace:${run_id}:replay:step:*`);
    const metaRaw = await redis.get(`trace:${run_id}:metadata`);

    const fetchAll = async (keys) => {
      if (!keys.length) return [];
      const pipe = redis.pipeline();
      keys.forEach((k) => pipe.get(k));
      const results = await pipe.exec();
      return results
        .filter(([err, val]) => !err && val)
        .map(([, val]) => { try { return JSON.parse(val); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => a.step_number - b.step_number);
    };

    const [steps, replaySteps] = await Promise.all([fetchAll(stepKeys), fetchAll(replayKeys)]);
    const metadata = metaRaw ? JSON.parse(metaRaw) : null;

    if (!steps.length && !metadata) {
      return res.status(404).json({ error: `No trace found for run_id: ${run_id}` });
    }

    res.json({ run_id, steps, replay_steps: replaySteps, metadata, has_replay: replaySteps.length > 0 });
  } catch (err) {
    console.error('[/trace] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /latest ─────────────────────────────────────────────────────────────
// Returns the most recently created trace run_id

app.get('/latest', async (req, res) => {
  try {
    const keys = await redis.keys('trace:*:metadata');
    if (!keys.length) return res.json({ run_id: null });

    const pipe = redis.pipeline();
    keys.forEach((k) => pipe.get(k));
    const results = await pipe.exec();
    const metas = results
      .filter(([e, v]) => !e && v)
      .map(([, v]) => { try { return JSON.parse(v); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    res.json({ run_id: metas[0]?.run_id ?? null, metadata: metas[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /openclaw ───────────────────────────────────────────────────────────
// Proxies a natural language command to the OpenClaw skill

app.post('/openclaw', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  if (!OPENCLAW_API_URL) {
    // Parse locally and route to our skill handlers
    return await handleLocalSkillCommand(message, res);
  }

  try {
    const response = await axios.post(
      OPENCLAW_API_URL,
      { message },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    res.json(response.data);
  } catch (err) {
    console.warn('[OpenClaw] API unavailable, routing locally:', err.message);
    return await handleLocalSkillCommand(message, res);
  }
});

async function handleLocalSkillCommand(message, res) {
  // Simple NL parser to route to skill tools
  const msg = message.toLowerCase();
  let tool = 'show-trace';
  const input = {};

  // Extract run_id
  const runIdMatch = message.match(/run_[a-z0-9_]+/i);
  if (runIdMatch) input.run_id = runIdMatch[0];

  if (msg.includes('diagnos') || msg.includes('what went wrong') || msg.includes('root cause')) {
    tool = 'diagnose';
  } else if (msg.includes('replay') || msg.includes('fork') || msg.includes('fix')) {
    tool = 'replay';
    const fromStepMatch = msg.match(/(?:from\s*)?step\s*(\d+)/i) || msg.match(/step[=:\s]+(\d+)/i);
    if (fromStepMatch) input.from_step = parseInt(fromStepMatch[1]);
    else input.from_step = 5; // default

    const changeMatch = message.match(/(?:change[=:\s]+|fix\s+|with\s+)(.+)/i);
    input.change = changeMatch?.[1]?.trim() ?? 'fix the retrieval to get the 2024 policy document';
  } else if (msg.includes('compar') || msg.includes('diff') || msg.includes('before.*after')) {
    tool = 'compare';
  } else if (msg.includes('show') || msg.includes('trace') || msg.includes('steps')) {
    tool = 'show-trace';
  }

  if (!input.run_id) {
    // Try to get latest run_id from Redis
    try {
      const keys = await redis.keys('trace:*:metadata');
      if (keys.length) {
        const pipe = redis.pipeline();
        keys.forEach((k) => pipe.get(k));
        const results = await pipe.exec();
        const metas = results
          .filter(([e, v]) => !e && v)
          .map(([, v]) => { try { return JSON.parse(v); } catch { return null; } })
          .filter(Boolean)
          .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
        if (metas[0]) input.run_id = metas[0].run_id;
      }
    } catch {}
  }

  if (!input.run_id) {
    return res.json({ output: '❌ No run_id found. Send a message to the support agent first, then try again.' });
  }

  // Dynamically import skill (TypeScript compiled or source)
  try {
    // Try compiled dist first
    const { handleRequest } = await import('../skill/dist/index.js').catch(() =>
      import('../skill/index.ts')
    );
    const result = await handleRequest({ tool, input });
    res.json(result);
  } catch (err) {
    console.error('[LocalSkill] error:', err.message);
    res.json({ output: `Skill routing: tool=${tool}, run_id=${input.run_id}. (Skill not compiled yet — run "cd skill && npm run build")`, tool, success: false });
  }
}

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));

app.listen(PORT, () => {
  console.log(`[Webapp Server] Running on http://localhost:${PORT}`);
  console.log(`[Webapp Server] Redis: ${REDIS_URL}`);
  console.log(`[Webapp Server] OpenClaw: ${OPENCLAW_API_URL || 'local routing'}`);
});
