// Local copy of the custom-api-gateway "overseas" chain.
const routes = [
  { protocol: 'gemini-native', base: 'GOOGLE_AI_API_BASE_URL', key: 'GOOGLE_AI_STUDIO_PRIMARY_KEY', models: 'GEMINI_ACCOUNT_MODELS' },
  { protocol: 'gemini-native', base: 'GOOGLE_AI_API_BASE_URL', key: 'GOOGLE_AI_STUDIO_SECONDARY_KEY', models: 'GEMINI_ACCOUNT_MODELS' },
  { protocol: 'openai', base: 'OPENAI_PRIMARY_BASE_URL', key: 'OPENAI_PRIMARY_API_KEY', models: 'OPENAI_PRIMARY_MODELS' },
  { protocol: 'openai', base: 'GEMINI_SUB2_BASE_URL', key: 'GEMINI_SUB2_API_KEY', models: 'GEMINI_SUB2_MODELS' },
  { protocol: 'openai', base: 'OPENAI_BRIDGE_BASE_URL', key: 'OPENAI_BRIDGE_API_KEY', models: 'OPENAI_BRIDGE_MODELS' },
  { protocol: 'openai', base: 'GEMINI_BRIDGE_BASE_URL', key: 'GEMINI_BRIDGE_API_KEY', models: 'GEMINI_BRIDGE_MODELS' },
];
const value = (name) => process.env[name] || '';
const modelList = (name) => value(name).split(',').map((item) => item.trim()).filter(Boolean);
async function callGemini(route, model, key, content) {
  const parts = Array.isArray(content) ? content.map((item) => item.type === 'text' ? { text: item.text } : { inlineData: { mimeType: item.image_url.url.match(/^data:([^;]+)/)?.[1] || 'image/jpeg', data: item.image_url.url.split(',')[1] } }) : [{ text: content }];
  const response = await fetch(`${value(route.base).replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0 } }), signal: AbortSignal.timeout(Number(process.env.PROVIDER_TIMEOUT_MS || 45_000) });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error?.message || `Gemini failed (${response.status})`); return body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}
async function callOpenAi(route, model, key, content) {
  const response = await fetch(`${value(route.base).replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0 }), signal: AbortSignal.timeout(Number(process.env.PROVIDER_TIMEOUT_MS || 45_000) });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error?.message || `Provider failed (${response.status})`); return body.choices?.[0]?.message?.content || '';
}
export async function completeWithOverseasStrategy({ content }) {
  const errors = [];
  for (const route of routes) { const base = value(route.base); const key = value(route.key); const model = modelList(route.models)[0]; if (!base || !key || !model) continue; try { return route.protocol === 'gemini-native' ? await callGemini(route, model, key, content) : await callOpenAi(route, model, key, content); } catch (error) { errors.push(`${route.base}: ${error instanceof Error ? error.message : 'failed'}`); } }
  throw new Error(`No overseas provider succeeded. ${errors.join('; ')}`);
}
