import { Redis } from 'ioredis';
export const TRACE_TTL = 86400;
let client = null;
export function getRedis() {
    if (!client) {
        const url = process.env.REDIS_URL || 'redis://localhost:6379';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client = new Redis(url, {
            retryStrategy: (t) => Math.min(t * 150, 3000),
            maxRetriesPerRequest: 2,
        });
        client.on('error', (err) => console.error('[Redis]', err.message));
    }
    return client;
}
export async function getTrace(run_id) {
    const redis = getRedis();
    const raw = await redis.get(`trace:${run_id}`);
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export async function saveTrace(run_id, trace) {
    const redis = getRedis();
    await redis.set(`trace:${run_id}`, JSON.stringify(trace), 'EX', TRACE_TTL);
}
// Natural language search through the trace index
export async function searchTraces(queryText) {
    const redis = getRedis();
    let rawEntries = [];
    try {
        rawEntries = await redis.lrange('traces:index', 0, 499);
    }
    catch {
        return [];
    }
    const entries = rawEntries
        .map(e => { try {
        return JSON.parse(e);
    }
    catch {
        return null;
    } })
        .filter((e) => e !== null);
    if (!entries.length)
        return [];
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
export async function getLatestTrace() {
    const redis = getRedis();
    try {
        const raw = await redis.lindex('traces:index', 0);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
}
export async function resolveRunId(query) {
    if (/^run_[a-z0-9]+$/i.test(query.trim()))
        return query.trim();
    const matches = await searchTraces(query);
    if (matches.length)
        return matches[0].run_id;
    const latest = await getLatestTrace();
    return latest?.run_id ?? null;
}
function tokenize(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
}
