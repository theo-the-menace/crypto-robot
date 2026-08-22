import { execFileSync } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const symbol = 'BTCUSD_PERP';
const directory = join('data', 'quant', 'binance-vision', 'cm', 'fundingRate', symbol);
const legacyDirectory = join('.cache', 'quant', 'binance-vision', 'cm', 'fundingRate', symbol);
const first = new Date(Date.UTC(2020, 7, 1));
const today = new Date();
const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

await mkdir(directory, { recursive: true });
for (const name of await readdir(legacyDirectory).catch(() => [])) {
  if (!name.endsWith('.zip')) continue;
  const file = join(legacyDirectory, name);
  execFileSync('unzip', ['-oq', file, '-d', directory]);
  await rm(file);
}

for (let month = first; month < last; month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
  const stamp = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
  const name = `${symbol}-fundingRate-${stamp}.zip`;
  const file = join(directory, name);
  const csv = file.replace(/\.zip$/, '.csv');
  try { await access(csv); continue; } catch {}
  const url = `https://data.binance.vision/data/futures/cm/monthly/fundingRate/${symbol}/${name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) continue;
  if (!response.ok) throw new Error(`Binance Vision returned ${response.status} for ${name}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`${name} is not a ZIP archive.`);
  await mkdir(directory, { recursive: true });
  await writeFile(file, bytes);
  execFileSync('unzip', ['-oq', file, '-d', directory]);
  await rm(file);
  console.log(`downloaded ${name.replace(/\.zip$/, '.csv')}`);
}
