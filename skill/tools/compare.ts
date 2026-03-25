import { getTrace, resolveRunId } from '../utils/redis.js';

export interface CompareInput {
  query: string;
}

export async function compare(input: CompareInput): Promise<string> {
  const { query } = input;
  if (!query?.trim()) return '❌ Describe which trace to compare or provide a run_id.';

  const run_id = await resolveRunId(query);
  if (!run_id) return `❌ No trace found matching "${query}".`;

  const trace = await getTrace(run_id);
  if (!trace) return `❌ Trace ${run_id} not found or expired.`;
  if (!trace.replay) return `❌ No replay found for ${run_id}.\n\nRun "replay" first, then compare.`;

  const r = trace.replay;
  const { find, replace } = r.parsed_change;

  let out = `📊 Comparison: ${run_id}\n`;
  out += `Guest asked: "${trace.user_query}"\n`;
  out += `Original: ${trace.duration_ms}ms  |  Replay: ${r.duration_ms}ms\n\n`;
  out += `${'─'.repeat(56)}\n\n`;

  out += `Context change:\n`;
  out += `  Before: "${find}"\n`;
  out += `  After:  "${replace}"\n\n`;

  out += `Original response:\n"${trace.response}"\n\n`;
  out += `Replayed response:\n"${r.response}"\n\n`;

  out += `${'─'.repeat(56)}\n`;

  // Simple assessment: did the answer change meaningfully?
  const origMentionsOld = trace.response.toLowerCase().includes(find.toLowerCase().split(' ')[0]);
  const replayMentionsNew = r.response.toLowerCase().includes(replace.toLowerCase().split(' ')[0]);

  if (origMentionsOld && replayMentionsNew) {
    out += `✅ The guest would have received a different, corrected answer.`;
  } else if (trace.response === r.response) {
    out += `⚠️  The response did not change — the context update may not have affected this query.`;
  } else {
    out += `✅ The response changed after applying the knowledge base update.`;
  }

  out += `\n\n🔐 Replay authorized by: ${r.civic_user}`;
  out += `\nChange applied: "${find}" → "${replace}"`;

  return out;
}
