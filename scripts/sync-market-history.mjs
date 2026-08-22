import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateMarketKlines } from '../server/market-aggregate.mjs';

const run = promisify(execFile);
const symbol = 'BTCUSD_PERP';
const root = join('data', 'market', symbol);
const directory = join(root, '1m');
const first = new Date(Date.UTC(2020, 7, 1));
const stop = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const urlFor = (stamp) => `https://data.binance.vision/data/futures/cm/monthly/klines/${symbol}/1m/${symbol}-1m-${stamp}.zip`;
const stampFor = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

await mkdir(directory, { recursive: true });
const intervals = ['5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const derivedRows = Object.fromEntries(intervals.map((interval) => [interval, []]));
const manifest = { symbol, interval: '1m', rows: 0, firstTime: null, lastTime: null, months: [] };
for (let date = new Date(first); date < stop; date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))) {
  const stamp = stampFor(date); const target = join(directory, `${stamp}.json`);
  let rows;
  try { rows = JSON.parse(await readFile(target, 'utf8')); console.log(`kept ${stamp}`); }
  catch {
    const archive = `/tmp/${symbol}-1m-${stamp}.zip`; const csv = `/tmp/${symbol}-1m-${stamp}.csv`;
    const response = await fetch(urlFor(stamp), { signal: AbortSignal.timeout(120_000) });
    if (response.status === 404) { console.log(`missing ${stamp}`); continue; }
    if (!response.ok) throw new Error(`Vision returned ${response.status} for ${stamp}`);
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    await run('unzip', ['-oq', archive, '-d', '/tmp']);
    rows = (await readFile(csv, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => line.split(',').map((value) => Number.isFinite(Number(value)) ? Number(value) : value));
    await writeFile(target, JSON.stringify(rows)); console.log(`downloaded ${stamp}`);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Invalid local market month: ${stamp}`);
  manifest.rows += rows.length; manifest.firstTime ??= Number(rows[0][0]); manifest.lastTime = Number(rows.at(-1)[0]); manifest.months.push(stamp);
  for (const interval of intervals) derivedRows[interval].push(...aggregateMarketKlines(rows, interval));
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const derived = join(root, 'derived'); await mkdir(derived, { recursive: true });
for (const interval of intervals) await writeFile(join(derived, `${interval}.json`), JSON.stringify(aggregateMarketKlines(derivedRows[interval], interval)));
console.log(`market history ready: ${manifest.rows} 1m rows`);
