import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function mergeKlines(current, incoming) {
  return [...new Map([...current, ...incoming].map((row) => [Number(row[0]), row])).values()].sort((left, right) => Number(left[0]) - Number(right[0]));
}

export function marketCacheFile(directory, symbol) {
  return join(directory, `${symbol.replaceAll(/[^A-Z0-9_]/g, '')}-1m.json`);
}

export async function readMarketCache(directory, symbol) {
  try {
    const rows = JSON.parse(await readFile(marketCacheFile(directory, symbol), 'utf8'));
    return Array.isArray(rows) ? rows.filter((row) => Array.isArray(row) && Number.isFinite(Number(row[0]))) : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeMarketCache(directory, symbol, rows) {
  await mkdir(directory, { recursive: true });
  const file = marketCacheFile(directory, symbol);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(rows), 'utf8');
  await rename(temporary, file);
}
