import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBinanceMarginClient, createBinanceSpotClient, createBinanceUsdMClient, signQuery } from '../src/binance.mjs';

test('signQuery signs the exact encoded query', () => {
  const signed = signQuery({ symbol: 'BTCUSDT', side: 'BUY', note: 'a b' }, 'secret');
  const [query, signature] = signed.split('&signature=');
  assert.equal(query, 'symbol=BTCUSDT&side=BUY&note=a+b');
  assert.equal(signature, createHmac('sha256', 'secret').update(query).digest('hex'));
});

test('signed requests sync Binance time and keep credentials in headers', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/api/v3/time') ? { serverTime: 2_000 } : { balances: [] }), { status: 200 });
  };
  const client = createBinanceSpotClient({ apiKey: 'public', secretKey: 'private', fetchImpl, now: () => 1_000 });
  await client.account();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /timestamp=2000/);
  assert.match(calls[1].url, /signature=[a-f0-9]{64}$/);
  assert.equal(calls[1].options.headers['X-MBX-APIKEY'], 'public');
  assert.doesNotMatch(calls[1].url, /private/);
});

test('USD-M Futures client uses the Futures time and account endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(JSON.stringify(url.endsWith('/fapi/v1/time') ? { serverTime: 2_000 } : { totalWalletBalance: '100' }), { status: 200 }); };
  const client = createBinanceUsdMClient({ apiKey: 'public', secretKey: 'private', fetchImpl, now: () => 1_000 });
  await client.account();
  assert.match(calls[0], /testnet\.binancefuture\.com\/fapi\/v1\/time/);
  assert.match(calls[1], /\/fapi\/v2\/account\?/);
});

test('asset clients use the official signed wallet, earn, funding, and Futures endpoints', async () => {
  const spotCalls = [];
  const spot = createBinanceSpotClient({ apiKey: 'public', secretKey: 'private', now: () => 1_000, fetchImpl: async (url) => { spotCalls.push(url); return new Response(JSON.stringify(url.endsWith('/api/v3/time') ? { serverTime: 2_000 } : [])); } });
  await spot.fundingAsset();
  await spot.walletBalance('USDT');
  await spot.earnFlexible();
  await spot.prices();
  assert.match(spotCalls[1], /\/sapi\/v1\/asset\/get-funding-asset/);
  assert.match(spotCalls[2], /\/sapi\/v1\/asset\/wallet\/balance\?quoteAsset=USDT/);
  assert.match(spotCalls[3], /\/sapi\/v1\/simple-earn\/flexible\/position\?size=100/);
  assert.match(spotCalls[4], /\/api\/v3\/ticker\/price/);
  const futuresCalls = [];
  const futuresClient = createBinanceUsdMClient({ apiKey: 'public', secretKey: 'private', now: () => 1_000, fetchImpl: async (url) => { futuresCalls.push(url); return new Response(JSON.stringify(url.endsWith('/fapi/v1/time') ? { serverTime: 2_000 } : {})); } });
  await futuresClient.assetAccount();
  assert.match(futuresCalls[1], /\/fapi\/v3\/account/);
});

test('Margin client uses signed margin account and order endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(JSON.stringify(url.endsWith('/api/v3/time') ? { serverTime: 2_000 } : { userAssets: [] }), { status: 200 }); };
  const client = createBinanceMarginClient({ apiKey: 'public', secretKey: 'private', fetchImpl, now: () => 1_000 });
  await client.account();
  assert.match(calls[0], /\/api\/v3\/time/);
  assert.match(calls[1], /\/sapi\/v1\/margin\/account/);
});
