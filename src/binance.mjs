import { createHmac } from 'node:crypto';

const BASE_URLS = {
  testnet: 'https://testnet.binance.vision',
  live: 'https://api.binance.com',
};
const FUTURES_BASE_URLS = { testnet: 'https://testnet.binancefuture.com', live: 'https://fapi.binance.com' };

function compactParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

export function signQuery(params, secretKey) {
  const query = new URLSearchParams(compactParams(params)).toString();
  const signature = createHmac('sha256', secretKey).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

export class BinanceApiError extends Error {
  constructor(message, { status, code, executionUnknown = false } = {}) {
    super(message);
    this.name = 'BinanceApiError';
    this.status = status;
    this.code = code;
    this.executionUnknown = executionUnknown;
  }
}

export function createBinanceSpotClient({ apiKey, secretKey, environment = 'testnet', fetchImpl = fetch, now = Date.now, recvWindow = 5_000 } = {}) {
  const baseUrl = BASE_URLS[environment];
  if (!baseUrl) throw new Error('Binance environment must be testnet or live.');
  let clockOffset = 0;
  let clockSynced = false;

  async function request(method, path, params = {}, signed = false) {
    if (signed && (!apiKey || !secretKey)) throw new BinanceApiError('Binance API credentials are not configured.', { status: 503 });
    if (signed && !clockSynced) {
      const { serverTime } = await request('GET', '/api/v3/time');
      clockOffset = Number(serverTime) - now();
      clockSynced = true;
    }
    const values = signed ? { ...params, recvWindow, timestamp: now() + clockOffset } : params;
    const query = signed ? signQuery(values, secretKey) : new URLSearchParams(compactParams(values)).toString();
    const response = await fetchImpl(`${baseUrl}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: signed ? { 'X-MBX-APIKEY': apiKey } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const executionUnknown = response.status >= 500 && method !== 'GET';
      throw new BinanceApiError(body.msg || `Binance request failed (${response.status}).`, { status: response.status, code: body.code, executionUnknown });
    }
    return body;
  }

  return {
    environment,
    ping: () => request('GET', '/api/v3/ping'),
    ticker: (symbol) => request('GET', '/api/v3/ticker/bookTicker', { symbol }),
    prices: () => request('GET', '/api/v3/ticker/price'),
    klines: (symbol, interval = '1m', limit = 120) => request('GET', '/api/v3/klines', { symbol, interval, limit }),
    exchangeInfo: (symbol) => request('GET', '/api/v3/exchangeInfo', { symbol }),
    account: () => request('GET', '/api/v3/account', { omitZeroBalances: true }, true),
    fundingAsset: () => request('POST', '/sapi/v1/asset/get-funding-asset', {}, true),
    walletBalance: (quoteAsset = 'USDT') => request('GET', '/sapi/v1/asset/wallet/balance', { quoteAsset }, true),
    earnFlexible: (size = 100) => request('GET', '/sapi/v1/simple-earn/flexible/position', { size }, true),
    testOrder: (order) => request('POST', '/api/v3/order/test', order, true),
    placeOrder: (order) => request('POST', '/api/v3/order', order, true),
  };
}

export function createBinanceUsdMClient({ apiKey, secretKey, environment = 'testnet', fetchImpl = fetch, now = Date.now, recvWindow = 5_000 } = {}) {
  const baseUrl = FUTURES_BASE_URLS[environment];
  if (!baseUrl) throw new Error('Binance environment must be testnet or live.');
  let clockOffset = 0; let clockSynced = false;
  async function request(method, path, params = {}, signed = false) {
    if (signed && (!apiKey || !secretKey)) throw new BinanceApiError('Binance API credentials are not configured.', { status: 503 });
    if (signed && !clockSynced) { const { serverTime } = await request('GET', '/fapi/v1/time'); clockOffset = Number(serverTime) - now(); clockSynced = true; }
    const values = signed ? { ...params, recvWindow, timestamp: now() + clockOffset } : params;
    const query = signed ? signQuery(values, secretKey) : new URLSearchParams(compactParams(values)).toString();
    const response = await fetchImpl(`${baseUrl}${path}${query ? `?${query}` : ''}`, { method, headers: signed ? { 'X-MBX-APIKEY': apiKey } : undefined, signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const executionUnknown = response.status >= 500 && method !== 'GET'; throw new BinanceApiError(body.msg || `Binance request failed (${response.status}).`, { status: response.status, code: body.code, executionUnknown }); }
    return body;
  }
  return {
    environment,
    exchangeInfo: (symbol) => request('GET', '/fapi/v1/exchangeInfo', symbol ? { symbol } : {}),
    ticker: (symbol) => request('GET', '/fapi/v1/ticker/bookTicker', { symbol }),
    account: () => request('GET', '/fapi/v2/account', {}, true),
    assetAccount: () => request('GET', '/fapi/v3/account', {}, true),
    positionRisk: (symbol) => request('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {}, true),
    userTrades: (symbol, limit = 50) => request('GET', '/fapi/v1/userTrades', { symbol, limit }, true),
    leverage: (symbol, leverage) => request('POST', '/fapi/v1/leverage', { symbol, leverage }, true),
    marginType: (symbol, marginType) => request('POST', '/fapi/v1/marginType', { symbol, marginType }, true),
    testOrder: (order) => request('POST', '/fapi/v1/order/test', order, true),
    placeOrder: (order) => request('POST', '/fapi/v1/order', order, true),
  };
}

export function createBinanceMarginClient({ apiKey, secretKey, environment = 'testnet', fetchImpl = fetch, now = Date.now, recvWindow = 5_000 } = {}) {
  const baseUrl = BASE_URLS[environment];
  if (!baseUrl) throw new Error('Binance environment must be testnet or live.');
  let clockOffset = 0; let clockSynced = false;
  async function request(method, path, params = {}, signed = false) {
    if (signed && (!apiKey || !secretKey)) throw new BinanceApiError('Binance API credentials are not configured.', { status: 503 });
    if (signed && !clockSynced) { const { serverTime } = await request('GET', '/api/v3/time'); clockOffset = Number(serverTime) - now(); clockSynced = true; }
    const values = signed ? { ...params, recvWindow, timestamp: now() + clockOffset } : params;
    const query = signed ? signQuery(values, secretKey) : new URLSearchParams(compactParams(values)).toString();
    const response = await fetchImpl(`${baseUrl}${path}${query ? `?${query}` : ''}`, { method, headers: signed ? { 'X-MBX-APIKEY': apiKey } : undefined, signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const executionUnknown = response.status >= 500 && method !== 'GET'; throw new BinanceApiError(body.msg || `Binance request failed (${response.status}).`, { status: response.status, code: body.code, executionUnknown }); }
    return body;
  }
  return {
    environment,
    account: () => request('GET', '/sapi/v1/margin/account', {}, true),
    order: (order) => request('POST', '/sapi/v1/margin/order', order, true),
    borrow: (params) => request('POST', '/sapi/v1/margin/loan', params, true),
    repay: (params) => request('POST', '/sapi/v1/margin/repay', params, true),
  };
}
