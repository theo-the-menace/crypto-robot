import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, TickMarkType } from "lightweight-charts";
import { bollinger, carryForward, ema, sma, type IndicatorPoint } from "./chart-data";
import { readMarketWindow, writeMarketWindow } from "./market-db";

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number };
type Funding = { lastFundingRate?: string; nextFundingTime?: number; markPrice?: string; indexPrice?: string };
type Line = { kind: "input" | "output" | "error"; text: string };
type Dashboard = { service: { environment: string; mode: string; healthy: boolean }; strategies: Array<{ name: string; status: string; symbol: string }>; recentOrders: Array<{ state: string; symbol: string; client_order_id: string }>; risk: { allowedSymbols: string[]; maxOrderUsdt: number }; orders: { unknown: number } };
type CoinMSnapshot = { syncedAt: number; positions: Array<{ symbol: string; positionAmt: string; entryPrice: string; markPrice: string; leverage: string; unrealizedProfit: string }>; trades: Array<{ orderId: number | string; side: string; price: string; qty: string; quoteQty?: string; commission: string; commissionAsset: string; realizedPnl?: string; time: number }>; income: Array<{ incomeType: string; income: string; asset: string; symbol?: string; time: number }>; openOrders: Array<{ orderId: number | string; side: string; type: string; price: string; origQty: string; status: string }>; orders: Array<{ orderId: number | string; side: string; type: string; price: string; origQty: string; executedQty: string; status: string; time: number }> };
type IndicatorName = "ma7" | "ma25" | "ma60" | "ma99" | "ema200" | "ema21" | "bb";
type TimeRange = { from: number; to: number; fromTime?: number; toTime?: number };
type TerminalUi = { interval: string; enabled: Record<IndicatorName, boolean>; ranges: Record<string, TimeRange> };

