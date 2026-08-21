import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeKlines, readMarketCache, writeMarketCache } from './market-cache.mjs';

test('merges and persists one shared minute series', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crypto-market-cache-'));
  try {
    const rows = mergeKlines([[60_000, 1]], [[0, 0], [60_000, 2]]);
    await writeMarketCache(directory, 'BTCUSD_PERP', rows);
    assert.deepEqual(await readMarketCache(directory, 'BTCUSD_PERP'), [[0, 0], [60_000, 2]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
