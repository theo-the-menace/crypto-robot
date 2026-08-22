import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateMarketKlines } from '../server/market-aggregate.mjs';

const run = promisify(execFile);
const symbol = 'BTCUSD_PERP';
const root = join('data', 'market', symbol);
const directory = join(root, '1m');
const first = new Date(Date.UTC(2020, 7, 1));
const stop = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const urlFor = (stamp) => `https://data.binance.vision/data/futures/cm/monthly/klines/${symbol}/1m/${symbol}-1m-${stamp}.zip`;
const dailyUrlFor = (day, kind = 'klines') => `https://data.binance.vision/data/futures/cm/daily/${kind}/${symbol}/${kind === 'klines' ? '1m/' : ''}${symbol}-${kind === 'klines' ? '1m-' : `${kind}-`}${day}.zip`;
const stampFor = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const checkedBytes = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) }); if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer()); const checksum = await fetch(`${url}.CHECKSUM`, { signal: AbortSignal.timeout(30_000) }).then((value) => value.ok ? value.text() : ''); const expected = checksum.trim().split(/\s+/)[0];
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Vision checksum failed for ${url}`); return { bytes, expected };
};
const unzipRows = async (url, archive, csv) => { const file = await checkedBytes(url); if (!file) return null; await writeFile(archive, file.bytes); await run('unzip', ['-oq', archive, '-d', '/tmp']); return { rows: (await readFile(csv, 'utf8')).split(/\r?\n/).filter((line) => /^\d+,/.test(line)).map((line) => line.split(',').map((value) => value === 'false' ? 0 : value === 'true' ? 1 : Number(value))), checksum: file.expected }; };
const aggregateTrades = (trades) => {
  const minutes = new Map();
  for (const trade of trades) { const price = trade[1]; const quantity = trade[2]; const time = Math.floor(trade[5] / 60_000) * 60_000; const count = trade[4] - trade[3] + 1; const takerBuy = trade[6] === 0; let row = minutes.get(time); if (!row) { row = [time, price, price, price, price, 0, time + 59_999, 0, 0, 0, 0, 0]; minutes.set(time, row); } row[2] = Math.max(row[2], price); row[3] = Math.min(row[3], price); row[4] = price; row[5] += quantity; row[7] += quantity * 100 / price; row[8] += count; if (takerBuy) { row[9] += quantity; row[10] += quantity * 100 / price; } }
  return [...minutes.values()].map((row) => row.map((value, index) => index === 7 || index === 10 ? Number(value.toFixed(8)) : value));
};
const fillVisionGaps = async (rows, stamp) => {
  const result = [...rows]; const [year, month] = stamp.split('-').map(Number); let cursor = stamp === '2020-08' ? Number(result[0]?.[0]) : Date.UTC(year, month - 1, 1); const last = Date.UTC(year, month, 1) - 60_000; const present = new Set(result.map((row) => Number(row[0])));
  while (cursor <= last) { if (!present.has(cursor)) { const day = new Date(cursor).toISOString().slice(0, 10); const archive = `/tmp/${symbol}-${day}.zip`; let daily = await unzipRows(dailyUrlFor(day), archive, `/tmp/${symbol}-1m-${day}.csv`); if (!daily) { daily = await unzipRows(dailyUrlFor(day, 'aggTrades'), archive, `/tmp/${symbol}-aggTrades-${day}.csv`); if (daily) daily.rows = aggregateTrades(daily.rows); } if (!daily?.rows.length) throw new Error(`Vision has no source for ${day}`); result.push(...daily.rows); for (const row of daily.rows) present.add(Number(row[0])); cursor = Number(daily.rows.at(-1)[0]); } cursor += 60_000; }
  return result.sort((a, b) => Number(a[0]) - Number(b[0]));
};
const completeMonth = (rows, stamp) => { const [year, month] = stamp.split('-').map(Number); const first = stamp === '2020-08' ? Number(rows[0]?.[0]) : Date.UTC(year, month - 1, 1); const last = Date.UTC(year, month, 1) - 60_000; return rows.length === Math.round((last - first) / 60_000) + 1 && Number(rows[0]?.[0]) === first && Number(rows.at(-1)?.[0]) === last; };

await mkdir(directory, { recursive: true });
const intervals = ['5m', '15m', '1h', '4h', '1d', '1w'];
const derivedRows = Object.fromEntries(intervals.map((interval) => [interval, []]));
const previousManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8').catch(() => '{}'));
const manifest = { symbol, interval: '1m', rows: 0, firstTime: null, lastTime: null, months: [], vision: {} };
for (let date = new Date(first); date < stop; date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))) {
  const stamp = stampFor(date); const target = join(directory, `${stamp}.json`);
  let rows;
  try {
    if (!previousManifest.vision?.[stamp]) throw new Error('unverified source');
    rows = JSON.parse(await readFile(target, 'utf8')); if (!rows.length || !rows.every((row) => Number.isFinite(Number(row[0]))) || !completeMonth(rows, stamp)) throw new Error('invalid local rows');
    manifest.vision[stamp] = previousManifest.vision[stamp]; console.log(`verified ${stamp}`);
  }
  catch {
    const archive = `/tmp/${symbol}-1m-${stamp}.zip`; const csv = `/tmp/${symbol}-1m-${stamp}.csv`;
    const monthly = await unzipRows(urlFor(stamp), archive, csv); if (!monthly) { console.log(`missing ${stamp}`); continue; }
    rows = await fillVisionGaps(monthly.rows, stamp);
    const temporary = `${target}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(rows)); await rename(temporary, target); manifest.vision[stamp] = monthly.checksum; console.log(`replaced ${stamp} from Vision`);
  }
  if (!Array.isArray(rows) || !rows.length || !rows.every((row) => Number.isFinite(Number(row[0])))) throw new Error(`Invalid local market month: ${stamp}`);
  manifest.rows += rows.length; manifest.firstTime ??= Number(rows[0][0]); manifest.lastTime = Number(rows.at(-1)[0]); manifest.months.push(stamp);
  for (const interval of intervals) derivedRows[interval].push(...aggregateMarketKlines(rows, interval));
}
const currentStamp = stampFor(new Date());
try { const current = JSON.parse(await readFile(join(directory, `${currentStamp}.json`), 'utf8')); if (!manifest.months.includes(currentStamp) && current.length) { manifest.rows += current.length; manifest.lastTime = Number(current.at(-1)[0]); manifest.months.push(currentStamp); } } catch {}
const manifestFile = join(directory, 'manifest.json'); const manifestTemporary = `${manifestFile}.${process.pid}.tmp`; await writeFile(manifestTemporary, JSON.stringify(manifest, null, 2)); await rename(manifestTemporary, manifestFile);
const derived = join(root, 'derived'); await mkdir(derived, { recursive: true });
for (const interval of intervals) await writeFile(join(derived, `${interval}.json`), JSON.stringify(aggregateMarketKlines(derivedRows[interval], interval)));
console.log(`market history ready: ${manifest.rows} 1m rows`);
