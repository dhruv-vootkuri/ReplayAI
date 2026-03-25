import { Redis } from 'ioredis';

export const TRACE_TTL = 86400;

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client = new (Redis as any)(url, {
      retryStrategy: (t: number) => Math.min(t * 150, 3000),
      maxRetriesPerRequest: 2,
    }) as Redis;
    client.on('error', (err: Error) => console.error('[Redis]', err.message));
  }
  return client;
}

export interface Trace {
  run_id: string;
  start_time: string;
  end_time: string;
  agent_name: string;
  user_query: string;
  context_given: string;
  response: string;
  duration_ms: number;
  model: string;
  relevant_context: string[];
  // Set after a replay
  replay?: ReplayTrace;
}

export interface ReplayTrace {
  replayed_at: string;
  change_instruction: string;
  parsed_change: { find: string; replace: string };
  context_given: string;
  response: string;
  duration_ms: number;
  civic_user: string;
}

export interface IndexEntry {
  run_id: string;
  timestamp: string;
  user_query: string;
  keywords: string[];
}

export async function getTrace(run_id: string): Promise<Trace | null> {
  const redis = getRedis();
  const raw = await redis.get(`trace:${run_id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as Trace; } catch { return null; }
}

export async function saveTrace(run_id: string, trace: Trace): Promise<void> {
  const redis = getRedis();
  await redis.set(`trace:${run_id}`, JSON.stringify(trace), 'EX', TRACE_TTL);
}

// Natural language search through the trace index
export async function searchTraces(queryText: string): Promise<IndexEntry[]> {
  const redis = getRedis();
  let rawEntries: string[] = [];
  try {
    rawEntries = await redis.lrange('traces:index', 0, 499);
  } catch { return []; }

  const entries = rawEntries
    .map(e => { try { return JSON.parse(e) as IndexEntry; } catch { return null; } })
    .filter((e): e is IndexEntry => e !== null);

  if (!entries.length) return [];

  const qwords = tokenize(queryText);
  const scored = entries.map(entry => {
    const ewords = [...entry.keywords, ...tokenize(entry.user_query)];
    const hits = qwords.filter(w => ewords.some(e => e.includes(w) || w.includes(e))).length;
    return { entry, hits };
  });

  return scored
    .filter(s => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || new Date(b.entry.timestamp).getTime() - new Date(a.entry.timestamp).getTime())
    .map(s => s.entry);
}

export async function getLatestTrace(): Promise<IndexEntry | null> {
  const redis = getRedis();
  try {
    const raw = await redis.lindex('traces:index', 0);
    return raw ? JSON.parse(raw) as IndexEntry : null;
  } catch { return null; }
}

export async function resolveRunId(query: string): Promise<string | null> {
  if (/^run_[a-z0-9]+$/i.test(query.trim())) return query.trim();
  const matches = await searchTraces(query);
  if (matches.length) return matches[0].run_id;
  const latest = await getLatestTrace();
  return latest?.run_id ?? null;
}

function tokenize(text: string): string[] {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
}
