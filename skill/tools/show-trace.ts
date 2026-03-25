import { getTrace, resolveRunId } from '../utils/redis.js';
import { enrichFailureContext } from '../utils/apify.js';

export interface ShowTraceInput {
  query: string;
}

export async function showTrace(input: ShowTraceInput): Promise<string> {
  const { query } = input;
  if (!query?.trim()) return '❌ Describe what happened or provide a run_id.';

  const run_id = await resolveRunId(query);
  if (!run_id) return `❌ No trace found matching "${query}".\n\nMake sure the hotel concierge at localhost:3001 has received at least one message.`;

  const trace = await getTrace(run_id);
  if (!trace) return `❌ Trace ${run_id} not found or expired.`;

  // Use Apify to pull external context that helps explain why the LLM answered this way
  const apify = await enrichFailureContext(
    'LLM knowledge base',
    'Agent responded using hotel knowledge base — checking for known issues with outdated information',
    trace.user_query
  );

  let out = `📋 Trace: ${run_id}\n`;
  out += `Agent: ${trace.agent_name}\n`;
  out += `Time: ${trace.duration_ms}ms\n\n`;

  out += `Guest asked:\n"${trace.user_query}"\n\n`;

  out += `What the LLM knew (context it was given):\n`;
  if (trace.relevant_context?.length) {
    trace.relevant_context.forEach(line => { out += `  • ${line}\n`; });
  } else {
    out += `  [Full hotel knowledge base was provided as context]\n`;
  }
  out += `\n`;

  out += `What the LLM said:\n"${trace.response}"\n\n`;

  out += `Model: ${trace.model}\n`;

  if (apify.sources?.length) {
    out += `\nExternal context (Apify):\n${apify.summary}\n`;
    apify.sources.slice(0, 2).forEach(s => {
      out += `  • ${s.title}: "${s.snippet.slice(0, 110)}"\n`;
    });
  }

  out += `\n💡 Run "diagnose" to understand exactly what went wrong, or "replay" to see what would have happened differently.`;

  if (trace.replay) {
    out += `\n\n🔁 A replay exists for this trace. Run "compare" to see what changed.`;
  }

  return out;
}
