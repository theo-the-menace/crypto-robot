import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directory = join('data', 'market', 'BTCUSD_PERP', '1m');
const files = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}\.json$/.test(name)).sort();
let rows = 0; let gaps = 0; let first; let last; let previous;
for (const name of files) for (const row of JSON.parse(await readFile(join(directory, name), 'utf8'))) {
  const time = Number(row[0]);
  if (!Number.isFinite(time) || row.length < 8 || !row.slice(1, 8).every((value) => Number.isFinite(Number(value)))) throw new Error(`Invalid row in ${name}`);
  if (previous != null && time - previous !== 60_000) { gaps += 1; console.error(`gap: ${new Date(previous).toISOString()} -> ${new Date(time).toISOString()}`); }
  first ??= time; previous = time; last = time; rows += 1;
}
if (gaps) throw new Error(`Market data has ${gaps} gap(s).`);
console.log(JSON.stringify({ interval: '1m', files: files.length, rows, gaps, firstTime: new Date(first).toISOString(), lastTime: new Date(last).toISOString() }, null, 2));
