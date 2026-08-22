import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const root = resolve(process.cwd(), 'data', 'gmail');
const tokenFile = resolve(root, 'token.json');
const stateFile = resolve(root, 'state.json');
const messagesFile = resolve(root, 'messages.json');
const config = {
  clientId: process.env.GMAIL_CLIENT_ID || '',
  clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
  redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://127.0.0.1:8889/api/gmail/oauth/callback',
  user: process.env.GMAIL_USER || 'me',
  topicName: process.env.GMAIL_PUBSUB_TOPIC || '',
  pushToken: process.env.GMAIL_PUBSUB_TOKEN || '',
};
const oauthStates = new Set();
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
let messageHandler = null;

const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const writeJson = async (file, value) => { await mkdir(root, { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 }); };
const auth = (token) => ({ Authorization: `Bearer ${token}` });
function configured() { return Boolean(config.clientId && config.clientSecret && config.topicName); }
function decodeBase64Url(value) { return Buffer.from(String(value || '').replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'); }
function sameSecret(actual, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(actual || '')); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function accessToken() {
  const token = await readJson(tokenFile, null);
  if (!token?.refresh_token) throw new Error('Gmail OAuth is not authorized. Open /api/gmail/oauth/start first.');
  if (token.access_token && Number(token.expires_at || 0) > Date.now() + 60_000) return token.access_token;
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || `Gmail token refresh failed (${response.status}).`);
  await writeJson(tokenFile, { ...token, ...body, expires_at: Date.now() + Number(body.expires_in || 3600) * 1000 });
  return body.access_token;
}
async function gmail(path, options = {}) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(config.user)}${path}`, { ...options, headers: { ...auth(await accessToken()), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Gmail API failed (${response.status}).`);
  return body;
}
export function gmailOAuthStart() {
  if (!configured()) throw new Error('Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_PUBSUB_TOPIC first.');
  const state = randomBytes(24).toString('hex'); oauthStates.add(state);
  const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope, state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}
export async function gmailOAuthCallback({ code, state }) {
  if (!oauthStates.delete(state)) throw new Error('Invalid or expired OAuth state.');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || `Gmail OAuth failed (${response.status}).`);
  await writeJson(tokenFile, { ...body, expires_at: Date.now() + Number(body.expires_in || 3600) * 1000 });
  await syncGmailHistory();
  return renewGmailWatch();
}
export async function renewGmailWatch() {
  const result = await gmail('/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicName: config.topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }) });
  await writeJson(stateFile, { historyId: result.historyId, expiration: result.expiration, updatedAt: Date.now() });
  return result;
}
function parseMessage(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  const data = message.payload?.body?.data || message.payload?.parts?.find((part) => part.mimeType === 'text/plain')?.body?.data || '';
  return { id: message.id, threadId: message.threadId, internalDate: message.internalDate, labelIds: message.labelIds, from: headers.from || '', to: headers.to || '', subject: headers.subject || '', text: decodeBase64Url(data) };
}
export async function handleGmailPush(payload) {
  const data = JSON.parse(decodeBase64Url(payload?.message?.data || ''));
  const state = await readJson(stateFile, {}); const start = state.historyId || data.historyId;
  const history = await gmail(`/history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded`);
  const ids = [...new Set((history.history || []).flatMap((item) => (item.messagesAdded || []).map((entry) => entry.message?.id)).filter(Boolean))];
  const messages = (await Promise.all(ids.map((id) => gmail(`/messages/${encodeURIComponent(id)}?format=full`)))).map(parseMessage);
  const existing = await readJson(messagesFile, []); const known = new Set(existing.map((item) => item.id));
  await writeJson(messagesFile, [...existing, ...messages.filter((item) => !known.has(item.id))].slice(-1000));
  for (const message of messages.filter((item) => !known.has(item.id))) await messageHandler?.(message);
  await writeJson(stateFile, { ...state, historyId: history.historyId || data.historyId, lastPushAt: Date.now() });
  return { received: messages.length, historyId: history.historyId || data.historyId };
}
export async function syncGmailHistory() {
  const result = await gmail('/messages?q=from:(cmegroup.com)&maxResults=100');
  const ids = (result.messages || []).map((item) => item.id);
  const messages = (await Promise.all(ids.map((id) => gmail(`/messages/${encodeURIComponent(id)}?format=full`)))).map(parseMessage);
  const existing = await readJson(messagesFile, []); const known = new Set(existing.map((item) => item.id));
  await writeJson(messagesFile, [...existing, ...messages.filter((item) => !known.has(item.id))].slice(-1000));
  for (const message of messages.filter((item) => !known.has(item.id))) await messageHandler?.(message);
  return { fetched: messages.length };
}
export function setGmailMessageHandler(handler) { messageHandler = handler; }
export function checkGmailPushToken(value) { return Boolean(config.pushToken) && sameSecret(value, config.pushToken); }
export async function gmailStatus() { return { configured: configured(), authorized: Boolean((await readJson(tokenFile, null))?.refresh_token), watch: await readJson(stateFile, null) }; }
