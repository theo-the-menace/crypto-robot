import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAssetBalances } from '../src/asset-summary.ts';

test('aggregates each asset across account types and ignores LD wrappers', () => {
  const rows = aggregateAssetBalances({
    spot: [{ asset: 'USDT', free: '10', locked: '1' }, { asset: 'LDUSDT', free: '99', locked: '0' }, { asset: 'BTC', free: '1', locked: '0' }],
    funding: [{ asset: 'USDT', free: '2', locked: '1', freeze: '0.5' }],
    earn: [{ asset: 'USDT', totalAmount: '3' }],
    futures: [{ asset: 'USDT', walletBalance: '5' }],
    prices: { BTC: 60000 },
  });
  assert.deepEqual(rows.find((item) => item.asset === 'USDT'), { asset: 'USDT', spot: 11, funding: 3.5, earn: 3, futures: 5, total: 22.5, price: 1, estimatedUsdt: 22.5 });
  assert.equal(rows.find((item) => item.asset === 'BTC')?.estimatedUsdt, 60000);
  assert.equal(rows.some((item) => item.asset === 'LDUSDT'), false);
});
