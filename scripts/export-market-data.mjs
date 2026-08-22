import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateMarketKlines } from '../server/market-aggregate.mjs';

const source = join('.cache', 'market', 'BTCUSD_PERP-1m.json');
const directory = join('data', 'market', 'BTCUSD_PERP', '1m');
const rows = JSON.parse(await readFile(source, 'utf8'));
const months = new Map();

for (const row of rows) {
  const date = new Date(Number(row[0]));
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const bucket = months.get(month) || [];
  bucket.push(row);
  months.set(month, bucket);
}

await mkdir(directory, { recursive: true });
for (const [month, bucket] of months) await writeFile(join(directory, `${month}.json`), JSON.stringify(bucket));
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ symbol: 'BTCUSD_PERP', interval: '1m', rows: rows.length, firstTime: Number(rows[0]?.[0]), lastTime: Number(rows.at(-1)?.[0]), months: [...months.keys()] }, null, 2));
const derived = join('data', 'market', 'BTCUSD_PERP', 'derived'); await mkdir(derived, { recursive: true });
for (const interval of ['5m', '15m', '1h', '4h', '1d', '1w', '1M']) await writeFile(join(derived, `${interval}.json`), JSON.stringify(aggregateMarketKlines(rows, interval)));
