import { getTrace, resolveRunId } from '../utils/redis.js';
import { analyzeTraceWithContextualAI } from '../utils/contextual.js';
import { enrichFailureContext } from '../utils/apify.js';
function verifyCivic() {
    const key = process.env.CIVIC_API_KEY;
    if (!key)
        return { ok: false, user_id: '', note: 'CIVIC_API_KEY not set — cannot authorize trace inspection' };
    return { ok: true, user_id: `civic_${key.slice(0, 8)}`, note: `Identity verified via Civic (${key.slice(0, 8)}…)` };
}
export async function diagnose(input) {
    const { query } = input;
    if (!query?.trim())
        return '❌ Describe the issue or provide a run_id.';
    const civic = verifyCivic();
    if (!civic.ok)
        return `🔐 Access denied: ${civic.note}`;
    const run_id = await resolveRunId(query);
    if (!run_id)
        return `❌ No trace found matching "${query}".`;
    const trace = await getTrace(run_id);
    if (!trace)
        return `❌ Trace ${run_id} not found or expired.`;
    // Contextual AI ingests the full trace — context + response — and returns a grounded explanation
    const diagnosis = await analyzeTraceWithContextualAI(trace);
    // Apify scrapes external context about why this kind of failure happens
    const apify = await enrichFailureContext('hotel knowledge base', 'LLM answered using outdated information from its context', trace.user_query);
    let out = `🔍 Diagnosis: ${run_id}\n`;
    out += `🔐 ${civic.note}\n\n`;
    out += `Guest asked: "${trace.user_query}"\n\n`;
    out += `Root cause:\n${diagnosis.root_cause}\n\n`;
    out += `Full explanation:\n${diagnosis.explanation}\n\n`;
    out += `External context (Apify):\n${apify.summary}\n`;
    apify.sources.slice(0, 2).forEach(s => {
        out += `  • ${s.title}: "${s.snippet.slice(0, 120)}"\n`;
    });
    out += `\nRecommended fix:\n${diagnosis.recommendation}\n\n`;
    out += `💡 Ask "replay" to re-run this with a corrected knowledge base.`;
    if (diagnosis.mock)
        out += '\n\n_(Contextual AI key not configured — analysis is simulated)_';
    return out;
}
