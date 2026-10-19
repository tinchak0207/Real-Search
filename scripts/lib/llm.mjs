// Minimal OpenAI-compatible chat helper. No SDK, no dependencies.
// Configure with LLM_BASE_URL / LLM_MODEL / LLM_API_KEY.

export function loadEnv(path = '.env') {
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path);
  } catch {
    // .env is optional; users may export variables instead.
  }
}

export function llmConfig() {
  return {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    apiKey: process.env.LLM_API_KEY || '',
  };
}

export function llmConfigured() {
  return Boolean(llmConfig().apiKey);
}

export async function chat(messages, { maxTokens = 3200, temperature = 0.3 } = {}) {
  const { baseUrl, model, apiKey } = llmConfig();
  if (!apiKey) throw new Error('llm_unconfigured: set LLM_API_KEY');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(150000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`llm_http_${response.status}: ${String(body).slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`llm_bad_response: ${String(body).slice(0, 200)}`);
  }
  const message = payload?.choices?.[0]?.message ?? {};
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const finish = payload?.choices?.[0]?.finish_reason ?? null;
  if (!content) {
    throw new Error(
      `llm_empty_content(finish=${finish},reasoning=${(message.reasoning_content || '').length})`,
    );
  }
  return { content, model: payload?.model ?? model, usage: payload?.usage ?? null, finish };
}

export function parseJsonLoose(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

export function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!text || text.length > maxLength) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}
