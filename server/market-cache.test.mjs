import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeKlines, readFundingCache, readMarketCache, writeFundingCache, writeMarketCache } from './market-cache.mjs';

test('merges and persists one shared minute series', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crypto-market-cache-'));
  try {
    const rows = mergeKlines([[60_000, 1]], [[0, 0], [60_000, 2]]);
    await writeMarketCache(directory, 'BTCUSD_PERP', rows);
    assert.deepEqual(await readMarketCache(directory, 'BTCUSD_PERP'), [[0, 0], [60_000, 2]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('allows concurrent atomic cache writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crypto-market-cache-'));
  try {
    await Promise.all([writeMarketCache(directory, 'BTCUSD_PERP', [[0, 1]]), writeMarketCache(directory, 'BTCUSD_PERP', [[60_000, 2]])]);
    assert.equal((await readMarketCache(directory, 'BTCUSD_PERP')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persists funding history separately from minute candles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crypto-funding-cache-'));
  try {
    const rows = [{ symbol: 'BTCUSD_PERP', fundingTime: 1_000, fundingRate: '0.0001' }];
    await writeFundingCache(directory, 'BTCUSD_PERP', rows);
    assert.deepEqual(await readFundingCache(directory, 'BTCUSD_PERP'), rows);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
