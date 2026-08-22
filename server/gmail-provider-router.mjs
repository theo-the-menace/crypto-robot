// Local copy of the custom-api-gateway "overseas" chain.
const routes = [{ protocol: 'openai', base: 'DEEPSEEK_VIP_BASE_URL', key: 'DEEPSEEK_VIP_API_KEY', models: 'OPENAI_PRIMARY_MODELS' }];
const value = (name) => process.env[name] || '';
const modelList = (name) => value(name).split(',').map((item) => item.trim()).filter(Boolean);
async function callGemini(route, model, key, content, timeoutMs) {
  const parts = Array.isArray(content) ? content.map((item) => item.type === 'text' ? { text: item.text } : { inlineData: { mimeType: item.image_url.url.match(/^data:([^;]+)/)?.[1] || 'image/jpeg', data: item.image_url.url.split(',')[1] } }) : [{ text: content }];
  const url = `${value(route.base).replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error?.message || `Gemini failed (${response.status})`); return body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}
async function callOpenAi(route, model, key, content, timeoutMs) {
  const response = await fetch(`${value(route.base).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error?.message || `Provider failed (${response.status})`); return body.choices?.[0]?.message?.content || '';
}
export async function completeWithOverseasStrategy({ content }) {
  const errors = []; const perRouteMs = Math.max(1_000, Number(process.env.PROVIDER_TIMEOUT_MS || 120_000)); const chainMs = Math.max(perRouteMs, Number(process.env.PROVIDER_CHAIN_TIMEOUT_MS || 180_000)); const deadline = Date.now() + chainMs;
  for (const route of routes) {
    const base = value(route.base); const key = value(route.key); const model = modelList(route.models)[0];
    if (!base || !key || !model) continue;
    const remaining = deadline - Date.now(); if (remaining <= 0) break;
    try { return route.protocol === 'gemini-native' ? await callGemini(route, model, key, content, Math.min(perRouteMs, remaining)) : await callOpenAi(route, model, key, content, Math.min(perRouteMs, remaining)); }
    catch (error) { errors.push(`${route.base}: ${error instanceof Error ? error.message : 'failed'}`); }
  }
  throw new Error(`No overseas provider succeeded. ${errors.join('; ')}`);
}
