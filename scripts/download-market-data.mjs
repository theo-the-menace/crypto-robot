import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const base = String(process.env.MARKET_DATA_DOWNLOAD_URL || '').replace(/\/$/, '');
if (!base) throw new Error('Set MARKET_DATA_DOWNLOAD_URL before running `npm run download:market-data`.');
const headers = process.env.MARKET_DATA_API_KEY ? { Authorization: `Bearer ${process.env.MARKET_DATA_API_KEY}` } : {};
const root = join('data', 'market');
const get = async (path) => {
  const response = await fetch(`${base}/${path}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Market data download failed (${response.status}): ${path}`);
  return response.text();
};
const save = async (path, text) => { const file = join(root, path); const temporary = `${file}.${randomUUID()}.tmp`; await mkdir(dirname(file), { recursive: true }); await writeFile(temporary, text); await rename(temporary, file); };
const manifestPath = 'BTCUSD_PERP/1m/manifest.json';
const manifestText = await get(manifestPath); const manifest = JSON.parse(manifestText);
const local = JSON.parse(await readFile(join(root, manifestPath), 'utf8').catch(() => '{}')); const current = new Date().toISOString().slice(0, 7);
for (const month of manifest.months || []) {
  if (month !== current && local.months?.includes(month)) { console.log(`kept ${month}`); continue; }
  await save(`BTCUSD_PERP/1m/${month}.json`, await get(`BTCUSD_PERP/1m/${month}.json`)); console.log(`downloaded ${month}`);
}
for (const interval of ['5m', '15m', '1h', '4h', '1d', '1w']) await save(`BTCUSD_PERP/derived/${interval}.json`, await get(`BTCUSD_PERP/derived/${interval}.json`));
await save(manifestPath, manifestText);
console.log(`market data ready: ${manifest.rows || 0} rows across ${(manifest.months || []).length} months`);
