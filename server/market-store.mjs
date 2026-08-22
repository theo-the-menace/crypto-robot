import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mergeKlines } from './market-cache.mjs';
import { aggregateMarketKlines } from './market-aggregate.mjs';

const monthKey = (time) => { const date = new Date(Number(time)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; };
const monthRange = (month) => { const [year, value] = month.split('-').map(Number); return [Date.UTC(year, value - 1, 1), Date.UTC(year, value, 1) - 1]; };

export class MarketStore {
  constructor({ runtimeDirectory, snapshotDirectory, symbol = 'BTCUSD_PERP' }) {
    this.runtimeDirectory = join(runtimeDirectory, symbol, '1m');
    this.snapshotDirectory = join(snapshotDirectory, symbol, '1m');
    this.symbol = symbol;
    this.derivedDirectory = join(snapshotDirectory, symbol, 'derived');
    this.cache = new Map();
    this.overlays = new Map();
    this.derived = new Map();
  }

  async readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
  runtimeFile(month) { return join(this.runtimeDirectory, `${month}.json`); }
  snapshotFile(month) { return join(this.snapshotDirectory, `${month}.json`); }
  remember(month, rows) {
    this.cache.delete(month); this.cache.set(month, rows);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
  }
  async derivedRows(interval) {
    if (this.derived.has(interval)) return this.derived.get(interval);
    const rows = await this.readJson(join(this.derivedDirectory, `${interval}.json`)) || [];
    this.derived.set(interval, rows);
    while (this.derived.size > 3) this.derived.delete(this.derived.keys().next().value);
    return rows;
  }

  async manifest() {
    const snapshot = await this.readJson(join(this.snapshotDirectory, 'manifest.json')) || { months: [] };
    const current = monthKey(Date.now());
    const months = [...new Set([...(snapshot.months || []), current])].sort();
    const rows = [];
    for (const month of months) { const [from, to] = monthRange(month); rows.push({ month, from, to, mutable: month === current }); }
    return { symbol: this.symbol, interval: '1m', firstTime: snapshot.firstTime ?? rows[0]?.from ?? null, lastTime: Number((await this.month(current)).at(-1)?.[0] ?? snapshot.lastTime ?? 0) || null, months: rows };
  }

  async month(month) {
    if (this.cache.has(month)) return this.cache.get(month);
    const snapshot = await this.readJson(this.snapshotFile(month)) || [];
    const runtime = await this.readJson(this.runtimeFile(month)) || [];
    this.overlays.set(month, runtime);
    const rows = mergeKlines(snapshot, runtime);
    this.remember(month, rows);
    return rows;
  }

  async window(from, to, limit = Infinity) {
    const months = (await this.manifest()).months.filter((item) => item.to >= from && item.from <= to);
    const rows = [];
    for (const { month } of [...months].reverse()) {
      rows.unshift(...(await this.month(month)).filter((row) => Number(row[0]) >= from && Number(row[0]) <= to));
      if (rows.length >= limit) break;
    }
    return rows.slice(-limit);
  }

  async tail(limit = 1_000, endTime = Date.now()) {
    const manifest = await this.manifest(); const rows = [];
    for (const { month } of [...manifest.months].reverse()) {
      rows.unshift(...(await this.month(month)).filter((row) => Number(row[0]) <= endTime));
      if (rows.length >= limit) break;
    }
    return rows.slice(-limit);
  }

  async interval(interval, from, to, limit) {
    if (interval === '1m') return this.window(from, to, limit);
    const historical = await this.derivedRows(interval);
    const currentMonth = monthKey(Date.now()); const [currentFrom] = monthRange(currentMonth);
    const currentDate = new Date(currentFrom); const liveFrom = interval === '1w' ? Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate() - (currentDate.getUTCDay() + 6) % 7) : currentFrom;
    const fixed = historical.filter((row) => Number(row[0]) >= from && Number(row[0]) <= to && Number(row[0]) < liveFrom);
    const live = aggregateMarketKlines(await this.window(Math.max(from, liveFrom), to), interval);
    return mergeKlines(fixed, live).slice(-limit);
  }

  async merge(rows) {
    const grouped = new Map();
    for (const row of rows) { const month = monthKey(row[0]); grouped.set(month, [...(grouped.get(month) || []), row]); }
    for (const [month, incoming] of grouped) {
      const merged = mergeKlines(await this.month(month), incoming); const overlay = mergeKlines(this.overlays.get(month) || [], incoming);
      this.remember(month, merged);
      this.overlays.set(month, overlay);
      await mkdir(this.runtimeDirectory, { recursive: true });
      const file = this.runtimeFile(month); const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(overlay), 'utf8'); await rename(temporary, file);
    }
  }
}

export { monthKey };
