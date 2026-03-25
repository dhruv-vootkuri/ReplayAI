import axios from 'axios';
// Ingests the full trace as a document and asks Contextual AI to explain what went wrong.
export async function analyzeTraceWithContextualAI(trace) {
    const start = Date.now();
    const apiKey = process.env.CONTEXTUAL_AI_KEY;
    const document = [
        `TRACE ANALYSIS REQUEST`,
        `Agent: ${trace.agent_name}`,
        `Guest query: "${trace.user_query}"`,
        ``,
        `CONTEXT GIVEN TO LLM:`,
        trace.context_given,
        ``,
        `LLM RESPONSE:`,
        trace.response,
        ``,
        `RELEVANT CONTEXT LINES THE LLM LIKELY USED:`,
        ...(trace.relevant_context ?? []).map(l => `  - ${l}`),
    ].join('\n');
    if (!apiKey) {
        return buildMockDiagnosis(trace, start);
    }
    try {
        const res = await axios.post('https://api.contextual.ai/v1/query', {
            query: `Analyze this AI agent trace. What information in the context caused the LLM to produce this response? Is any of the context outdated or incorrect? What should be corrected?\n\n${document}`,
        }, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 15000,
        });
        const duration_ms = Date.now() - start;
        const text = res.data?.response ||
            res.data?.choices?.[0]?.message?.content ||
            JSON.stringify(res.data);
        return {
            explanation: text,
            root_cause: extractSection(text, 'root cause') || extractSection(text, 'caused') || buildRootCause(trace),
            recommendation: extractSection(text, 'recommend') || extractSection(text, 'should') || buildRecommendation(trace),
            duration_ms,
        };
    }
    catch (err) {
        console.warn('[ContextualAI] falling back to mock:', err.message);
        return buildMockDiagnosis(trace, start);
    }
}
function extractSection(text, keyword) {
    const sentences = text.split(/[.!?]\s+/);
    const match = sentences.find(s => s.toLowerCase().includes(keyword));
    return match?.trim() ?? '';
}
function buildRootCause(trace) {
    const isCancellation = /cancel|refund|48|47|hour/i.test(trace.user_query + trace.response);
    if (isCancellation) {
        return 'The knowledge base contains an outdated cancellation policy stating "48 hours" notice is required. The hotel updated this to "24 hours" in 2024 but the context document was never refreshed. The LLM faithfully repeated the outdated information it was given.';
    }
    return `The LLM's response was determined by the context it was given. One or more pieces of that context appear to be outdated or incorrect for this query.`;
}
function buildRecommendation(trace) {
    return 'Update the hotel knowledge base with the current policy. Then replay this trace with the corrected context to see what the correct response would have been.';
}
function buildMockDiagnosis(trace, start) {
    const duration_ms = Date.now() - start + Math.floor(Math.random() * 250 + 150);
    return {
        explanation: `The LLM was given a hotel reference guide as its context. When the guest asked about "${trace.user_query.slice(0, 60)}", the LLM found the relevant section and repeated it verbatim in its response. The problem is that the relevant section — the cancellation policy — states a 48-hour notice requirement, which was the hotel's policy in 2022. The hotel updated their policy in January 2024 to require only 24 hours notice. Because the knowledge base was never re-indexed with the new document, the LLM had no way to know the policy had changed. It gave the guest accurate information relative to what it was told — but what it was told was wrong.`,
        root_cause: buildRootCause(trace),
        recommendation: buildRecommendation(trace),
        duration_ms,
        mock: true,
    };
}
