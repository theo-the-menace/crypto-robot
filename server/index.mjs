import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BinanceApiError, createBinanceCoinMClient, createBinanceMarginClient, createBinanceSpotClient, createBinanceUsdMClient } from '../src/binance.mjs';
import { auditBinancePermissions } from '../src/permissions.mjs';
import { fallbackIntent, inferProduct, multiProductTradePrompt, normalizeOrderIntent, tradePrompt, validateOrder } from '../src/trading.mjs';
import { EmergencyPolicy } from '../src/emergency-policy.mjs';
import { analysisMessages, compactMarketContext, isTradeCommand, validImageDataUrl } from './market-context.mjs';
import { requestedOrderBookRange } from './order-book-context.mjs';
import { MarketStore } from './market-store.mjs';
import { aggregateMarketKlines, marketIntervals } from './market-aggregate.mjs';
import { checkGmailPushToken, gmailOAuthCallback, gmailOAuthStart, gmailStatus, handleGmailPush, renewGmailWatch, setGmailMessageHandler } from './gmail.mjs';
import { processGmailMessage } from './gmail-pipeline.mjs';
import { MarketMessageStore } from './market-message-store.mjs';
import { sendTelegramNews } from './telegram-notifier.mjs';
import { collectWhiteHouse } from './whitehouse-source.mjs';

const port = Number(process.env.CRYPTO_AGENT_API_PORT || 8889);
const environment = process.env.BINANCE_ENV === 'live' ? 'live' : 'testnet';
function localEnv(name) {
  try {
    const match = readFileSync(resolve(process.cwd(), '.env'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
  } catch {}
  return process.env[name];
}
const liveTradingEnabled = environment === 'live' && localEnv('BINANCE_LIVE_TRADING') === 'true';
const symbolConfig = (process.env.BINANCE_SYMBOLS || 'BTCUSDT,ETHUSDT').trim();
const allowedSymbols = symbolConfig === '*' ? null : symbolConfig.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
const maxOrderUsdt = Number(process.env.MAX_ORDER_USDT || 100);
const configured = Boolean(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY);
const gatewayProvider = 'openai';
const gatewayBaseUrl = (process.env.OPENAI_VIP_BASE_URL || '').replace(/\/$/, '');
const gatewayApiKey = process.env.OPENAI_VIP_API_KEY || '';
const marketDataBase = (process.env.MARKET_DATA_BASE_URL || gatewayBaseUrl).replace(/\/$/, '');
const marketDataKey = process.env.MARKET_DATA_API_KEY || gatewayApiKey;
const marketMessagesBase = (process.env.MARKET_MESSAGES_BASE_URL || process.env.VITE_MARKET_API_URL || '').replace(/\/$/, '');
const marketMessagesKey = process.env.MARKET_MESSAGES_API_KEY || process.env.VITE_DASHBOARD_TOKEN || '';
const marketMessagesCacheFile = resolve(process.cwd(), '.cache', 'market-messages.json');
const modelOptions = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'];
const reasoningOptions = ['low', 'medium', 'high', 'xhigh', 'max'];
const defaultModel = modelOptions.includes(process.env.OPENAI_VIP_MODEL) ? process.env.OPENAI_VIP_MODEL : 'gpt-5.6-luna';
const defaultReasoning = reasoningOptions.includes(process.env.OPENAI_VIP_REASONING_EFFORT) ? process.env.OPENAI_VIP_REASONING_EFFORT : 'medium';
const marketStore = new MarketStore({ directory: resolve(process.cwd(), 'data', 'market') });
let fundingCache = { value: null, updatedAt: 0 };
let accountContextCache = { value: null, updatedAt: 0, inflight: null };
let marketMessagesCache = { value: null, updatedAt: 0, inflight: null };
const marketStreams = new Set();
let marketReady = Promise.resolve();
const marketMessages = new MarketMessageStore();
setGmailMessageHandler(async (message) => {
  const result = await processGmailMessage(message, marketMessages);
  if (result.error) console.error('Gmail market-message processing failed', result.error);
  if (result.message) sendTelegramNews(result.message).catch((error) => console.error('Telegram news notification failed', error.message));
  return result;
});
async function handleWhiteHouseItem(item) {
  const raw = await completeWithOverseasStrategy({ content: `根据以下白宫网页原文生成加密市场分析，只返回Markdown，不要JSON。第一行是#中文标题，随后写事件概述、对BTC/ETH/稳定币的影响、政策机制、2到3个研究或对冲思路和风险提示。严格区分事实与推测。标题：${item.title}\n链接：${item.sourceUrl}\n原文：${item.content.slice(0, 30_000)}`, model: process.env.WHITEHOUSE_ANALYSIS_MODEL || 'gpt-5.6-terra' });
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || item.title;
  const message = await marketMessages.add({ source: item.source, sourceUrl: item.sourceUrl, sourceMessageId: item.id, publishedAt: item.publishedAt, impactScore: item.impactScore, title, content: raw, image: null });
  if (message) sendTelegramNews(message).catch((error) => console.error('Telegram White House notification failed', error.message));
}

function parseModelJson(value) {
  const text = String(value || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(text); } catch { return null; }
}
function createModelGateway({ baseUrl, apiKey, provider = 'openai', model, reasoningEffort }) {
  async function* stream(messages, options = {}) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: options.model || model, reasoning_effort: options.reasoningEffort || reasoningEffort, provider, stream: true, messages }),
      signal: AbortSignal.timeout(Number(process.env.PROVIDER_TIMEOUT_MS || 120_000)),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || `Model gateway failed (${response.status}).`);
    }
    if (!response.body) return;
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const body = await response.json().catch(() => ({}));
      const content = body.choices?.[0]?.message?.content || '';
      if (content) yield content;
      return;
    }
    const decoder = new TextDecoder(); let buffer = '';
    const parseLine = (line) => {
      if (!line.startsWith('data:')) return null;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return null;
      try {
        const value = JSON.parse(data);
        return value.choices?.[0]?.delta?.content || value.choices?.[0]?.message?.content || '';
      } catch { return null; }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) {
        const content = parseLine(line);
        if (content) yield content;
      }
    }
    const content = parseLine(buffer);
    if (content) yield content;
  }
  return { stream, async complete(messages, options = {}) {
    let content = '';
    for await (const chunk of stream(messages, options)) content += chunk;
    return content;
  } };
}
const binance = createBinanceSpotClient({ apiKey: process.env.BINANCE_API_KEY, secretKey: process.env.BINANCE_SECRET_KEY, environment });
const futures = createBinanceUsdMClient({ apiKey: process.env.BINANCE_API_KEY, secretKey: process.env.BINANCE_SECRET_KEY, environment });
const coinm = createBinanceCoinMClient({ apiKey: process.env.BINANCE_API_KEY, secretKey: process.env.BINANCE_SECRET_KEY, environment });
const margin = createBinanceMarginClient({ apiKey: process.env.BINANCE_API_KEY, secretKey: process.env.BINANCE_SECRET_KEY, environment });
const gateway = gatewayBaseUrl && gatewayApiKey
  ? createModelGateway({ baseUrl: gatewayBaseUrl, apiKey: gatewayApiKey, provider: gatewayProvider, model: defaultModel, reasoningEffort: defaultReasoning })
  : null;
const drafts = new Map();
const chatRequests = new Map();
const futuresDrafts = new Map();
const marginDrafts = new Map();
const marginActionDrafts = new Map();
const coinmSnapshotCache = new Map();
const coinmSnapshotInflight = new Map();
const todayFeesCache = new Map();
const symbolAllowed = (symbol) => !allowedSymbols || allowedSymbols.includes(symbol);
const emergency = new EmergencyPolicy({ budgetFraction: Number(process.env.EMERGENCY_BUDGET_FRACTION || 0.2), grantMs: Number(process.env.EMERGENCY_GRANT_MS || 30 * 60_000), cooldownMs: Number(process.env.EMERGENCY_COOLDOWN_MS || 15 * 60_000) });