const BASE = __DASHBOARD_API_URL__;
const MARKET_BASE = "/api";
const TOKEN = __DASHBOARD_TOKEN__;
const intervals = [{ value: "time", label: "Time" }, { value: "1m", label: "1m" }, { value: "5m", label: "5m" }, { value: "15m", label: "15m" }, { value: "1h", label: "1h" }, { value: "4h", label: "4h" }, { value: "1d", label: "1d" }, { value: "1w", label: "1W" }];
const intervalMs: Record<string, number> = { time: 60_000, "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
const defaultVisible: Record<string, number> = { time: 180, "1m": 180, "5m": 180, "15m": 160, "1h": 140, "4h": 120, "1d": 120, "1w": 80 };
const intervalValues = new Set(intervals.map((item) => item.value));
const uiKey = "crypto-robot-terminal-ui-v6";
const chartLogKey = "crypto-robot-chart-switch-log-v1";
const chartTrace = (event: string, details: Record<string, unknown> = {}) => {
  const entry = { at: new Date().toISOString(), event, ...details };
  try {
    const current = JSON.parse(localStorage.getItem(chartLogKey) || "[]");
    const next = [...(Array.isArray(current) ? current : []).slice(-99), entry];
    const encoded = JSON.stringify(next);
    localStorage.setItem(chartLogKey, encoded.length > 256_000 ? JSON.stringify(next.slice(-25)) : encoded);
  } catch {}
  console.info("[chart]", entry);
};
const persistUi = (interval: string, enabled: Record<IndicatorName, boolean>, ranges: Record<string, TimeRange>) => {
  try { localStorage.setItem(uiKey, JSON.stringify({ interval, enabled, ranges })); }
  catch { try { localStorage.removeItem(uiKey); localStorage.removeItem(chartLogKey); localStorage.setItem(uiKey, JSON.stringify({ interval, enabled, ranges: {} })); } catch {} }
};
const parseRow = (row: Array<string | number>): Candle => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), quoteVolume: Number(row[7]) });
const merge = (left: Candle[], right: Candle[]) => [...new Map([...left, ...right].map((item) => [item.time, item])).values()].sort((a, b) => a.time - b.time);
const nearestIndex = (candles: Candle[], time: number, fallback: number) => { if (!candles.length || !Number.isFinite(time)) return fallback; let low = 0; let high = candles.length; while (low < high) { const middle = Math.floor((low + high) / 2); if (candles[middle].time < time) low = middle + 1; else high = middle; } return Math.min(candles.length - 1, low); };
const defaultEnabled: Record<IndicatorName, boolean> = { ma7: true, ma25: true, ma60: false, ma99: false, ema200: true, ema21: true, bb: false };
const savedUi = (): TerminalUi => {
  try {
    const value = JSON.parse(localStorage.getItem(uiKey) || "{}");
    return { interval: intervalValues.has(value.interval) ? value.interval : "5m", enabled: { ...defaultEnabled, ...(value.enabled || {}) }, ranges: Object.fromEntries(Object.entries(value.ranges || {}).flatMap(([key, range]: [string, any]) => intervalValues.has(key) && Number.isFinite(range?.from) && Number.isFinite(range?.to) && range.to > range.from && range.from > -1_000_000 && range.to < 10_000_000 && Number.isFinite(range.fromTime) && Number.isFinite(range.toTime) && range.toTime > range.fromTime ? [[key, range]] : [])) };
  } catch { return { interval: "5m", enabled: defaultEnabled, ranges: {} }; }
};
const rows = (candles: Candle[]) => candles.map((item) => [item.time, item.open, item.high, item.low, item.close, item.volume, item.time + 59_999, item.quoteVolume]);
const chinaTime = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const formatChinaTime = (time: number) => {
  const parts = Object.fromEntries(chinaTime.formatToParts(new Date(time * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${Number(parts.month)}-${Number(parts.day)} ${parts.hour}:${parts.minute}`;
};
const formatChinaTick = (time: number, type: TickMarkType) => {
  const parts = Object.fromEntries(chinaTime.formatToParts(new Date(time * 1000)).map((part) => [part.type, part.value]));
  if (type === TickMarkType.Year) return parts.year;
  if (type === TickMarkType.Month) return `${parts.year}-${Number(parts.month)}`;
  if (type === TickMarkType.DayOfMonth) return `${Number(parts.month)}-${Number(parts.day)}`;
  return `${parts.hour}:${parts.minute}`;
};
function Chart({ candles, loadOlder, line, indicators, initialRange, onRangeChange, period, active }: { candles: Candle[]; loadOlder: () => Promise<void>; line: boolean; indicators: Record<string, IndicatorPoint[]>; initialRange?: TimeRange; onRangeChange: (range: TimeRange) => void; period: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const series = useRef<any>(null);
  const volume = useRef<any>(null);
  const overlays = useRef<Record<string, any>>({});
  const previous = useRef<Candle[]>([]);
  const loading = useRef(false);
  const restoredRange = useRef(initialRange);
  const followLatest = useRef(true);
  const seriesKind = useRef<boolean | null>(null);
  const restoring = useRef(false);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastLoggedRange = useRef(0);

  useLayoutEffect(() => {
    if (!host.current) return;
    chart.current = createChart(host.current, { autoSize: true, localization: { locale: "en-CA", timeFormatter: (time: unknown) => formatChinaTime(Number(time)) }, layout: { background: { type: ColorType.Solid, color: "#10151c" }, textColor: "#8290a0" }, grid: { vertLines: { color: "#27313d" }, horzLines: { color: "#27313d" } }, rightPriceScale: { borderColor: "#33404d" }, timeScale: { borderColor: "#33404d", timeVisible: true, secondsVisible: false, rightOffset: 5, tickMarkFormatter: (time: unknown, type: TickMarkType) => formatChinaTick(Number(time), type) }, crosshair: { mode: 0 } });
    series.current = line ? chart.current.addSeries(AreaSeries, { lineColor: "#f6c945", topColor: "#f6c94566", bottomColor: "#f6c94500", lineWidth: 2 }) : chart.current.addSeries(CandlestickSeries, { upColor: "#39c58a", downColor: "#ef6672", borderVisible: false, wickUpColor: "#39c58a", wickDownColor: "#ef6672" });
    seriesKind.current = line;
    volume.current = chart.current.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const colors: Record<string, string> = { ma7: "#f6c945", ma25: "#58a6ff", ma60: "#c678dd", ma99: "#f08c46", ema200: "#f97316", ema21: "#22c55e", bbMiddle: "#aab6c5", bbUpper: "#64748b", bbLower: "#64748b" };
    for (const [name, color] of Object.entries(colors)) overlays.current[name] = chart.current.addSeries(LineSeries, { color, lineWidth: name.startsWith("bb") ? 1 : 2, lineStyle: name === "bbMiddle" ? 0 : 2, lastValueVisible: false, priceLineVisible: false });
    return () => { clearTimeout(restoreTimer.current); chart.current?.remove(); };
  }, []);

  useLayoutEffect(() => { clearTimeout(restoreTimer.current); restoring.current = false; previous.current = []; restoredRange.current = initialRange; followLatest.current = !initialRange; chartTrace("period-change", { period, saved: initialRange || null }); }, [period]);

  useLayoutEffect(() => {
    if (!series.current) return;
    if (seriesKind.current !== line) {
      chart.current.removeSeries(series.current);
      series.current = line ? chart.current.addSeries(AreaSeries, { lineColor: "#f6c945", topColor: "#f6c94566", bottomColor: "#f6c94500", lineWidth: 2 }) : chart.current.addSeries(CandlestickSeries, { upColor: "#39c58a", downColor: "#ef6672", borderVisible: false, wickUpColor: "#39c58a", wickDownColor: "#ef6672" });
      seriesKind.current = line;
      previous.current = [];
    }
    if (!candles.length) return;
    const bars = candles.map((item) => line ? { time: Math.floor(item.time / 1000) as any, value: item.close } : { time: Math.floor(item.time / 1000) as any, open: item.open, high: item.high, low: item.low, close: item.close });
    const volumes = candles.map((item) => ({ time: Math.floor(item.time / 1000) as any, value: item.volume, color: item.close >= item.open ? "#39c58a66" : "#ef667266" }));
    const old = previous.current;
    chartTrace("data-update", { period, old: old.length, next: candles.length, first: candles[0]?.time, last: candles.at(-1)?.time });
    const prepend = old.length && candles[0].time < old[0].time ? candles.findIndex((item) => item.time === old[0].time) : 0;
    const sameWindow = old.length === candles.length && old[0]?.time === candles[0].time && old.at(-2)?.time === candles.at(-2)?.time;
    const range = chart.current.timeScale().getVisibleLogicalRange();
    if (sameWindow) {
      if (range) restoring.current = true;
      series.current.update(bars.at(-1)); volume.current.update(volumes.at(-1));
      if (range) { chart.current.timeScale().setVisibleLogicalRange(range); clearTimeout(restoreTimer.current); restoreTimer.current = setTimeout(() => { restoring.current = false; }, 50); }
    }
    else {
      if (!old.length) restoring.current = true;
      series.current.setData(bars); volume.current.setData(volumes);
      if (!old.length) {
        const savedRange = restoredRange.current;
        followLatest.current = !savedRange || savedRange.to >= candles.length - 2;
        if (savedRange) {
          const hasAnchors = Number.isFinite(savedRange.fromTime) && Number.isFinite(savedRange.toTime);
          const fromIndex = hasAnchors ? nearestIndex(candles, savedRange.fromTime!, Math.max(0, candles.length - defaultVisible[period])) : savedRange.from;
          const toIndex = hasAnchors ? nearestIndex(candles, savedRange.toTime!, candles.length - 1) : savedRange.to;
          const width = Math.max(2, Math.min(candles.length, savedRange.to - savedRange.from));
          const safeFrom = Math.min(Math.max(0, fromIndex), Math.max(0, candles.length - 1));
          const safeTo = Math.min(Math.max(safeFrom + 1, toIndex), candles.length + 5);
          const target = { from: safeFrom, to: Math.min(candles.length + 5, Math.max(safeTo, safeFrom + width)) };
          chartTrace("restore-target", { period, saved: savedRange, target, candles: candles.length });
          restoring.current = true;
          chart.current.timeScale().setVisibleLogicalRange(target);
          clearTimeout(restoreTimer.current);
          restoreTimer.current = setTimeout(() => { restoring.current = false; chartTrace("restore-actual", { period, target, actual: chart.current.timeScale().getVisibleLogicalRange() }); }, 250);
        }
        else {
          const visible = Math.min(defaultVisible[period] || 160, bars.length);
          restoring.current = true;
          const target = { from: Math.max(0, bars.length - visible), to: bars.length + 5 };
          chart.current.timeScale().setVisibleLogicalRange(target);
          clearTimeout(restoreTimer.current);
          restoreTimer.current = setTimeout(() => { restoring.current = false; chartTrace("default-actual", { period, target, actual: chart.current.timeScale().getVisibleLogicalRange() }); }, 250);
        }
      }
      else if (prepend && range) chart.current.timeScale().setVisibleLogicalRange({ from: range.from + prepend, to: range.to + prepend });
      else if (old.length && range && followLatest.current && candles.length > old.length) {
        const added = candles.length - old.length;
        chart.current.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      } else if (old.length && range) chart.current.timeScale().setVisibleLogicalRange(range);
    }
    previous.current = candles;
  }, [candles, line, period]);

  useLayoutEffect(() => {
    for (const [name, series] of Object.entries(overlays.current)) series.setData((indicators[name] || []).map((point) => ({ time: Math.floor(point.time / 1000) as any, value: point.value })));
  }, [indicators]);

  useEffect(() => {
    const scale = chart.current?.timeScale();
    if (!scale) return;
    const check = async (range: { from: number; to: number } | null) => {
      if (!range || range.from > 250 || loading.current) return;
      loading.current = true;
      try { await loadOlder(); } finally { loading.current = false; }
    };
    scale.subscribeVisibleLogicalRangeChange(check);
    return () => scale.unsubscribeVisibleLogicalRangeChange(check);
  }, [loadOlder]);

  useEffect(() => {
    const scale = chart.current?.timeScale();
    if (!scale) return;
    const save = () => {
      if (!active) return;
      const logical = scale.getVisibleLogicalRange();
      if (restoring.current) return;
      if (logical && candles.length) followLatest.current = logical.to >= candles.length - 2;
      if (logical && Date.now() - lastLoggedRange.current > 500) { lastLoggedRange.current = Date.now(); chartTrace("range-change", { period, logical, followLatest: followLatest.current }); }
      const range = scale.getVisibleLogicalRange();
      const visible = scale.getVisibleRange();
      if (range && visible && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from) onRangeChange({ from: range.from, to: range.to, fromTime: Number(visible.from) * 1000, toTime: Number(visible.to) * 1000 });
    };
    scale.subscribeVisibleLogicalRangeChange(save);
    return () => scale.unsubscribeVisibleLogicalRangeChange(save);
  }, [active, candles.length, onRangeChange]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const pan = (event: WheelEvent) => {
      const range = chart.current?.timeScale().getVisibleLogicalRange();
      if (!range || (event.deltaX === 0 && event.deltaY === 0)) return;
      event.preventDefault();
      event.stopPropagation();
      const horizontalDominant = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!event.ctrlKey && horizontalDominant) {
        const offset = event.deltaX * (range.to - range.from) / Math.max(element.clientWidth, 1);
        chart.current.timeScale().setVisibleLogicalRange({ from: range.from + offset, to: range.to + offset });
        return;
      }
      if (event.ctrlKey && !event.deltaY) return;
      const visible = range.to - range.from;
      const minimumVisible = Math.min(candles.length, 2);
      if (event.deltaY < 0 && visible <= minimumVisible) return;
      const target = visible * Math.exp(event.deltaY / 500);
      const center = (range.from + range.to) / 2;
      const boundedTarget = Math.max(minimumVisible, target);
      chart.current.timeScale().setVisibleLogicalRange({ from: center - boundedTarget / 2, to: center + boundedTarget / 2 });
    };
    element.addEventListener("wheel", pan, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", pan, true);
  }, []);

  return <div className="market-chart" ref={host} />;
}

export function MarketTerminal() {
  const [initialUi] = useState(savedUi);
  const [interval, setIntervalValue] = useState(initialUi.interval);
  const [candleSets, setCandleSets] = useState<Record<string, Candle[]>>({});
  const [funding, setFunding] = useState<Funding | null>(null);
  const [daily, setDaily] = useState<Candle[]>([]);
  const [weekly, setWeekly] = useState<Candle[]>([]);
  const [enabled, setEnabled] = useState<Record<IndicatorName, boolean>>(initialUi.enabled);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [coinm, setCoinm] = useState<CoinMSnapshot | null>(null);
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const candles = candleSets[interval] || [];
  const candlesRef = useRef(candles);
  const rangesRef = useRef(initialUi.ranges);
  const input = useRef<HTMLInputElement>(null);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { const node = output.current; if (node) node.scrollTop = node.scrollHeight; }, [lines]);

  const history = useCallback(async (endTime?: number, limit = 5_000) => {
    const suffix = endTime ? `&endTime=${endTime}` : "";
    const response = await fetch(`${MARKET_BASE}/market/klines?symbol=BTCUSD_PERP&interval=${interval === "time" ? "1m" : interval}&limit=${limit}${suffix}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`history failed (${response.status})`);
    return (await response.json()).klines.map(parseRow) as Candle[];
  }, [interval]);
  const historyFor = useCallback(async (value: string, endTime?: number, limit = 5_000) => {
    const suffix = endTime ? `&endTime=${endTime}` : "";
    const response = await fetch(`${MARKET_BASE}/market/klines?symbol=BTCUSD_PERP&interval=${value === "time" ? "1m" : value}&limit=${limit}${suffix}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`history failed (${response.status})`);
    return (await response.json()).klines.map(parseRow) as Candle[];
  }, []);

  const window = useCallback(async (from: number, to: number) => {
    const value = interval === "time" ? "1m" : interval; const bucket = Math.max(intervalMs[interval] * 500, 86_400_000); const cachedFrom = Math.floor(from / bucket) * bucket; const cachedTo = Math.ceil(to / bucket) * bucket; const key = `${value}:${cachedFrom}:${cachedTo}`;
    const cached = await readMarketWindow(key).catch(() => null) as Array<Array<string | number>> | null;
    if (cached?.length) setCandleSets((current) => ({ ...current, [interval]: cached.map(parseRow) }));
    const response = await fetch(`${MARKET_BASE}/market/window?symbol=BTCUSD_PERP&interval=${value}&from=${cachedFrom}&to=${cachedTo}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`window failed (${response.status})`);
    const rows = (await response.json()).klines as Array<Array<string | number>>;
    void writeMarketWindow(key, rows).catch(() => {});
    return rows.map(parseRow) as Candle[];
  }, [interval]);

  const loadOlder = useCallback(async () => {
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    const rows = await history(oldest.time - 1);
    const latest = rows.at(-1);
    if (latest && latest.time < oldest.time) setCandleSets((current) => ({ ...current, [interval]: merge(rows, current[interval] || []) }));
  }, [history, interval]);
  const loadOlderFor = useCallback(async (value: string) => {
    const oldest = (candleSets[value] || [])[0];
    if (!oldest) return;
    const rows = await historyFor(value, oldest.time - 1);
    if (rows.at(-1) && rows.at(-1)!.time < oldest.time) setCandleSets((current) => ({ ...current, [value]: merge(rows, current[value] || []) }));
  }, [candleSets, historyFor]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = rangesRef.current[interval];
        const savedFrom = Number(saved?.fromTime); const savedTo = Number(saved?.toTime);
        const span = Number.isFinite(savedFrom) && Number.isFinite(savedTo) ? Math.max(savedTo - savedFrom, intervalMs[interval] * 100) : intervalMs[interval] * 500;
        const rows = Number.isFinite(savedFrom) && Number.isFinite(savedTo) ? await window(Math.max(0, savedFrom - span), savedTo + span) : await history(undefined, 1_000);
        if (!active) return;
        setCandleSets((current) => ({ ...current, [interval]: merge(current[interval] || [], rows) }));
      } catch (error) { setLines((current) => [...current, { kind: "error", text: error instanceof Error ? error.message : "history unavailable" }]); }
    })();
    return () => { active = false; };
  }, [history, interval, window]);

  useEffect(() => {
    const stream = new EventSource(`${MARKET_BASE}/market/stream?symbol=BTCUSD_PERP`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    stream.addEventListener("kline", (event) => {
      if (interval === "1m" || interval === "time") { try { const candle = parseRow(JSON.parse((event as MessageEvent).data).row); setCandleSets((current) => ({ ...current, [interval]: merge(current[interval] || [], [candle]) })); } catch {} return; }
      clearTimeout(timer); timer = setTimeout(() => { void history(undefined, 2).then((rows) => setCandleSets((current) => ({ ...current, [interval]: merge(current[interval] || [], rows) }))).catch(() => {}); }, 1_000);
    });
    return () => { clearTimeout(timer); stream.close(); };
  }, [history, interval]);

  useEffect(() => {
    const loadReference = async (value: "1d" | "1w", setValue: (rows: Candle[]) => void) => { try { const response = await fetch(`${MARKET_BASE}/market/klines?symbol=BTCUSD_PERP&interval=${value}&limit=5000`, { cache: "no-store" }); if (response.ok) setValue((await response.json()).klines.map(parseRow)); } catch {} };
    void loadReference("1d", setDaily); void loadReference("1w", setWeekly);
  }, []);

  const refreshCoinm = useCallback(async () => { try { const response = await fetch(`${MARKET_BASE}/coinm/snapshot?symbol=BTCUSD_PERP&limit=100`, { cache: "no-store" }); if (response.ok) { setCoinm(await response.json()); return true; } } catch {} return false; }, []);

  useEffect(() => {
    const refresh = async () => { try { const response = await fetch(`${MARKET_BASE}/market/funding?symbol=BTCUSD_PERP`, { cache: "no-store" }); if (response.ok) setFunding((await response.json()).premium || null); } catch {} };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 60_000); return () => clearInterval(timer);
  }, []);

  useEffect(() => { persistUi(interval, enabled, rangesRef.current); }, [interval, enabled]);
  useEffect(() => {
    if (!TOKEN) return;
    const refresh = async () => { try { const response = await fetch(`${BASE}/v1/dashboard`, { cache: "no-store", headers: { Authorization: `Bearer ${TOKEN}` } }); if (response.ok) setDashboard(await response.json()); } catch {} };
    void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer);
  }, []);

  const run = () => {
    const value = command.trim(); if (!value) return;
    const next: Line[] = [...lines, { kind: "input", text: `$ ${value}` }]; const [name, arg] = value.toLowerCase().split(/\s+/);
    if (name === "clear") next.splice(0);
    else if (name === "help") next.push({ kind: "output", text: "status\norders\nrisk\nstrategies\ncoinm | positions\ntrades\nfees\ntoday-fees\ncoinm-orders\nchart-log\nsync\ninterval <time|1m|5m|15m|1h|4h|1d|1w>\nclear" });
    else if (name === "chart-log") { try { next.push({ kind: "output", text: JSON.parse(localStorage.getItem(chartLogKey) || "[]").slice(-30).map((item: any) => JSON.stringify(item)).join("\n") || "no chart logs" }); } catch { next.push({ kind: "error", text: "chart log unavailable" }); } }
    else if (name === "sync") { next.push({ kind: "output", text: "syncing COIN-M..." }); void refreshCoinm().then((ok) => setLines((current) => [...current, { kind: (ok ? "output" : "error") as Line["kind"], text: ok ? "COIN-M synced" : "COIN-M sync failed" }].slice(-100))); }
    else if (name === "today-fees") {
      next.push({ kind: "output", text: "loading today's COIN-M fees..." });
      void fetch(`${MARKET_BASE}/coinm/today-fees?symbol=BTCUSD_PERP`, { cache: "no-store" }).then(async (response) => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `fees failed (${response.status}); restart the API server`); return data; }).then((data) => { const detail = Object.entries(data.byAsset || {}).map(([asset, amount]) => `${asset}: ${Number(amount).toFixed(8)} × ${data.prices?.[asset] ?? "?"} = ${data.prices?.[asset] == null ? "unpriced" : (Number(amount) * Number(data.prices[asset])).toFixed(4)} USDT`).join("\n"); setLines((current) => [...current, { kind: "output" as Line["kind"], text: `today ${data.symbol} realized pnl + commission\n${detail || "no realized pnl or commission"}\ntotal: ${Number(data.totalUsdt || 0).toFixed(4)} USDT${data.unpricedAssets?.length ? `\nunpriced: ${data.unpricedAssets.join(", ")}` : ""}` }].slice(-100)); }).catch((error) => setLines((current) => [...current, { kind: "error" as Line["kind"], text: error instanceof Error ? error.message : "today fees unavailable" }].slice(-100)));
    }
    else if (name === "status") next.push({ kind: "output", text: dashboard ? `${dashboard.service.environment} · ${dashboard.service.mode} · ${dashboard.service.healthy ? "healthy" : "offline"}` : "connecting" });
    else if (name === "strategies") next.push({ kind: "output", text: dashboard?.strategies.length ? dashboard.strategies.map((item) => `${item.status.padEnd(10)} ${item.symbol.padEnd(12)} ${item.name}`).join("\n") : "no active strategies" });
    else if (name === "orders") next.push({ kind: "output", text: dashboard?.recentOrders.length ? dashboard.recentOrders.map((item) => `${item.state.padEnd(18)} ${item.symbol} ${item.client_order_id}`).join("\n") : "no recent orders" });
    else if (name === "coinm" || name === "positions") next.push({ kind: "output", text: coinm?.positions.filter((item) => Number(item.positionAmt) !== 0).map((item) => `${item.symbol} ${item.positionAmt} @ ${item.entryPrice} mark ${item.markPrice} ${item.leverage}x PnL ${item.unrealizedProfit}`).join("\n") || "no open COIN-M positions" });
    else if (name === "fees") next.push({ kind: "output", text: coinm?.income.filter((item) => ["COMMISSION", "FUNDING_FEE", "REALIZED_PNL"].includes(item.incomeType)).map((item) => `${new Date(item.time).toLocaleString()} ${item.incomeType.padEnd(12)} ${item.income} ${item.asset} ${item.symbol || ""}`).join("\n") || "no COIN-M income records" });
    else if (name === "trades") next.push({ kind: "output", text: coinm?.trades.map((item) => `${new Date(item.time).toLocaleString()} ${item.side} ${item.qty} @ ${item.price} fee ${item.commission} ${item.commissionAsset} order ${item.orderId}`).join("\n") || "no COIN-M trades" });
    else if (name === "coinm-orders") next.push({ kind: "output", text: coinm?.orders.map((item) => `${new Date(item.time).toLocaleString()} ${item.status.padEnd(10)} ${item.side} ${item.origQty} ${item.type} @ ${item.price} filled ${item.executedQty} order ${item.orderId}`).join("\n") || "no COIN-M orders" });
    else if (name === "risk") next.push({ kind: "output", text: dashboard ? `symbols: ${dashboard.risk.allowedSymbols.join(", ")}\nmax order: ${dashboard.risk.maxOrderUsdt} USDT\nunknown orders: ${dashboard.orders.unknown}` : "connecting" });
    else if (name === "interval" && intervals.some((item) => item.value === arg)) selectInterval(arg);
    else if (name === "interval") next.push({ kind: "error", text: "usage: interval <time|1m|5m|15m|1h|4h|1d|1w>" });
    else next.push({ kind: "error", text: `unknown command: ${name}` });
    setLines(next.slice(-100)); setCommand("");
  };

  const fundingRate = Number(funding?.lastFundingRate);
  const nextFunding = funding?.nextFundingTime ? new Date(funding.nextFundingTime).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "--:--";
  const bb = bollinger(rows(candles));
  const indicators: Record<string, IndicatorPoint[]> = { ma7: enabled.ma7 ? sma(rows(candles), 7) : [], ma25: enabled.ma25 ? sma(rows(candles), 25) : [], ma60: enabled.ma60 ? sma(rows(candles), 60) : [], ma99: enabled.ma99 ? sma(rows(candles), 99) : [], ema200: enabled.ema200 ? carryForward(ema(rows(daily), 200), candles.map((item) => item.time)) : [], ema21: enabled.ema21 ? carryForward(ema(rows(weekly), 21), candles.map((item) => item.time)) : [], bbMiddle: enabled.bb ? bb.middle : [], bbUpper: enabled.bb ? bb.upper : [], bbLower: enabled.bb ? bb.lower : [] };
  const toggle = (name: IndicatorName) => setEnabled((current) => ({ ...current, [name]: !current[name] }));
  const onRangeChange = (range: TimeRange) => { rangesRef.current[interval] = range; persistUi(interval, enabled, rangesRef.current); };
  const onRangeChangeFor = (value: string) => (range: TimeRange) => { rangesRef.current[value] = range; persistUi(interval, enabled, rangesRef.current); };
  const selectInterval = (next: string) => { if (next === interval) return; chartTrace("switch-request", { from: interval, to: next, leavingRange: rangesRef.current[interval] || null, enteringRange: rangesRef.current[next] || null, currentCandles: candles.length, currentLast: candles.at(-1)?.time }); setIntervalValue(next); };
  const indicatorFor = (items: Candle[]) => { const source = rows(items); const bands = bollinger(source); return { ma7: enabled.ma7 ? sma(source, 7) : [], ma25: enabled.ma25 ? sma(source, 25) : [], ma60: enabled.ma60 ? sma(source, 60) : [], ma99: enabled.ma99 ? sma(source, 99) : [], ema200: enabled.ema200 ? carryForward(ema(rows(daily), 200), items.map((item) => item.time)) : [], ema21: enabled.ema21 ? carryForward(ema(rows(weekly), 21), items.map((item) => item.time)) : [], bbMiddle: enabled.bb ? bands.middle : [], bbUpper: enabled.bb ? bands.upper : [], bbLower: enabled.bb ? bands.lower : [] }; };
  const chart = <section className="chart-pane"><nav>{intervals.map((item) => <button className={item.value === interval ? "active" : ""} key={item.value} onClick={() => selectInterval(item.value)}>{item.label}</button>)}<span className="indicator-controls">{([['ma7', 'MA7'], ['ma25', 'MA25'], ['ma60', 'MA60'], ['ma99', 'MA99'], ['ema200', 'EMA200D'], ['ema21', 'EMA21W'], ['bb', 'BB']] as Array<[IndicatorName, string]>).map(([name, label]) => <button className={enabled[name] ? "active" : ""} key={name} onClick={() => toggle(name)}>{label}</button>)}</span></nav>{intervals.map((item) => <div className="chart-layer" style={{ visibility: item.value === interval ? "visible" : "hidden", pointerEvents: item.value === interval ? "auto" : "none" }} key={item.value}><Chart candles={candleSets[item.value] || []} loadOlder={() => loadOlderFor(item.value)} line={item.value === "time"} indicators={indicatorFor(candleSets[item.value] || [])} initialRange={rangesRef.current[item.value]} onRangeChange={onRangeChangeFor(item.value)} period={item.value} active={item.value === interval} /></div>)}<div className="funding-strip"><span>Funding</span><strong className={fundingRate >= 0 ? "positive" : "negative"}>{Number.isFinite(fundingRate) ? `${(fundingRate * 100).toFixed(4)}%` : "--"}</strong><span>Mark {funding?.markPrice ? Number(funding.markPrice).toFixed(2) : "--"}</span><span>Index {funding?.indexPrice ? Number(funding.indexPrice).toFixed(2) : "--"}</span><span>Next {nextFunding}</span></div></section>;
  return chart;
}
