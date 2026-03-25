import axios from 'axios';
const FRIENDLI_BASE = 'https://inference.friendli.ai/v1';
const DEFAULT_MODEL = 'meta-llama-3.1-8b-instruct';
export async function callFriendliAI(userPrompt, systemPrompt = 'You are a helpful assistant.', model = DEFAULT_MODEL) {
    const start = Date.now();
    const apiKey = process.env.FRIENDLI_API_KEY;
    if (!apiKey) {
        return { content: mockResponse(userPrompt), duration_ms: Date.now() - start + 120, model, mock: true };
    }
    try {
        const res = await axios.post(`${FRIENDLI_BASE}/chat/completions`, {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 1024,
            temperature: 0.2,
        }, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 20000,
        });
        return {
            content: res.data.choices[0].message.content,
            duration_ms: Date.now() - start,
            model,
        };
    }
    catch (err) {
        console.warn('[FriendliAI] error:', err.message);
        return { content: mockResponse(userPrompt), duration_ms: Date.now() - start + 80, model, mock: true };
    }
}
export async function parseReplayChange(change) {
    const { content, duration_ms } = await callFriendliAI(`Parse this trace replay instruction into a structured JSON edit. The trace has these step types: step 1=intent classification (FriendliAI), step 2=policy retrieval (ContextualAI), step 3=response generation (FriendliAI), step 4=session cache (Redis).

Instruction: "${change}"

Return only valid JSON with: step_to_fix (integer), field (string), new_value (string).
Example: {"step_to_fix": 2, "field": "document_version", "new_value": "2024"}`, 'You are a JSON parser. Return only valid JSON, no explanation or markdown.');
    try {
        const match = content.match(/\{[\s\S]*?\}/);
        return { ...JSON.parse(match?.[0] ?? content), duration_ms };
    }
    catch {
        // Infer from change text
        const step = change.includes('policy') || change.includes('document') || change.includes('retriev') ? 2 : 3;
        return { step_to_fix: step, field: 'document_version', new_value: '2024', duration_ms };
    }
}
function mockResponse(prompt) {
    const p = prompt.toLowerCase();
    if (p.includes('parse') && p.includes('step')) {
        return '{"step_to_fix": 2, "field": "document_version", "new_value": "2024"}';
    }
    if (p.includes('intent') || p.includes('classify')) {
        return '{"intent": "cancellation_inquiry", "entities": ["cancellation", "refund"], "requires_policy": true}';
    }
    if (p.includes('concierge') || p.includes('hotel') || p.includes('guest')) {
        return 'Thank you for contacting The Grand Hotel. Based on our current cancellation policy, you may cancel your reservation free of charge up to 24 hours before check-in. We would be happy to process that for you — could you please provide your booking reference number?';
    }
    return 'I understand your request. Let me look into that for you.';
}
export function estimateCost(llmStepCount, totalSteps) {
    const cost = llmStepCount * 0.0003 + totalSteps * 0.00005;
    return `$${cost.toFixed(4)}`;
}
