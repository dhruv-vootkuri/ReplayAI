/**
 * agent-trace-replay — OpenClaw Skill HTTP Server
 *
 * OpenClaw calls this server when any of the four tools are invoked.
 * POST /invoke   { tool: string, input: object }
 * POST /tools/:tool  { input: object }   (alternate routing)
 * GET  /health
 * GET  /skill.json   (serves the skill manifest)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { showTrace } from './tools/show-trace.js';
import { diagnose } from './tools/diagnose.js';
import { replay } from './tools/replay.js';
import { compare } from './tools/compare.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

const PORT = process.env.SKILL_PORT || 3003;

// ─── Tool registry ────────────────────────────────────────────────────────────

const TOOLS: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
  'show-trace': (i) => showTrace(i as unknown as Parameters<typeof showTrace>[0]),
  'diagnose':   (i) => diagnose(i as unknown as Parameters<typeof diagnose>[0]),
  'replay':     (i) => replay(i as unknown as Parameters<typeof replay>[0]),
  'compare':    (i) => compare(i as unknown as Parameters<typeof compare>[0]),
};

async function invokeTool(tool: string, input: Record<string, unknown>): Promise<{ output: string; success: boolean }> {
  const handler = TOOLS[tool];
  if (!handler) {
    return {
      output: `Unknown tool: "${tool}". Available: ${Object.keys(TOOLS).join(', ')}`,
      success: false,
    };
  }
  try {
    const output = await handler(input);
    return { output, success: !output.startsWith('❌') };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown error';
    return { output: `❌ ${tool} failed: ${msg}`, success: false };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Primary OpenClaw invoke endpoint
app.post('/invoke', async (req, res) => {
  const { tool, input } = req.body ?? {};
  if (!tool) return res.status(400).json({ error: 'tool is required' });
  const result = await invokeTool(tool, input ?? {});
  res.json(result);
});

// Alternate: POST /tools/:tool
app.post('/tools/:tool', async (req, res) => {
  const { tool } = req.params;
  const input = req.body?.input ?? req.body ?? {};
  const result = await invokeTool(tool, input);
  res.json(result);
});

// OpenClaw may also call individual tool endpoints at the top level
app.post('/show-trace', async (req, res) => {
  const result = await invokeTool('show-trace', req.body?.input ?? req.body ?? {});
  res.json(result);
});
app.post('/diagnose', async (req, res) => {
  const result = await invokeTool('diagnose', req.body?.input ?? req.body ?? {});
  res.json(result);
});
app.post('/replay', async (req, res) => {
  const result = await invokeTool('replay', req.body?.input ?? req.body ?? {});
  res.json(result);
});
app.post('/compare', async (req, res) => {
  const result = await invokeTool('compare', req.body?.input ?? req.body ?? {});
  res.json(result);
});

// Serve skill manifest
app.get('/skill.json', (_req, res) => {
  res.sendFile(path.resolve('./skill.json'));
});

// Health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    skill: 'agent-trace-replay',
    tools: Object.keys(TOOLS),
    port: PORT,
    redis: !!process.env.REDIS_URL,
    friendli: !!process.env.FRIENDLI_API_KEY,
    contextual: !!process.env.CONTEXTUAL_AI_KEY,
    apify: !!process.env.APIFY_API_KEY,
    civic: !!process.env.CIVIC_API_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`[ReplayAI Skill] Running on http://localhost:${PORT}`);
  console.log(`[ReplayAI Skill] Endpoints: POST /invoke, POST /tools/:tool, GET /health`);
  console.log(`[OpenClaw] Point your skill URL to: http://localhost:${PORT}`);
});

export default app;
