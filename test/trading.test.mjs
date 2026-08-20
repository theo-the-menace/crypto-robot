import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackIntent, hasUnsupportedRiskInstruction, inferProduct, normalizeOrderIntent, validateOrder } from '../src/trading.mjs';

const symbolInfo = {
  symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true, baseAsset: 'BTC', quoteAsset: 'USDT',
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '100.00000000', stepSize: '0.00001000' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '10.00000000', stepSize: '0.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5.00000000' },
  ],
};
const context = { symbolInfo, ticker: { askPrice: '50000', bidPrice: '49900' }, balances: [{ asset: 'USDT', free: '80' }, { asset: 'BTC', free: '0.01' }], maxOrderUsdt: 100 };

test('normalizes a market buy without inventing base quantity', () => {
  assert.deepEqual(normalizeOrderIntent({ symbol: 'btcusdt', side: 'buy', quoteOrderQty: 50 }), { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '50' });
  assert.equal(validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '50' }, context).baseQuantity, 0.001);
});

test('rejects orders above the independent notional limit', () => {
  assert.throws(() => validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '101' }, context), /exceeds the 100 USDT limit/);
});

test('supports wildcard symbols and an unlimited client-side notional', () => {
  const intent = normalizeOrderIntent({ symbol: 'DOGEUSDT', side: 'BUY', quoteOrderQty: '100000' }, { allowedSymbols: null });
  assert.equal(validateOrder(intent, { ...context, maxOrderUsdt: 0, balances: [{ asset: 'USDT', free: '100001' }] }).estimatedNotional, 100000);
});

test('rejects unsupported symbols and malformed decimal input', () => {
  assert.throws(() => normalizeOrderIntent({ symbol: 'DOGEUSDT', side: 'BUY', quoteOrderQty: '10' }), /allowlist/);
  assert.throws(() => normalizeOrderIntent({ symbol: 'BTCUSDT', side: 'SELL', quantity: '1e2' }), /positive decimal/);
});

test('fallback parser handles explicit Chinese spot instructions only', () => {
  assert.deepEqual(fallbackIntent('用 50 USDT 市价买入 BTC'), { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '50' });
  assert.deepEqual(fallbackIntent('卖出 0.001 BTC'), { symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: '0.001' });
  assert.equal(fallbackIntent('帮我买一点 BTC'), null);
});

test('high-risk leverage instructions never fall through to spot execution', () => {
  assert.equal(hasUnsupportedRiskInstruction('开20x全仓 BTC'), true);
  assert.equal(hasUnsupportedRiskInstruction('用 50 USDT 市价买入 BTC'), false);
});

test('routes chat instructions to the correct Binance product', () => {
  assert.equal(inferProduct('开20x全仓 BTC 永续多单'), 'futures');
  assert.equal(inferProduct('Margin 借币买 BTC'), 'margin');
  assert.equal(inferProduct('现货买入 BTC'), 'spot');
});
