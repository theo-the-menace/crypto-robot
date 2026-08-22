import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketStore } from './market-store.mjs';

test('reads immutable month snapshots and atomically overlays runtime rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-store-')); const snapshot = join(root, 'data'); const runtime = join(root, 'cache');
  try {
    const directory = join(snapshot, 'BTCUSD_PERP', '1m'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '2026-08.json'), JSON.stringify([[Date.UTC(2026, 7, 1), 1], [Date.UTC(2026, 7, 1, 0, 1), 2]]));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ months: ['2026-08'], firstTime: Date.UTC(2026, 7, 1), lastTime: Date.UTC(2026, 7, 1, 0, 1) }));
    await mkdir(join(snapshot, 'BTCUSD_PERP', 'derived'), { recursive: true }); await writeFile(join(snapshot, 'BTCUSD_PERP', 'derived', '1d.json'), '[]');
    const store = new MarketStore({ runtimeDirectory: runtime, snapshotDirectory: snapshot });
    await store.merge([[Date.UTC(2026, 7, 1, 0, 1), 2.5]], { persist: false });
    await assert.rejects(() => readFile(join(runtime, 'BTCUSD_PERP', '1m', '2026-08.json')));
    await store.merge([[Date.UTC(2026, 7, 1, 0, 1), 3], [Date.UTC(2026, 7, 1, 0, 2), 4]]);
    assert.deepEqual(await store.window(Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 1, 0, 2)), [[Date.UTC(2026, 7, 1), 1], [Date.UTC(2026, 7, 1, 0, 1), 3], [Date.UTC(2026, 7, 1, 0, 2), 4]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