function sendJson(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); }
function writeSse(response, event, value) { response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
function subscribeChatRequest(request, response, job) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  job.subscribers.add(response);
  writeSse(response, 'snapshot', { reply: job.reply, status: job.status, ...(job.result || {}) });
  if (job.status === 'completed') { writeSse(response, 'done', { reply: job.reply, ...(job.result || {}) }); response.end(); return; }
  if (job.status === 'failed') { writeSse(response, 'error', { error: job.error || 'Chat request failed.' }); response.end(); return; }
  request.on('close', () => job.subscribers.delete(response));
}
function broadcastChatRequest(job, event, value) {
  for (const response of job.subscribers) writeSse(response, event, value);
}
function finishChatRequest(job, status, value = {}) {
  job.status = status;
  Object.assign(job, value);
  broadcastChatRequest(job, status === 'completed' ? 'done' : 'error', status === 'completed' ? { reply: job.reply, ...(job.result || {}) } : { error: job.error || 'Chat request failed.' });
  for (const response of job.subscribers) response.end();
  job.subscribers.clear();
  setTimeout(() => chatRequests.delete(job.id), 10 * 60_000).unref();
}
const chartLogDirectory = resolve(process.cwd(), '.cache', 'chart-log');
const composerLogDirectory = resolve(process.cwd(), '.cache', 'composer-log');
const chatLogDirectory = resolve(process.cwd(), '.cache', 'chat-log');
async function saveChatLog(entry) {
  const today = new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  await mkdir(chatLogDirectory, { recursive: true });
  const files = await readdir(chatLogDirectory).catch(() => []);
  await Promise.all(files.filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < today).map((file) => unlink(resolve(chatLogDirectory, file)).catch(() => {})));
  await appendFile(resolve(chatLogDirectory, `${today}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
async function saveChartLogs(entries) {
  const today = new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  await mkdir(chartLogDirectory, { recursive: true });
  const files = await readdir(chartLogDirectory).catch(() => []);
  await Promise.all(files.filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < today).map((file) => unlink(resolve(chartLogDirectory, file)).catch(() => {})));
  const rows = entries.filter((entry) => entry && typeof entry === 'object').slice(-100).map((entry) => `${JSON.stringify(entry)}\n`).join('');
  if (rows) await appendFile(resolve(chartLogDirectory, `${today}.jsonl`), rows, { mode: 0o600 });
}
async function saveComposerLog(entry) {
  const today = new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  await mkdir(composerLogDirectory, { recursive: true });
  await appendFile(resolve(composerLogDirectory, `${today}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
async function readCachedMarketMessages() {
  try {
    const value = JSON.parse(await readFile(marketMessagesCacheFile, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
async function syncMarketMessages(limit = 200) {
  if (marketMessagesCache.inflight) return marketMessagesCache.inflight;
  marketMessagesCache.inflight = (async () => {
    const cached = await readCachedMarketMessages();
    let messages = cached;
    if (marketMessagesBase && marketMessagesKey) {
      try {
        const response = await fetch(`${marketMessagesBase}/api/market/messages?limit=${limit}`, { headers: { Authorization: `Bearer ${marketMessagesKey}` }, signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const remote = await response.json();
          if (Array.isArray(remote.messages)) messages = remote.messages.slice(0, limit);
        }
      } catch (error) { console.warn(JSON.stringify({ event: 'market_messages_sync_failed', error: error instanceof Error ? error.message : String(error) })); }
    } else if (!messages.length) messages = await marketMessages.list(limit);
    if (JSON.stringify(messages) !== JSON.stringify(cached)) {
      await mkdir(resolve(process.cwd(), '.cache'), { recursive: true });
      const temporary = `${marketMessagesCacheFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(messages), { mode: 0o600 });
      await rename(temporary, marketMessagesCacheFile);
    }
    marketMessagesCache.value = messages;
    marketMessagesCache.updatedAt = Date.now();
    return messages;
  })().finally(() => { marketMessagesCache.inflight = null; });
  return marketMessagesCache.inflight;
}
async function body(request, maxLength = 50_000) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > maxLength) throw new Error('Request body is too large.'); }
  return raw ? JSON.parse(raw) : {};
}
function publicError(error) {
  if (error instanceof BinanceApiError) return { status: error.status || 502, message: error.executionUnknown ? `${error.message} Order status is unknown; check Binance before retrying.` : error.message };
  return { status: 400, message: error instanceof Error ? error.message : 'Request failed.' };
}
function cleanDrafts() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, draft] of drafts) if (draft.createdAt < cutoff) drafts.delete(id);
}

async function accountSnapshot() {
  const account = await binance.account();
  return { canTrade: account.canTrade, balances: account.balances || [] };
}

async function coinMSnapshot({ symbol = 'BTCUSD_PERP', startTime, endTime, limit = 100 } = {}) {
  if (!configured) throw new BinanceApiError('Configure Binance credentials before reading COIN-M.', { status: 503 });
  const cacheKey = `${symbol}:${limit}:${startTime || ''}:${endTime || ''}`;
  const cached = coinmSnapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < 5_000) return cached.value;
  if (coinmSnapshotInflight.has(cacheKey)) return coinmSnapshotInflight.get(cacheKey);
  const range = { ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}) };
  const task = Promise.all([
    coinm.account(), coinm.positionRisk(symbol), coinm.userTrades(symbol, limit), coinm.income({ ...range, limit: Math.min(1000, limit) }), coinm.openOrders(symbol), coinm.allOrders(symbol, limit),
  ]).then(([account, positions, trades, income, openOrders, orders]) => {
    const value = { syncedAt: Date.now(), symbol, account, positions, trades, income, openOrders, orders };
    coinmSnapshotCache.set(cacheKey, { updatedAt: Date.now(), value });
    return value;
  }).finally(() => coinmSnapshotInflight.delete(cacheKey));
  coinmSnapshotInflight.set(cacheKey, task);
  return task;
}

function startOfTodayChina(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 8 * 60 * 60_000;
}

async function todayCoinMFees({ symbol = 'BTCUSD_PERP' } = {}) {
  if (!configured) throw new BinanceApiError('Configure Binance credentials before reading COIN-M fees.', { status: 503 });
  const cached = todayFeesCache.get(symbol);
  if (cached && Date.now() - cached.updatedAt < 10_000) return cached.value;
  const startTime = startOfTodayChina();
  const endTime = Date.now();
  const [income, premium] = await Promise.all([coinm.income({ symbol, startTime, endTime, limit: 1000 }), coinm.premiumIndex(symbol)]);
  const rows = (Array.isArray(income) ? income : []).filter((item) => ['REALIZED_PNL', 'COMMISSION'].includes(item.incomeType));
  const byAsset = {};
  for (const item of rows) byAsset[item.asset] = (byAsset[item.asset] || 0) + Number(item.income || 0);
  const markPrice = Number(Array.isArray(premium) ? premium[0]?.markPrice : premium?.markPrice);
  const baseAsset = symbol.replace(/USD(?:_PERP)?$/, '');
  const prices = Object.fromEntries(Object.keys(byAsset).map((asset) => [asset, asset === 'USDT' ? 1 : asset === baseAsset ? markPrice : null]));
  const totalUsdt = Object.entries(byAsset).reduce((sum, [asset, amount]) => sum + (prices[asset] == null ? 0 : amount * prices[asset]), 0);
  const value = { symbol, startTime, endTime, markPrice, income: rows, byAsset, prices, totalUsdt, unpricedAssets: Object.keys(byAsset).filter((asset) => prices[asset] == null) };
  todayFeesCache.set(symbol, { updatedAt: Date.now(), value });
  return value;
}

let assetCache = null;
let assetCacheAt = 0;
async function assetSnapshot() {
  if (!configured) return { configured: false, spot: null, funding: null, earn: null, futures: null, wallets: null, prices: { USDT: 1 }, errors: ['Configure Binance credentials before reading assets.'] };
  if (assetCache && Date.now() - assetCacheAt < 10_000) return assetCache;
  const [spot, funding, earn, futuresAccount, wallets, prices] = await Promise.allSettled([binance.account(), binance.fundingAsset(), binance.earnFlexible(), futures.assetAccount(), binance.walletBalance('USDT'), binance.prices()]);
  const result = { configured: true, spot: null, funding: null, earn: null, futures: null, wallets: null, prices: { USDT: 1 }, errors: [] };
  for (const [key, entry] of [['spot', spot], ['funding', funding], ['earn', earn], ['futures', futuresAccount], ['wallets', wallets]]) {
    if (entry.status === 'fulfilled') result[key] = entry.value;
    else result.errors.push(`${key}: ${entry.reason instanceof Error ? entry.reason.message : 'Binance endpoint unavailable'}`);
  }
  if (prices.status === 'fulfilled') {
    const assets = new Set([
      ...(result.spot?.balances || []).map((item) => item.asset),
      ...(result.funding || []).map((item) => item.asset),
      ...(result.earn?.rows || []).map((item) => item.asset),
      ...(result.futures?.assets || []).map((item) => item.asset),
    ]);
    for (const item of prices.value || []) {
      const asset = item.symbol?.endsWith('USDT') ? item.symbol.slice(0, -4) : '';
      const price = Number(item.price);
      if (asset && assets.has(asset) && Number.isFinite(price)) result.prices[asset] = price;
    }
  } else result.errors.push(`prices: ${prices.reason instanceof Error ? prices.reason.message : 'Binance endpoint unavailable'}`);
  assetCache = result;
  assetCacheAt = Date.now();
  return result;
}

async function coinMMarket(symbol, interval, endTime, limit = 240, startTime) {
  const base = environment === 'testnet' ? 'https://testnet.binancefuture.com' : 'https://dapi.binance.com';
  const get = async (path, params) => {
    const response = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(startTime ? 30_000 : 10_000) });
    const result = await response.json();
    if (!response.ok) throw new BinanceApiError(result.msg || `Binance Coin-M request failed (${response.status}).`, { status: response.status, code: result.code });
    return result;
  };
  const klineParams = { symbol, interval, limit: String(limit), ...(startTime ? { startTime: String(startTime) } : {}), ...(endTime ? { endTime: String(endTime) } : {}) };
  if (endTime || startTime) return { symbol, interval, klines: await get('/dapi/v1/klines', klineParams), depth: { bids: [], asks: [] }, premium: { markPrice: '0', indexPrice: '0' }, partial: true };
  const [klines, depth, premium] = await Promise.all([
    get('/dapi/v1/klines', klineParams),
    get('/dapi/v1/depth', { symbol, limit: '1000' }),
    get('/dapi/v1/premiumIndex', { symbol }),
  ]);
  return { symbol, interval, klines, depth, premium: Array.isArray(premium) ? premium[0] : premium };
}

async function usdMMarket(symbol, interval, endTime) {
  const base = environment === 'testnet' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const get = async (path, params) => {
    const response = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(10_000) });
    const result = await response.json();
    if (!response.ok) throw new BinanceApiError(result.msg || `Binance USD-M request failed (${response.status}).`, { status: response.status, code: result.code });
    return result;
  };
  const klineParams = { symbol, interval, limit: '240', ...(endTime ? { endTime: String(endTime) } : {}) };
  if (endTime) return { symbol, interval, klines: await get('/fapi/v1/klines', klineParams), depth: { bids: [], asks: [] }, premium: { markPrice: '0', indexPrice: '0' }, partial: true };
  const [klines, depth, premium] = await Promise.all([
    get('/fapi/v1/klines', klineParams),
    get('/fapi/v1/depth', { symbol, limit: '1000' }),
    get('/fapi/v1/premiumIndex', { symbol }),
  ]);
  return { symbol, interval, klines, depth, premium: Array.isArray(premium) ? premium[0] : premium };
}

async function oneSecondMarket(symbol, marketType, endTime) {
  const coinM = marketType === 'coinm';
  const base = environment === 'testnet' ? 'https://testnet.binancefuture.com' : coinM ? 'https://dapi.binance.com' : 'https://fapi.binance.com';
  const path = coinM ? '/dapi/v1/aggTrades' : '/fapi/v1/aggTrades';
  const params = new URLSearchParams({ symbol, limit: '1000' });
  if (endTime) {
    params.set('endTime', String(endTime));
    params.set('startTime', String(Math.max(0, endTime - 60 * 60_000)));
  }
  const response = await fetch(`${base}${path}?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Binance ${coinM ? 'COIN-M' : 'USD-M'} trades request failed (${response.status}).`);
  const grouped = new Map();
  for (const trade of await response.json()) {
    const price = Number(trade.p ?? trade[1]); const quantity = Number(trade.q ?? trade[2]); const time = Math.floor(Number(trade.T ?? trade[6]) / 1_000) * 1_000;
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || !Number.isFinite(time)) continue;
    const current = grouped.get(time);
    if (!current) grouped.set(time, [time, price, price, price, price, quantity, time + 999, price * quantity]);
    else { current[2] = Math.max(current[2], price); current[3] = Math.min(current[3], price); current[4] = price; current[5] += quantity; current[7] += price * quantity; }
  }
  return { symbol, interval: '1s', klines: [...grouped.values()].slice(-240), depth: { bids: [], asks: [] }, premium: { markPrice: '0', indexPrice: '0' }, partial: true };
}

async function serverCoinMMarket(symbol, interval, endTime) {
  if (endTime || !marketDataBase || !marketDataKey) return coinMMarket(symbol, interval, endTime);
  try {
    const response = await fetch(`${marketDataBase}/v1/market/coinm/snapshot?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`, { headers: { Authorization: `Bearer ${marketDataKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`market relay returned ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn('market relay snapshot unavailable; using direct Binance fallback', error instanceof Error ? error.message : error);
    return coinMMarket(symbol, interval);
  }
}

const intervalWindowMs = (interval, limit) => interval === '1w' ? limit * 7 * 86_400_000 : limit * Number(marketIntervals[interval]);

async function storedMarketKlines(interval, { from, to = Date.now(), limit = 1_000 } = {}) {
  const start = Number.isFinite(from) ? from : Math.max(0, to - intervalWindowMs(interval, limit + 2));
  return marketStore.interval(interval, start, to, limit);
}

function sampleRows(rows, limit) {
  if (!Array.isArray(rows) || rows.length <= limit) return rows || [];
  const step = (rows.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => rows[Math.round(index * step)]);
}

async function automaticMarketContext(account, materials = {}) {
  const now = Date.now();
  const densityPoints = { off: 0, low: 30, medium: 90, high: 180, max: 2_000 };
  const ranges = Object.fromEntries(Object.entries({ '1m': 180, '5m': 144, '1h': 84, '4h': 180 }).map(([interval, fallback]) => {
    const density = ['off', 'low', 'medium', 'high', 'max'].includes(materials?.[interval]) ? materials[interval] : 'medium';
    return [interval, density === 'off' ? 0 : densityPoints[density]];
  }).filter(([, limit]) => limit > 0));
  ranges['1d'] = 240;
  const series = {};
  await marketReady.catch(() => {});
  for (const [interval, limit] of Object.entries(ranges)) {
    try {
      const source = interval === '1d'
        ? await storedMarketKlines(interval, { from: Date.UTC(2020, 0, 1), to: now, limit: 2_000 })
        : await storedMarketKlines(interval, { to: now, limit: limit * 2 });
      const rows = sampleRows(source, limit);
      if (rows.length) series[interval] = rows;
    } catch { /* local history is optional; the live snapshot still works */ }
  }
  const context = compactMarketContext({ symbol: 'BTCUSD_PERP', generatedAt: now, series, market: { funding: fundingCache.value || null }, account });
  return context;
}

async function automaticAccountContext() {
  if (!marketDataBase || !marketDataKey) return null;
  if (accountContextCache.inflight) return accountContextCache.inflight;
  if (accountContextCache.value && Date.now() - accountContextCache.updatedAt < 15_000) return accountContextCache.value;
  accountContextCache.inflight = (async () => {
    let account = null;
    try {
      const response = await fetch(`${marketDataBase}/v1/account/context`, { headers: { Authorization: `Bearer ${marketDataKey}` }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) account = await response.json();
    } catch {}
    if (!account) {
      const rows = await remoteAccountTrades({ limit: 120 }).catch(() => []);
      account = rows.length ? { trades: rows, count: rows.length } : null;
    }
    if (!account && configured) {
      const snapshot = await coinMSnapshot({ symbol: 'BTCUSD_PERP', limit: 100 }).catch(() => null);
      const pick = (row, keys) => Object.fromEntries(keys.filter((key) => row?.[key] !== undefined).map((key) => [key, row[key]]));
      if (snapshot) account = {
        source: 'binance-coinm-read-only',
        positions: (snapshot.positions || []).slice(0, 20).map((row) => pick(row, ['symbol', 'positionSide', 'positionAmt', 'entryPrice', 'markPrice', 'liquidationPrice', 'leverage', 'unRealizedProfit', 'updateTime'])),
        openOrders: (snapshot.openOrders || []).slice(0, 50).map((row) => pick(row, ['orderId', 'clientOrderId', 'symbol', 'side', 'type', 'price', 'stopPrice', 'origQty', 'executedQty', 'status', 'time', 'updateTime'])),
        orders: (snapshot.orders || []).slice(-50).map((row) => pick(row, ['orderId', 'clientOrderId', 'symbol', 'side', 'type', 'price', 'stopPrice', 'origQty', 'executedQty', 'status', 'time', 'updateTime'])),
        trades: (snapshot.trades || []).slice(-100).map((row) => pick(row, ['id', 'orderId', 'symbol', 'side', 'price', 'qty', 'quoteQty', 'realizedPnl', 'commission', 'commissionAsset', 'time'])),
      };
    }
    accountContextCache.value = account;
    accountContextCache.updatedAt = Date.now();
    return account;
  })().finally(() => { accountContextCache.inflight = null; });
  return accountContextCache.inflight;
}

function broadcastMarketRow(symbol, row) {
  const payload = `event: kline\ndata: ${JSON.stringify({ symbol, interval: '1m', row })}\n\n`;
  for (const response of marketStreams) response.write(payload);
}

function coinMKlineRow(event) {
  const row = event?.k;
  if (!row || row.s !== 'BTCUSD_PERP' || row.i !== '1m') return null;
  return [row.t, row.o, row.h, row.l, row.c, row.v, row.T, row.q, row.n, row.V, row.Q, '0'];
}

function coinMFunding(event) {
  if (event?.e !== 'markPriceUpdate') return null;
  return { markPrice: event.p, indexPrice: event.i, lastFundingRate: event.r, nextFundingTime: event.T };
}

function startMarketStream(symbol = 'BTCUSD_PERP') {
  let socket; let retryMs = 1_000; let stopped = false; let merge = Promise.resolve(); let lastReconcileAt = 0; let reconcile = Promise.resolve(); let lastStreamKlineTime = 0;
  const reconcileGap = () => {
    if (Date.now() - lastReconcileAt < 60_000) return reconcile;
    lastReconcileAt = Date.now();
    reconcile = reconcile.then(async () => {
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      const ranges = [];
      ranges.push({ from: Math.max(0, now - 60_000), to: now, reason: 'recent-refresh' });
      const gapRanges = await marketStore.gaps(Math.max(0, now - 24 * 60 * 60_000), now);
      ranges.push(...gapRanges.filter((range) => range.to < now - 60_000));
      for (const range of ranges.slice(0, 10)) {
        console.log(JSON.stringify({ event: 'coinm_gap_reconcile', ...range }));
        const limit = Math.min(1_500, Math.ceil((range.to - range.from + 60_000) / 60_000));
        const page = await coinMMarket(symbol, '1m', range.to + 59_999, limit, range.from);
        if (page.klines?.length) await marketStore.merge(page.klines, { persist: true });
        console.log(JSON.stringify({ event: 'coinm_gap_reconciled', from: range.from, to: range.to, rows: page.klines?.length || 0 }));
      }
    }).catch((error) => console.warn('COIN-M gap reconciliation unavailable', error instanceof Error ? error.message : error));
    return reconcile;
  };
  const reconnect = () => { if (stopped) return; setTimeout(() => { void connect(); }, retryMs); retryMs = Math.min(retryMs * 2, 30_000); };
  const connect = async () => {
    if (stopped) return;
    console.log(JSON.stringify({ event: 'coinm_ws_connecting', symbol, retryMs, lastLocalTime: (await marketStore.manifest().catch(() => ({}))).lastTime || null }));
    await reconcileGap();
    const stream = symbol.toLowerCase();
    try { socket = new WebSocket(`wss://dstream.binance.com/stream?streams=${stream}@kline_1m/${stream}@markPrice@1s`); } catch { reconnect(); return; }
    socket.addEventListener('open', () => { console.log(JSON.stringify({ event: 'coinm_ws_open', symbol })); retryMs = 1_000; });
    socket.addEventListener('message', (message) => {
      try {
        const payload = JSON.parse(String(message.data)); const event = payload.data || payload;
        const funding = coinMFunding(event);
        if (funding) { fundingCache = { value: funding, updatedAt: Date.now() }; return; }
        const row = coinMKlineRow(event); if (!row) return;
        const klineTime = Number(row[0]);
        if (lastStreamKlineTime && klineTime > lastStreamKlineTime + 60_000) void reconcileGap();
        if (klineTime > lastStreamKlineTime) lastStreamKlineTime = klineTime;
        merge = merge.then(() => marketStore.merge([row], { persist: Boolean(event.k.x) })).then(() => broadcastMarketRow(symbol, row)).catch((error) => console.warn('COIN-M stream merge unavailable', error instanceof Error ? error.message : error));
      } catch {}
    });
    socket.addEventListener('close', () => { console.warn(JSON.stringify({ event: 'coinm_ws_close', symbol, retryMs })); reconnect(); });
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
  };
  marketReady = reconcileGap();
  void connect();
  return () => { stopped = true; socket?.close(); };
}

async function orderBookContext(range) {
  if (!range || !marketDataBase || !marketDataKey) return null;
  try {
    const query = new URLSearchParams({ symbol: 'BTCUSD_PERP', interval: '1m', featureStartTime: String(range.startTime), featureEndTime: String(range.endTime) });
    const response = await fetch(`${marketDataBase}/v1/market/coinm/snapshot?${query}`, { headers: { Authorization: `Bearer ${marketDataKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return (await response.json()).orderBookWindow || null;
  } catch { return null; }
}

function historicalMarketRequest(message, now = Date.now()) {
  const text = String(message || '');
  const price = Number(text.match(/(?:突破|穿越|站上|跌破|跌穿)\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]);
  if (!Number.isFinite(price) || !/(昨天|前天|今日|今天|突破|穿越|站上|跌破|历史)/u.test(text)) return null;
  const chinaOffset = 8 * 60 * 60 * 1000;
  const localDay = Math.floor((now + chinaOffset) / 86_400_000) * 86_400_000 - chinaOffset;
  const start = /前天/u.test(text) ? localDay - 2 * 86_400_000 : /昨天/u.test(text) ? localDay - 86_400_000 : localDay;
  return { startTime: start, endTime: start + 86_400_000, price, direction: /跌破|跌穿/u.test(text) ? 'down' : 'up' };
}

async function historicalMarketContext(message) {
  const request = historicalMarketRequest(message);
  if (!request || !marketDataBase || !marketDataKey) return null;
  try {
    const rows = await remoteMarketHistory(request.startTime, request.endTime);
    const crossing = rows.find((row, index) => index > 0 && (request.direction === 'up' ? rows[index - 1].close < request.price && row.close >= request.price : rows[index - 1].close > request.price && row.close <= request.price));
    if (!crossing) return { ...request, candles: rows.slice(-2_000), crossing: null };
    const index = rows.indexOf(crossing);
    return { ...request, crossing: { time: crossing.time, price: crossing.close }, candles: rows.slice(Math.max(0, index - 120), Math.min(rows.length, index + 120)) };
  } catch { return null; }
}

async function remoteMarketHistory(startTime, endTime) {
  if (!marketDataBase || !marketDataKey) return [];
  const query = new URLSearchParams({ symbol: 'BTCUSD_PERP', startTime: String(startTime), endTime: String(endTime) });
  const response = await fetch(`${marketDataBase}/v1/market/coinm/history?${query}`, { headers: { Authorization: `Bearer ${marketDataKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return [];
  return (await response.json()).klines || [];
}

async function remoteAccountTrades({ product = '', symbol = '', startTime = Date.now() - 7 * 24 * 60 * 60_000, endTime = Date.now(), limit = 500 } = {}) {
  if (!marketDataBase || !marketDataKey) return [];
  const query = new URLSearchParams({ limit: String(limit), startTime: String(startTime), endTime: String(endTime), ...(product ? { product } : {}), ...(symbol ? { symbol } : {}) });
  const response = await fetch(`${marketDataBase}/v1/account/trades?${query}`, { headers: { Authorization: `Bearer ${marketDataKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return [];
  return (await response.json()).rows || [];
}

async function tradeContext(message, account = null) {
  if (!/(交易历史|历史交易|我的交易|成交记录|交易记录|盈亏|胜率)/u.test(String(message || ''))) return null;
  try {
    const rows = Array.isArray(account?.trades) ? account.trades : await remoteAccountTrades({ limit: 1000 });
    const pnl = rows.reduce((sum, row) => sum + Number(row.realizedPnl || 0), 0);
    const commission = rows.reduce((sum, row) => sum + Number(row.commission || 0), 0);
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    const recent = rows.filter((row) => Number(row.time) >= cutoff);
    const candles = recent.length ? await remoteMarketHistory(Math.min(...recent.map((row) => Number(row.time))) - 30 * 60_000, Math.max(...recent.map((row) => Number(row.time))) + 30 * 60_000) : [];
    const byMinute = new Map(candles.map((row) => [Math.floor(row.time / 60_000), row]));
    const trades = rows.map((row) => ({ ...row, marketAtTrade: byMinute.get(Math.floor(Number(row.time) / 60_000)) || null }));
    const products = Object.fromEntries(['spot', 'margin', 'usdm', 'coinm'].map((product) => [product, rows.filter((row) => row.product === product).length]));
    return { products, marketProxy: 'Binance COIN-M BTCUSD_PERP 1m', count: rows.length, realizedPnl: pnl, commission, trades };
  } catch { return null; }
}

async function pipeServerCoinMStream(request, response, interval) {
  if (!marketDataBase || !marketDataKey) return false;
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  response.once('close', disconnect);
  try {
    const upstream = await fetch(`${marketDataBase}/v1/market/coinm/stream?symbol=BTCUSD_PERP&interval=${encodeURIComponent(interval)}`, { headers: { Authorization: `Bearer ${marketDataKey}` }, signal: controller.signal });
    if (!upstream.ok || !upstream.body) return false;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for await (const chunk of upstream.body) response.write(chunk);
    response.end();
    return true;
  } catch {
    if (!response.headersSent) return false;
    response.end();
    return true;
  } finally { response.off('close', disconnect); }
}

async function createDraft(rawIntent) {
  const intent = normalizeOrderIntent(rawIntent, { allowedSymbols });
  const [exchange, ticker, account] = await Promise.all([binance.exchangeInfo(intent.symbol), binance.ticker(intent.symbol), accountSnapshot()]);
  const symbolInfo = exchange.symbols?.[0];
  const estimate = validateOrder(intent, { symbolInfo, ticker, balances: account.balances, maxOrderUsdt });
  await binance.testOrder(intent);
  cleanDrafts();
  const draft = { id: randomUUID(), confirmationToken: randomUUID(), intent, estimate, environment, createdAt: Date.now(), state: 'pending' };
  drafts.set(draft.id, draft);
  return draft;
}

function createFuturesDraft(raw) {
  const symbol = String(raw?.symbol || '').toUpperCase();
  const side = String(raw?.side || '').toUpperCase();
  const type = String(raw?.type || 'MARKET').toUpperCase();
  const marginType = String(raw?.marginType || (symbol.endsWith('USD_PERP') ? 'CROSSED' : 'ISOLATED')).toUpperCase();
  const leverage = Number(raw?.leverage || 1);
  const quantity = String(raw?.quantity || '');
  if (!symbol || !symbolAllowed(symbol)) throw new Error('Futures symbol is not in the trading allowlist.');
  if (!['BUY', 'SELL'].includes(side) || !['MARKET', 'LIMIT'].includes(type)) throw new Error('Futures supports MARKET or LIMIT orders.');
  if (!['ISOLATED', 'CROSSED'].includes(marginType)) throw new Error('marginType must be ISOLATED or CROSSED.');
  if (!/^\d+(?:\.\d+)?$/.test(quantity) || Number(quantity) <= 0) throw new Error('Futures quantity must be a positive decimal.');
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error('Futures leverage must be an integer from 1x to 125x.');
  const price = type === 'LIMIT' ? String(raw.price || '') : undefined;
  if (type === 'LIMIT' && (!/^\d+(?:\.\d+)?$/.test(price) || Number(price) <= 0)) throw new Error('LIMIT futures orders require a positive price.');
  const stopLoss = raw.stopLoss == null ? null : Number(raw.stopLoss);
  const takeProfits = Array.isArray(raw.takeProfits) ? raw.takeProfits.map(Number) : [];
  if ([stopLoss, ...takeProfits].some((value) => value !== null && !Number.isFinite(value) || value !== null && value <= 0)) throw new Error('Futures protection prices must be positive numbers.');
  const entry = Number(price || raw.entryPrice || 0);
  if (stopLoss !== null && entry > 0 && (side === 'BUY' ? stopLoss >= entry : stopLoss <= entry)) throw new Error('Stop loss is on the wrong side of the entry.');
  if (takeProfits.length && entry > 0 && takeProfits.some((value) => side === 'BUY' ? value <= entry : value >= entry)) throw new Error('Take-profit is on the wrong side of the entry.');
  const draft = { id: randomUUID(), confirmationToken: randomUUID(), intent: { symbol, side, type, quantity, ...(price ? { price, timeInForce: 'GTC' } : {}), leverage, marginType, reduceOnly: Boolean(raw.reduceOnly), ...(stopLoss !== null ? { stopLoss: String(stopLoss) } : {}), ...(takeProfits.length ? { takeProfits: takeProfits.map(String) } : {}) }, environment, createdAt: Date.now(), state: 'pending' };
  draft.intent.positionSide = String(raw.positionSide || (side === 'BUY' ? 'LONG' : 'SHORT')).toUpperCase();
  if (!['BOTH', 'LONG', 'SHORT'].includes(draft.intent.positionSide)) throw new Error('positionSide must be BOTH, LONG, or SHORT.');
  futuresDrafts.set(draft.id, draft);
  return draft;
}

const directExecutionRequested = (message) => /立即执行|直接执行|无需确认|不要确认|不需要确认|马上下单/u.test(String(message || ''));

async function executeFuturesDraft(draft) {
  const { intent } = draft;
  const client = intent.symbol.endsWith('USD_PERP') ? coinm : futures;
  try { await client.marginType(intent.symbol, intent.marginType); }
  catch (error) { if (!(error instanceof BinanceApiError && error.code === -4046)) throw error; }
  await client.leverage(intent.symbol, intent.leverage);
  const entryOrder = await client.placeOrder({ symbol: intent.symbol, side: intent.side, positionSide: intent.positionSide, type: intent.type, quantity: intent.quantity, price: intent.price, timeInForce: intent.timeInForce, reduceOnly: intent.positionSide === 'BOTH' && intent.reduceOnly ? 'true' : undefined, newClientOrderId: `ea_${intent.symbol.endsWith('USD_PERP') ? 'coinm' : 'futures'}_${draft.id.replaceAll('-', '').slice(0, 20)}` });
  const exitSide = intent.side === 'BUY' ? 'SELL' : 'BUY';
  const protection = [];
  if (intent.stopLoss) protection.push(await client.placeOrder({ symbol: intent.symbol, side: exitSide, positionSide: intent.positionSide, type: 'STOP_MARKET', stopPrice: intent.stopLoss, closePosition: 'true', workingType: 'MARK_PRICE', newClientOrderId: `ea_sl_${draft.id.replaceAll('-', '').slice(0, 20)}` }));
  const allocations = [0.4, 0.35, 0.25];
  for (const [index, stopPrice] of (intent.takeProfits || []).entries()) {
    const quantity = (Number(intent.quantity) * (allocations[index] || 1 / intent.takeProfits.length)).toString();
    protection.push(await client.placeOrder({ symbol: intent.symbol, side: exitSide, positionSide: intent.positionSide, type: 'TAKE_PROFIT_MARKET', stopPrice, quantity, reduceOnly: intent.positionSide === 'BOTH' ? 'true' : undefined, workingType: 'MARK_PRICE', newClientOrderId: `ea_tp${index}_${draft.id.replaceAll('-', '').slice(0, 18)}` }));
  }
  return { entry: entryOrder, protection };
}

function createMarginDraft(raw) {
  const symbol = String(raw?.symbol || '').toUpperCase(); const side = String(raw?.side || '').toUpperCase(); const type = String(raw?.type || 'MARKET').toUpperCase();
  const isIsolated = String(raw?.marginType || 'ISOLATED').toUpperCase() === 'ISOLATED'; const quantity = String(raw?.quantity || ''); const quoteOrderQty = String(raw?.quoteOrderQty || '');
  if (!symbol || !symbolAllowed(symbol)) throw new Error('Margin symbol is not in the trading allowlist.');
  if (!['BUY', 'SELL'].includes(side) || type !== 'MARKET') throw new Error('Margin currently supports MARKET BUY or SELL only.');
  if (!(quantity || quoteOrderQty) || (quantity && !/^\d+(?:\.\d+)?$/.test(quantity)) || (quoteOrderQty && !/^\d+(?:\.\d+)?$/.test(quoteOrderQty))) throw new Error('Margin quantity must be a positive decimal.');
  const intent = { symbol, side, type, isIsolated: String(isIsolated), ...(quantity ? { quantity } : { quoteOrderQty }) };
  const draft = { id: randomUUID(), confirmationToken: randomUUID(), intent, environment, createdAt: Date.now(), state: 'pending' };
  marginDrafts.set(draft.id, draft); return draft;
}

export function createCryptoServer() {
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    try {
      if (request.method === 'GET' && request.url === '/api/status') {
        return sendJson(response, 200, { configured, environment, liveTradingEnabled, allowedSymbols, maxOrderUsdt, futures: { configured, maxLeverage: 125, confirmationRequired: true }, margin: { configured, confirmationRequired: true, borrowRepayEnabled: false }, model: { provider: gatewayProvider, models: modelOptions, reasoning: reasoningOptions, defaultModel, defaultReasoning } });
      }
      if (request.method === 'POST' && request.url === '/api/chart-log') {
        const payload = await body(request, 100_000);
        await saveChartLogs(Array.isArray(payload.entries) ? payload.entries : [payload.entry]);
        return sendJson(response, 204, {});
      }
      if (request.method === 'POST' && request.url === '/api/composer-log') {
        const payload = await body(request, 10_000);
        await saveComposerLog({ event: 'composer_layout', at: Date.now(), ...payload });
        return sendJson(response, 204, {});
      }
      if (request.method === 'GET' && request.url === '/api/gmail/status') return sendJson(response, 200, await gmailStatus());
      if (request.method === 'GET' && request.url === '/api/market/messages/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for (const item of await marketMessages.list(100)) response.write(`event: market-message\ndata: ${JSON.stringify(item)}\n\n`);
        const unsubscribe = marketMessages.subscribe(response); request.on('close', unsubscribe); return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/market/messages')) { const query = new URL(request.url, 'http://localhost').searchParams; const synced = await syncMarketMessages(200); const before = query.get('before'); const messages = (before ? synced.filter((item) => Number(item.publishedAt || item.createdAt) < Number(before)) : synced).slice(0, Math.min(500, Math.max(1, Number(query.get('limit') || 50)))); return sendJson(response, 200, { messages }); }
      if (request.method === 'GET' && request.url === '/api/gmail/oauth/start') {
        const location = gmailOAuthStart(); response.writeHead(302, { Location: location }); return response.end();
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/gmail/oauth/callback')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const result = await gmailOAuthCallback({ code: query.get('code') || '', state: query.get('state') || '' });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(`<h1>Gmail connected</h1><pre>${JSON.stringify(result, null, 2)}</pre>`);
      }
      if (request.method === 'POST' && request.url?.startsWith('/api/gmail/pubsub')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        if (!checkGmailPushToken(query.get('token') || request.headers['x-gmail-pubsub-token'])) return sendJson(response, 401, { error: 'Invalid Gmail Pub/Sub token.' });
        const payload = await body(request, 100_000); const result = await handleGmailPush(payload); return sendJson(response, 200, result);
      }
      if (request.method === 'GET' && request.url === '/api/emergency/status') return sendJson(response, 200, emergency.status());
      if (request.method === 'POST' && request.url === '/api/emergency/confirm') {
        const payload = await body(request);
        return sendJson(response, 200, { grant: emergency.confirm(payload) });
      }
      if (request.method === 'POST' && request.url === '/api/emergency/revoke') {
        const payload = await body(request);
        return sendJson(response, 200, { revoked: emergency.revoke(String(payload.reason || 'manual')) });
      }
      if (request.method === 'POST' && request.url === '/api/emergency/order') {
        if (!liveTradingEnabled) return sendJson(response, 403, { error: 'Live trading is locked; emergency orders remain disabled.' });
        const payload = await body(request);
        const draft = await createDraft(payload.intent);
        emergency.consume({ grantId: String(payload.grantId || ''), notional: draft.estimate.estimatedNotional });
        const order = await binance.placeOrder({ ...draft.intent, newClientOrderId: `ea_emergency_${draft.id.replaceAll('-', '').slice(0, 20)}` });
        return sendJson(response, 200, { order, authorization: emergency.status().grant });
      }
      if (request.method === 'GET' && request.url === '/api/account') {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials in apps/crypto-agent/.env.' });
        return sendJson(response, 200, await accountSnapshot());
      }
      if (request.method === 'GET' && request.url === '/api/assets') return sendJson(response, 200, await assetSnapshot());
      if (request.method === 'GET' && request.url === '/api/futures/account') {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials before reading Futures.' });
        return sendJson(response, 200, await futures.account());
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/coinm/snapshot')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        const limit = Math.min(1000, Math.max(1, Number(query.get('limit') || 100)));
        const startTime = query.get('startTime') ? Number(query.get('startTime')) : undefined;
        const endTime = query.get('endTime') ? Number(query.get('endTime')) : undefined;
        if (!symbol || (symbol !== 'BTCUSD_PERP' && !symbolAllowed(symbol))) return sendJson(response, 400, { error: 'Symbol is not allowed.' });
        if ([startTime, endTime].some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0))) return sendJson(response, 400, { error: 'Time range is not valid.' });
        return sendJson(response, 200, await coinMSnapshot({ symbol, startTime, endTime, limit }));
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/coinm/today-fees')) {
        const symbol = new URL(request.url, 'http://localhost').searchParams.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        if (!symbol || (symbol !== 'BTCUSD_PERP' && !symbolAllowed(symbol))) return sendJson(response, 400, { error: 'Symbol is not allowed.' });
        return sendJson(response, 200, await todayCoinMFees({ symbol }));
      }
      if (request.method === 'GET' && request.url === '/api/margin/account') {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials before reading Margin.' });
        return sendJson(response, 200, await margin.account());
      }
      if (request.method === 'POST' && request.url === '/api/margin/drafts') {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials before preparing a Margin order.' });
        return sendJson(response, 200, { draft: createMarginDraft(await body(request)) });
      }
      if (request.method === 'POST' && request.url === '/api/margin/actions/drafts') {
        const payload = await body(request); const action = String(payload.action || '').toUpperCase(); const asset = String(payload.asset || '').toUpperCase(); const amount = String(payload.amount || '');
        if (!['BORROW', 'REPAY'].includes(action) || !asset || !/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) return sendJson(response, 400, { error: 'Margin action requires BORROW/REPAY, asset, and a positive amount.' });
        const draft = { id: randomUUID(), confirmationToken: randomUUID(), action, params: { asset, amount, isIsolated: String(Boolean(payload.isIsolated)), symbol: payload.symbol ? String(payload.symbol).toUpperCase() : undefined }, createdAt: Date.now(), state: 'pending' };
        marginActionDrafts.set(draft.id, draft); return sendJson(response, 200, { draft });
      }
      const marginActionConfirm = request.url?.match(/^\/api\/margin\/actions\/drafts\/([^/]+)\/confirm$/);
      if (request.method === 'POST' && marginActionConfirm) {
        const payload = await body(request); const draft = marginActionDrafts.get(marginActionConfirm[1]);
        if (!draft || Date.now() - draft.createdAt > 5 * 60_000) return sendJson(response, 404, { error: 'Margin action draft expired or was not found.' });
        if (draft.state !== 'pending') return sendJson(response, 409, { error: 'This Margin action draft was already handled.' });
        if (payload.confirmation !== 'CONFIRM' || payload.confirmationToken !== draft.confirmationToken) return sendJson(response, 400, { error: 'Explicit confirmation for this exact Margin action is required.' });
        if (!liveTradingEnabled) return sendJson(response, 403, { error: 'Live trading is locked; Margin actions are disabled.' });
        draft.state = 'submitting'; const result = draft.action === 'BORROW' ? await margin.borrow(draft.params) : await margin.repay(draft.params); draft.state = 'submitted'; return sendJson(response, 200, { result });
      }
      const marginConfirm = request.url?.match(/^\/api\/margin\/drafts\/([^/]+)\/confirm$/);
      if (request.method === 'POST' && marginConfirm) {
        const payload = await body(request); const draft = marginDrafts.get(marginConfirm[1]);
        if (!draft || Date.now() - draft.createdAt > 5 * 60_000) return sendJson(response, 404, { error: 'Margin draft expired or was not found.' });
        if (draft.state !== 'pending') return sendJson(response, 409, { error: 'This Margin draft was already handled.' });
        if (payload.confirmation !== 'CONFIRM' || payload.confirmationToken !== draft.confirmationToken) return sendJson(response, 400, { error: 'Explicit confirmation for this exact Margin draft is required.' });
        if (!liveTradingEnabled) return sendJson(response, 403, { error: 'Live trading is locked; Margin submission is disabled.' });
        draft.state = 'submitting';
        try { const order = await margin.order(draft.intent); draft.state = 'submitted'; return sendJson(response, 200, { order }); }
        catch (error) { draft.state = error instanceof BinanceApiError && error.executionUnknown ? 'unknown' : 'failed'; throw error; }
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/futures/positions')) {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials before reading Futures.' });
        const symbol = new URL(request.url, 'http://localhost').searchParams.get('symbol')?.toUpperCase();
        return sendJson(response, 200, await futures.positionRisk(symbol));
      }
      if (request.method === 'POST' && request.url === '/api/futures/drafts') {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials before preparing a Futures order.' });
        return sendJson(response, 200, { draft: createFuturesDraft(await body(request)) });
      }
      const futuresConfirm = request.url?.match(/^\/api\/futures\/drafts\/([^/]+)\/confirm$/);
      if (request.method === 'POST' && futuresConfirm) {
        const payload = await body(request);
        const draft = futuresDrafts.get(futuresConfirm[1]);
        if (!draft || Date.now() - draft.createdAt > 5 * 60_000) return sendJson(response, 404, { error: 'Futures draft expired or was not found.' });
        if (draft.state !== 'pending') return sendJson(response, 409, { error: 'This Futures draft was already handled.' });
        if (payload.confirmation !== 'CONFIRM' || payload.confirmationToken !== draft.confirmationToken) return sendJson(response, 400, { error: 'Explicit confirmation for this exact Futures draft is required.' });
        if (!liveTradingEnabled) return sendJson(response, 403, { error: 'Live trading is locked; Futures submission is disabled.' });
        draft.state = 'submitting';
        try {
          const order = await executeFuturesDraft(draft);
          draft.state = 'submitted';
          return sendJson(response, 200, { order });
        } catch (error) { draft.state = error instanceof BinanceApiError && error.executionUnknown ? 'unknown' : 'failed'; throw error; }
      }
      if (request.method === 'GET' && request.url === '/api/permissions') {
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials in apps/crypto-agent/.env.' });
        const account = await binance.account();
        return sendJson(response, 200, { permissions: auditBinancePermissions(account) });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/ticker?')) {
        const symbol = new URL(request.url, 'http://localhost').searchParams.get('symbol')?.toUpperCase();
        if (!symbol || !symbolAllowed(symbol)) return sendJson(response, 400, { error: 'Symbol is not allowed.' });
        return sendJson(response, 200, await binance.ticker(symbol));
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/klines?')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase();
        const interval = query.get('interval') || '1m';
        if (!symbol || !symbolAllowed(symbol)) return sendJson(response, 400, { error: 'Symbol is not allowed.' });
        if (!['1m', '5m', '15m', '1h', '4h', '1d'].includes(interval)) return sendJson(response, 400, { error: 'Interval is not allowed.' });
        return sendJson(response, 200, { symbol, interval, klines: await binance.klines(symbol, interval, 120) });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/market/klines?')) {
        await marketReady;
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        const interval = query.get('interval') || '1m';
        const endTime = query.get('endTime');
        const limit = Math.min(5_000, Math.max(1, Number(query.get('limit') || 240)));
        if (symbol !== 'BTCUSD_PERP') return sendJson(response, 400, { error: 'Only BTCUSD_PERP is available in this first COIN-M view.' });
        if (!marketIntervals[interval]) return sendJson(response, 400, { error: 'Interval is not allowed.' });
        if (endTime && (!/^\d+$/.test(endTime) || Number(endTime) <= 0)) return sendJson(response, 400, { error: 'endTime is not valid.' });
        const to = endTime ? Number(endTime) : Date.now();
        return sendJson(response, 200, { symbol, interval, klines: await storedMarketKlines(interval, { to, limit }) });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/market/manifest?')) {
        await marketReady;
        const symbol = new URL(request.url, 'http://localhost').searchParams.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        if (symbol !== 'BTCUSD_PERP') return sendJson(response, 400, { error: 'Only BTCUSD_PERP is available.' });
        return sendJson(response, 200, await marketStore.manifest());
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/market/window?')) {
        await marketReady;
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSD_PERP'; const interval = query.get('interval') || '1m';
        const from = Number(query.get('from')); const to = Number(query.get('to'));
        if (symbol !== 'BTCUSD_PERP' || !marketIntervals[interval]) return sendJson(response, 400, { error: 'Market window is not valid.' });
        if (![from, to].every(Number.isFinite) || from < 0 || to <= from) return sendJson(response, 400, { error: 'Time window is not valid.' });
        return sendJson(response, 200, { symbol, interval, klines: await storedMarketKlines(interval, { from, to, limit: 100_000 }) });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/market/stream?')) {
        await marketReady;
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(': connected\n\n'); marketStreams.add(response);
        request.on('close', () => marketStreams.delete(response)); return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/market/funding?')) {
        const symbol = new URL(request.url, 'http://localhost').searchParams.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        if (symbol !== 'BTCUSD_PERP') return sendJson(response, 400, { error: 'Only BTCUSD_PERP is available in this first COIN-M view.' });
        return sendJson(response, 200, { symbol, premium: fundingCache.value || {} });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/coinm-market?')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        const interval = query.get('interval') || '5m';
        const endTime = query.get('endTime');
        if (symbol !== 'BTCUSD_PERP') return sendJson(response, 400, { error: 'Only BTCUSD_PERP is available in this first Coin-M view.' });
        if (!['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'].includes(interval)) return sendJson(response, 400, { error: 'Interval is not allowed.' });
        if (endTime && (!/^\d+$/.test(endTime) || Number(endTime) <= 0)) return sendJson(response, 400, { error: 'endTime is not valid.' });
        return sendJson(response, 200, await serverCoinMMarket(symbol, interval, endTime ? Number(endTime) : undefined));
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/usdm-market?')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSDT';
        const interval = query.get('interval') || '5m';
        const endTime = query.get('endTime');
        if (symbol !== 'BTCUSDT') return sendJson(response, 400, { error: 'Only BTCUSDT is available in this first USD-M view.' });
        if (!['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'].includes(interval)) return sendJson(response, 400, { error: 'Interval is not allowed.' });
        if (endTime && (!/^\d+$/.test(endTime) || Number(endTime) <= 0)) return sendJson(response, 400, { error: 'endTime is not valid.' });
        return sendJson(response, 200, await usdMMarket(symbol, interval, endTime ? Number(endTime) : undefined));
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/usdm-history?')) {
        const symbol = new URL(request.url, 'http://localhost').searchParams.get('symbol')?.toUpperCase() || 'BTCUSDT';
        if (symbol !== 'BTCUSDT') return sendJson(response, 400, { error: 'Only BTCUSDT is available in this first USD-M view.' });
        try { return sendJson(response, 200, { rows: await remoteAccountTrades({ product: 'usdm', symbol, limit: 50 }) }); } catch { return sendJson(response, 200, { rows: [] }); }
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/trades')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const product = query.get('product') || ''; const symbol = query.get('symbol')?.toUpperCase() || '';
        if (product && !['spot', 'margin', 'usdm', 'coinm'].includes(product)) return sendJson(response, 400, { error: 'Product is not allowed.' });
        const limit = Math.min(1000, Math.max(1, Number(query.get('limit') || 500)));
        const startTime = Number(query.get('startTime') || Date.now() - 7 * 24 * 60 * 60_000); const endTime = Number(query.get('endTime') || Date.now());
        if (![limit, startTime, endTime].every(Number.isFinite) || startTime < 0 || endTime <= startTime) return sendJson(response, 400, { error: 'Trade query is not valid.' });
        return sendJson(response, 200, { rows: await remoteAccountTrades({ product, symbol, startTime, endTime, limit }) });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/usdm-1s?')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSDT';
        const endTime = query.get('endTime');
        if (symbol !== 'BTCUSDT') return sendJson(response, 400, { error: 'Only BTCUSDT is available in this first USD-M view.' });
        if (endTime && (!/^\d+$/.test(endTime) || Number(endTime) <= 0)) return sendJson(response, 400, { error: 'endTime is not valid.' });
        try { return sendJson(response, 200, await oneSecondMarket(symbol, 'usdm', endTime ? Number(endTime) : undefined)); } catch (error) { console.warn('USD-M one-second trades unavailable', error instanceof Error ? error.message : error); return sendJson(response, 200, { symbol, interval: '1s', klines: [], depth: { bids: [], asks: [] }, premium: { markPrice: '0', indexPrice: '0' }, partial: true }); }
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/coinm-1s?')) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const symbol = query.get('symbol')?.toUpperCase() || 'BTCUSD_PERP';
        const endTime = query.get('endTime');
        if (symbol !== 'BTCUSD_PERP') return sendJson(response, 400, { error: 'Only BTCUSD_PERP is available in this first COIN-M view.' });
        if (endTime && (!/^\d+$/.test(endTime) || Number(endTime) <= 0)) return sendJson(response, 400, { error: 'endTime is not valid.' });
        try { return sendJson(response, 200, await oneSecondMarket(symbol, 'coinm', endTime ? Number(endTime) : undefined)); } catch (error) { console.warn('COIN-M one-second trades unavailable', error instanceof Error ? error.message : error); return sendJson(response, 200, { symbol, interval: '1s', klines: [], depth: { bids: [], asks: [] }, premium: { markPrice: '0', indexPrice: '0' }, partial: true }); }
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/coinm-stream?')) {
        const interval = new URL(request.url, 'http://localhost').searchParams.get('interval') || '5m';
        if (!['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'].includes(interval)) return sendJson(response, 400, { error: 'Interval is not allowed.' });
        if (await pipeServerCoinMStream(request, response, interval)) return;
        return sendJson(response, 503, { error: 'Server market relay unavailable.' });
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/chat/stream?')) {
        const chatRequestId = new URL(request.url, 'http://localhost').searchParams.get('requestId') || '';
        const job = chatRequests.get(chatRequestId);
        if (!job) return sendJson(response, 404, { error: 'Chat request was not found.' });
        return subscribeChatRequest(request, response, job);
      }
      if (request.method === 'POST' && request.url === '/api/chat') {
        const timings = {};
        const mark = (name, startedAt) => { timings[name] = Date.now() - startedAt; };
        const payload = await body(request, 6_000_000);
        const message = String(payload.message || '').trim();
        const image = payload.image;
        if (!message && !image) return sendJson(response, 400, { error: 'A message or image is required.' });
        if (image && !validImageDataUrl(image)) return sendJson(response, 400, { error: 'Only PNG, JPEG, and WebP image data is accepted.' });
        let parsed;
        const model = modelOptions.includes(payload.model) ? payload.model : defaultModel;
        const reasoningEffort = reasoningOptions.includes(payload.reasoning_effort) ? payload.reasoning_effort : defaultReasoning;
        if (!isTradeCommand(message)) {
          if (!gateway) return sendJson(response, 503, { error: 'Configure a model gateway before asking for market analysis.' });
          const chatRequestId = typeof payload.requestId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(payload.requestId) ? payload.requestId : randomUUID();
          const existing = chatRequests.get(chatRequestId);
          if (payload.stream === true && existing) return subscribeChatRequest(request, response, existing);
          let stageStartedAt = Date.now();
          const range = requestedOrderBookRange(message);
          const bookWindow = await orderBookContext(range);
          mark('orderBookMs', stageStartedAt);
          const marketContext = bookWindow ? { ...(payload.marketContext || {}), orderBookWindow: { ...bookWindow, requestedRange: range } } : payload.marketContext;
          stageStartedAt = Date.now();
          const [historicalMarket, accountContext] = await Promise.all([historicalMarketContext(message), automaticAccountContext()]);
          mark('historicalAndAccountMs', stageStartedAt);
          stageStartedAt = Date.now();
          const tradeHistory = await tradeContext(message, accountContext);
          const autoMarket = await automaticMarketContext(payload.accountContext || accountContext, payload.materials);
          const newsContext = (await readCachedMarketMessages()).slice(0, 20).map(({ id, publishedAt, title, content, source }) => ({ id, publishedAt, title, content: String(content || '').slice(0, 8_000), source }));
          mark('tradeMarketNewsMs', stageStartedAt);
          stageStartedAt = Date.now();
          const prompt = analysisMessages({ message: message || '请分析这张图片。', history: payload.history, marketContext, historicalMarket, tradeContext: tradeHistory || accountContext, autoMarket, newsContext, image });
          if (payload.stream === true) {
            const job = { id: chatRequestId, reply: '', status: 'streaming', subscribers: new Set(), result: null, error: '' };
            chatRequests.set(chatRequestId, job);
            void (async () => {
              try {
                for await (const chunk of gateway.stream(prompt, { model, reasoningEffort })) {
                  job.reply += chunk;
                  broadcastChatRequest(job, 'delta', { delta: chunk });
                }
                finishChatRequest(job, 'completed');
              } catch (error) {
                finishChatRequest(job, 'failed', { error: error instanceof Error ? error.message : 'Model gateway failed.' });
              }
            })();
            mark('vipapiMs', stageStartedAt);
            return subscribeChatRequest(request, response, job);
          }
          const reply = await gateway.complete(prompt, { model, reasoningEffort });
          mark('vipapiMs', stageStartedAt);
          const timingLog = { event: 'chat_timing', requestId, messageChars: message.length, model, reasoningEffort, newsCount: newsContext.length, hasAccountContext: Boolean(accountContext), autoMarketTokens: autoMarket?.estimatedTokens || 0, timings: { ...timings, totalMs: Date.now() - requestStartedAt } };
          console.log(JSON.stringify(timingLog));
          void saveChatLog(timingLog).catch((error) => console.error(JSON.stringify({ event: 'chat_log_error', requestId, error: error.message })));
          return sendJson(response, 200, { reply });
        }
        if (!configured) return sendJson(response, 503, { error: 'Configure Binance credentials before preparing an order.' });
        const product = inferProduct(message);
        if (gateway) parsed = parseModelJson(await gateway.complete([{ role: 'system', content: product === 'spot' ? tradePrompt(message, allowedSymbols || ['any USDT spot symbol']) : multiProductTradePrompt(message, allowedSymbols || ['any USDT symbol']) }], { model, reasoningEffort }));
        else parsed = { reply: '', intent: fallbackIntent(message) };
        if (!parsed?.intent) return sendJson(response, 200, { reply: parsed?.reply || '请明确交易方向、交易对和数量，例如“用 50 USDT 市价买入 BTC”。' });
        const resolvedProduct = parsed.product || product;
        const draft = resolvedProduct === 'futures' ? createFuturesDraft(parsed.intent) : resolvedProduct === 'margin' ? createMarginDraft(parsed.intent) : await createDraft(parsed.intent);
        if (resolvedProduct === 'futures' && parsed.directExecute === true && directExecutionRequested(message)) {
          if (!liveTradingEnabled) return sendJson(response, 403, { error: 'Live trading is locked.' });
          draft.state = 'submitting';
          try { const order = await executeFuturesDraft(draft); draft.state = 'submitted'; return sendJson(response, 200, { reply: parsed.reply || '订单已直接提交。', product: resolvedProduct, order }); }
          catch (error) { draft.state = error instanceof BinanceApiError && error.executionUnknown ? 'unknown' : 'failed'; throw error; }
        }
        return sendJson(response, 200, { reply: parsed.reply || '订单草案已准备好。请核对产品、方向、数量、杠杆和保证金模式后确认。', product: resolvedProduct, draft });
      }
      const confirm = request.url?.match(/^\/api\/orders\/([^/]+)\/confirm$/);
      if (request.method === 'POST' && confirm) {
        const payload = await body(request);
        const draft = drafts.get(confirm[1]);
        if (!draft || Date.now() - draft.createdAt > 5 * 60_000) return sendJson(response, 404, { error: 'Order draft expired or was not found.' });
        if (draft.state !== 'pending') return sendJson(response, 409, { error: 'This order draft was already handled.' });
        if (payload.confirmation !== 'CONFIRM' || payload.confirmationToken !== draft.confirmationToken) return sendJson(response, 400, { error: 'Explicit confirmation for this exact order draft is required.' });
        if (environment === 'live' && !liveTradingEnabled) return sendJson(response, 403, { error: 'Live trading is locked. Set BINANCE_LIVE_TRADING=true only after completing the safety checklist.' });
        draft.state = 'submitting';
        try {
          const order = await binance.placeOrder({ ...draft.intent, newClientOrderId: `ea_${draft.id.replaceAll('-', '').slice(0, 28)}` });
          draft.state = 'submitted';
          return sendJson(response, 200, { order });
        } catch (error) {
          draft.state = error instanceof BinanceApiError && error.executionUnknown ? 'unknown' : 'failed';
          throw error;
        }
      }
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const errorLog = { event: 'request_error', requestId, method: request.method, url: request.url, totalMs: Date.now() - requestStartedAt, error: error instanceof Error ? error.message : String(error) };
      console.error(JSON.stringify(errorLog));
      void saveChatLog(errorLog).catch(() => {});
      const result = publicError(error);
      return sendJson(response, result.status, { error: result.message });
    }
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const server = createCryptoServer(); let stopMarketStream; let gmailRenewTimer;
  let whiteHouseTimer;
  server.listen(port, '127.0.0.1', async () => {
    console.log(`CryptoAgent API listening on http://127.0.0.1:${port} (${environment})`); void syncMarketMessages().catch((error) => console.warn('Initial market message sync unavailable', error.message)); stopMarketStream = startMarketStream();
    try { const status = await gmailStatus(); if (status.configured && status.authorized) { await renewGmailWatch(); gmailRenewTimer = setInterval(() => renewGmailWatch().catch((error) => console.error('Gmail watch renewal failed', error.message)), 24 * 60 * 60_000); } } catch (error) { console.error('Gmail startup sync unavailable', error.message); }
    collectWhiteHouse({ onRelevant: handleWhiteHouseItem }).catch((error) => console.error('White House collection failed', error.message)); whiteHouseTimer = setInterval(() => collectWhiteHouse({ onRelevant: handleWhiteHouseItem }).catch((error) => console.error('White House collection failed', error.message)), 10 * 60_000);
  });
  server.on('close', () => { stopMarketStream?.(); if (gmailRenewTimer) clearInterval(gmailRenewTimer); if (whiteHouseTimer) clearInterval(whiteHouseTimer); });
}

export { coinMFunding, coinMKlineRow };
