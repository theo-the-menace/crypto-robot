import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, TickMarkType } from "lightweight-charts";
import { bollinger, carryForward, ema, isHorizontalGesture, sma, type IndicatorPoint } from "./chart-data";

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number };
type Funding = { lastFundingRate?: string; nextFundingTime?: number; markPrice?: string; indexPrice?: string };
type Line = { kind: "input" | "output" | "error"; text: string };
type Dashboard = { service: { environment: string; mode: string; healthy: boolean }; strategies: Array<{ name: string; status: string; symbol: string }>; recentOrders: Array<{ state: string; symbol: string; client_order_id: string }>; risk: { allowedSymbols: string[]; maxOrderUsdt: number }; orders: { unknown: number } };
type CoinMSnapshot = { syncedAt: number; positions: Array<{ symbol: string; positionAmt: string; entryPrice: string; markPrice: string; leverage: string; unrealizedProfit: string }>; trades: Array<{ orderId: number | string; side: string; price: string; qty: string; quoteQty?: string; commission: string; commissionAsset: string; realizedPnl?: string; time: number }>; income: Array<{ incomeType: string; income: string; asset: string; symbol?: string; time: number }>; openOrders: Array<{ orderId: number | string; side: string; type: string; price: string; origQty: string; status: string }>; orders: Array<{ orderId: number | string; side: string; type: string; price: string; origQty: string; executedQty: string; status: string; time: number }> };
type IndicatorName = "ma7" | "ma25" | "ma60" | "ma99" | "ema200" | "ema21" | "bb";
type TimeRange = { from: number; to: number };
type TerminalUi = { interval: string; enabled: Record<IndicatorName, boolean>; ranges: Record<string, TimeRange> };

const BASE = __DASHBOARD_API_URL__;
const MARKET_BASE = "/api";
const TOKEN = __DASHBOARD_TOKEN__;
const intervals = [{ value: "time", label: "Time" }, { value: "1m", label: "1m" }, { value: "5m", label: "5m" }, { value: "15m", label: "15m" }, { value: "1h", label: "1h" }, { value: "4h", label: "4h" }, { value: "1d", label: "1d" }, { value: "1w", label: "1W" }, { value: "1M", label: "1M" }];
const intervalMs: Record<string, number> = { time: 60_000, "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000, "1M": 2_678_400_000 };
const cacheKey = (interval: string) => `crypto-robot-btcusd-perp-v7-${interval}`;
const browserCacheLimit = 800;
const uiKey = "crypto-robot-terminal-ui-v4";
const parseRow = (row: Array<string | number>): Candle => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), quoteVolume: Number(row[7]) });
const merge = (left: Candle[], right: Candle[]) => [...new Map([...left, ...right].map((item) => [item.time, item])).values()].sort((a, b) => a.time - b.time);
const cached = (interval: string): Candle[] => { try { return JSON.parse(localStorage.getItem(cacheKey(interval)) || "[]"); } catch { return []; } };
const pruneBrowserCache = () => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("crypto-robot-btcusd-perp-v6-")) localStorage.removeItem(key);
    if (key.startsWith("crypto-robot-btcusd-perp-v7-")) {
      try { const rows = JSON.parse(localStorage.getItem(key) || "[]"); localStorage.setItem(key, JSON.stringify(rows.slice(-browserCacheLimit))); } catch { localStorage.removeItem(key); }
    }
  }
};
const defaultEnabled: Record<IndicatorName, boolean> = { ma7: true, ma25: true, ma60: false, ma99: false, ema200: true, ema21: true, bb: false };
const savedUi = (): TerminalUi => {
  try {
    const value = JSON.parse(localStorage.getItem(uiKey) || "{}");
    return { interval: intervals.some((item) => item.value === value.interval) ? value.interval : "5m", enabled: { ...defaultEnabled, ...(value.enabled || {}) }, ranges: Object.fromEntries(Object.entries(value.ranges || {}).flatMap(([key, range]: [string, any]) => Number.isFinite(range?.from) && Number.isFinite(range?.to) && range.to > range.from ? [[key, range]] : [])) };
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
function Chart({ candles, loadOlder, resetViewport, line, indicators, initialRange, onRangeChange, period }: { candles: Candle[]; loadOlder: () => Promise<void>; resetViewport: boolean; line: boolean; indicators: Record<string, IndicatorPoint[]>; initialRange?: TimeRange; onRangeChange: (range: TimeRange) => void; period: string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const series = useRef<any>(null);
  const volume = useRef<any>(null);
  const overlays = useRef<Record<string, any>>({});
  const previous = useRef<Candle[]>([]);
  const loading = useRef(false);
  const resetApplied = useRef(false);
  const restoredRange = useRef(initialRange);

  useLayoutEffect(() => {
    if (!host.current) return;
    chart.current = createChart(host.current, { autoSize: true, localization: { locale: "en-CA", timeFormatter: (time: unknown) => formatChinaTime(Number(time)) }, layout: { background: { type: ColorType.Solid, color: "#10151c" }, textColor: "#8290a0" }, grid: { vertLines: { color: "#27313d" }, horzLines: { color: "#27313d" } }, rightPriceScale: { borderColor: "#33404d" }, timeScale: { borderColor: "#33404d", timeVisible: true, secondsVisible: false, rightOffset: 5, tickMarkFormatter: (time: unknown, type: TickMarkType) => formatChinaTick(Number(time), type) }, crosshair: { mode: 0 } });
    series.current = line ? chart.current.addSeries(AreaSeries, { lineColor: "#f6c945", topColor: "#f6c94566", bottomColor: "#f6c94500", lineWidth: 2 }) : chart.current.addSeries(CandlestickSeries, { upColor: "#39c58a", downColor: "#ef6672", borderVisible: false, wickUpColor: "#39c58a", wickDownColor: "#ef6672" });
    volume.current = chart.current.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const colors: Record<string, string> = { ma7: "#f6c945", ma25: "#58a6ff", ma60: "#c678dd", ma99: "#f08c46", ema200: "#f97316", ema21: "#22c55e", bbMiddle: "#aab6c5", bbUpper: "#64748b", bbLower: "#64748b" };
    for (const [name, color] of Object.entries(colors)) overlays.current[name] = chart.current.addSeries(LineSeries, { color, lineWidth: name.startsWith("bb") ? 1 : 2, lineStyle: name === "bbMiddle" ? 0 : 2, lastValueVisible: false, priceLineVisible: false });
    return () => chart.current?.remove();
  }, []);

  useLayoutEffect(() => { previous.current = []; resetApplied.current = false; restoredRange.current = initialRange; }, [period]);

  useLayoutEffect(() => {
    if (!series.current || !candles.length) return;
    const bars = candles.map((item) => line ? { time: Math.floor(item.time / 1000) as any, value: item.close } : { time: Math.floor(item.time / 1000) as any, open: item.open, high: item.high, low: item.low, close: item.close });
    const volumes = candles.map((item) => ({ time: Math.floor(item.time / 1000) as any, value: item.volume, color: item.close >= item.open ? "#39c58a66" : "#ef667266" }));
    const old = previous.current;
    const prepend = old.length && candles[0].time < old[0].time ? candles.findIndex((item) => item.time === old[0].time) : 0;
    const sameWindow = old.length === candles.length && old[0]?.time === candles[0].time && old.at(-2)?.time === candles.at(-2)?.time;
    if (sameWindow) { series.current.update(bars.at(-1)); volume.current.update(volumes.at(-1)); }
    else {
      const range = chart.current.timeScale().getVisibleLogicalRange();
      series.current.setData(bars); volume.current.setData(volumes);
      if (!old.length || (resetViewport && !resetApplied.current)) {
        const savedRange = restoredRange.current;
        if (savedRange) chart.current.timeScale().setVisibleRange({ from: savedRange.from / 1000, to: savedRange.to / 1000 });
        else chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 160), to: bars.length + 5 });
        resetApplied.current = resetViewport;
      }
      else if (prepend && range) chart.current.timeScale().setVisibleLogicalRange({ from: range.from + prepend, to: range.to + prepend });
    }
    previous.current = candles;
  }, [candles, resetViewport, line, initialRange]);

  useLayoutEffect(() => {
    for (const [name, series] of Object.entries(overlays.current)) series.setData((indicators[name] || []).map((point) => ({ time: Math.floor(point.time / 1000) as any, value: point.value })));
  }, [indicators]);

  useEffect(() => {
    const scale = chart.current?.timeScale();
    if (!scale) return;
    const check = async (range: { from: number } | null) => {
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
      const range = scale.getVisibleRange();
      const from = Number(range?.from) * 1000; const to = Number(range?.to) * 1000;
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) onRangeChange({ from, to });
    };
    scale.subscribeVisibleLogicalRangeChange(save);
    return () => scale.unsubscribeVisibleLogicalRangeChange(save);
  }, [candles, onRangeChange]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const pan = (event: WheelEvent) => {
      if (!isHorizontalGesture(event.deltaX, event.deltaY)) return;
      const range = chart.current?.timeScale().getVisibleLogicalRange();
      if (!range) return;
      event.preventDefault();
      event.stopPropagation();
      const offset = event.deltaX * (range.to - range.from) / Math.max(element.clientWidth, 1);
      chart.current.timeScale().setVisibleLogicalRange({ from: range.from + offset, to: range.to + offset });
    };
    element.addEventListener("wheel", pan, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", pan, true);
  }, []);

  return <div className="market-chart" ref={host} />;
}

export function MarketTerminal() {
  const [initialUi] = useState(savedUi);
  const [interval, setIntervalValue] = useState(initialUi.interval);
  const [candleSets, setCandleSets] = useState<Record<string, Candle[]>>(() => ({ [initialUi.interval]: cached(initialUi.interval) }));
  const [funding, setFunding] = useState<Funding | null>(null);
  const [loadedInterval, setLoadedInterval] = useState<string | null>(null);
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
  useEffect(() => { try { pruneBrowserCache(); } catch {} }, []);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { const node = output.current; if (node) node.scrollTop = node.scrollHeight; }, [lines]);

  const history = useCallback(async (endTime?: number) => {
    const suffix = endTime ? `&endTime=${endTime}` : "";
    const response = await fetch(`${MARKET_BASE}/market/klines?symbol=BTCUSD_PERP&interval=${interval === "time" ? "1m" : interval}&limit=5000${suffix}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`history failed (${response.status})`);
    return (await response.json()).klines.map(parseRow) as Candle[];
  }, [interval]);

  const loadOlder = useCallback(async () => {
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    const rows = await history(oldest.time - 1);
    if (rows.at(-1)?.time === oldest.time - intervalMs[interval]) setCandleSets((current) => ({ ...current, [interval]: merge(rows, current[interval] || []) }));
  }, [history, interval]);

  useEffect(() => {
    setCandleSets((current) => current[interval] ? current : { ...current, [interval]: cached(interval) });
    setLoadedInterval(null);
    let active = true;
    void (async () => {
      try {
        let rows = await history();
        if (!active) return;
        setCandleSets((current) => ({ ...current, [interval]: merge(current[interval] || [], rows) })); setLoadedInterval(interval);
      } catch (error) { setLines((current) => [...current, { kind: "error", text: error instanceof Error ? error.message : "history unavailable" }]); }
    })();
    return () => { active = false; };
  }, [history]);

  useEffect(() => {
    const refresh = async () => { try { const rows = await history(); setCandleSets((current) => ({ ...current, [interval]: merge(current[interval] || [], rows) })); } catch {} };
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [history, loadOlder]);

  useEffect(() => {
    const loadReference = async (value: "1d" | "1w", setValue: (rows: Candle[]) => void) => { try { const response = await fetch(`${MARKET_BASE}/market/klines?symbol=BTCUSD_PERP&interval=${value}&limit=5000`, { cache: "no-store" }); if (response.ok) setValue((await response.json()).klines.map(parseRow)); } catch {} };
    void loadReference("1d", setDaily); void loadReference("1w", setWeekly);
  }, []);
  const refreshCoinm = useCallback(async () => { try { const response = await fetch(`${MARKET_BASE}/coinm/snapshot?symbol=BTCUSD_PERP&limit=100`, { cache: "no-store" }); if (response.ok) { setCoinm(await response.json()); return true; } } catch {} return false; }, []);
  useEffect(() => { void refreshCoinm(); const timer = setInterval(() => { void refreshCoinm(); }, 1_000); return () => clearInterval(timer); }, [refreshCoinm]);

  useEffect(() => {
    const refresh = async () => { try { const response = await fetch(`${MARKET_BASE}/market/funding?symbol=BTCUSD_PERP`, { cache: "no-store" }); if (response.ok) setFunding((await response.json()).premium || null); } catch {} };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 10_000); return () => clearInterval(timer);
  }, []);

  useEffect(() => { const timer = setInterval(() => { try { localStorage.setItem(cacheKey(interval), JSON.stringify((candleSets[interval] || []).slice(-browserCacheLimit))); } catch {} }, 1_000); return () => clearInterval(timer); }, [interval, candleSets]);
  useEffect(() => { localStorage.setItem(uiKey, JSON.stringify({ interval, enabled, ranges: rangesRef.current })); }, [interval, enabled]);
  useEffect(() => {
    if (!TOKEN) return;
    const refresh = async () => { try { const response = await fetch(`${BASE}/v1/dashboard`, { cache: "no-store", headers: { Authorization: `Bearer ${TOKEN}` } }); if (response.ok) setDashboard(await response.json()); } catch {} };
    void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer);
  }, []);

  const run = () => {
    const value = command.trim(); if (!value) return;
    const next: Line[] = [...lines, { kind: "input", text: `$ ${value}` }]; const [name, arg] = value.toLowerCase().split(/\s+/);
    if (name === "clear") next.splice(0);
    else if (name === "help") next.push({ kind: "output", text: "status\norders\nrisk\nstrategies\ncoinm | positions\ntrades\nfees\ntoday-fees | today's fees\ncoinm-orders\nsync\ninterval <time|1m|5m|15m|1h|4h|1d|1w|1M>\nclear" });
    else if (name === "sync") { next.push({ kind: "output", text: "syncing COIN-M..." }); void refreshCoinm().then((ok) => setLines((current) => [...current, { kind: (ok ? "output" : "error") as Line["kind"], text: ok ? "COIN-M synced" : "COIN-M sync failed" }].slice(-100))); }
    else if (name === "today-fees" || name === "todays-fees" || name === "todays-feees" || name === "today-fee" || name === "今日手续费" || ((name === "today" || name === "today's" || name === "today’s") && arg === "fees")) {
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
    else next.push({ kind: "error", text: name === "todays-feees" ? "unknown command: todays-feees (did you mean today-fees?)" : `unknown command: ${name}` });
    setLines(next.slice(-100)); setCommand("");
  };

  const fundingRate = Number(funding?.lastFundingRate);
  const nextFunding = funding?.nextFundingTime ? new Date(funding.nextFundingTime).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "--:--";
  const bb = bollinger(rows(candles));
  const indicators: Record<string, IndicatorPoint[]> = { ma7: enabled.ma7 ? sma(rows(candles), 7) : [], ma25: enabled.ma25 ? sma(rows(candles), 25) : [], ma60: enabled.ma60 ? sma(rows(candles), 60) : [], ma99: enabled.ma99 ? sma(rows(candles), 99) : [], ema200: enabled.ema200 ? carryForward(ema(rows(daily), 200), candles.map((item) => item.time)) : [], ema21: enabled.ema21 ? carryForward(ema(rows(weekly), 21), candles.map((item) => item.time)) : [], bbMiddle: enabled.bb ? bb.middle : [], bbUpper: enabled.bb ? bb.upper : [], bbLower: enabled.bb ? bb.lower : [] };
  const toggle = (name: IndicatorName) => setEnabled((current) => ({ ...current, [name]: !current[name] }));
  const onRangeChange = (range: TimeRange) => { rangesRef.current[interval] = range; localStorage.setItem(uiKey, JSON.stringify({ interval, enabled, ranges: rangesRef.current })); };
  const selectInterval = (next: string) => { if (rangesRef.current[interval]) rangesRef.current[next] = rangesRef.current[interval]; setIntervalValue(next); };
  return <main className="market-terminal"><section className="chart-pane"><nav>{intervals.map((item) => <button className={item.value === interval ? "active" : ""} key={item.value} onClick={() => selectInterval(item.value)}>{item.label}</button>)}<span className="indicator-controls">{([['ma7', 'MA7'], ['ma25', 'MA25'], ['ma60', 'MA60'], ['ma99', 'MA99'], ['ema200', 'EMA200D'], ['ema21', 'EMA21W'], ['bb', 'BB']] as Array<[IndicatorName, string]>).map(([name, label]) => <button className={enabled[name] ? "active" : ""} key={name} onClick={() => toggle(name)}>{label}</button>)}</span></nav><Chart key={interval === "time" ? "time" : "candles"} candles={candles} loadOlder={loadOlder} resetViewport={loadedInterval === interval} line={interval === "time"} indicators={indicators} initialRange={rangesRef.current[interval]} onRangeChange={onRangeChange} period={interval} /><div className="funding-strip"><span>Funding</span><strong className={fundingRate >= 0 ? "positive" : "negative"}>{Number.isFinite(fundingRate) ? `${(fundingRate * 100).toFixed(4)}%` : "--"}</strong><span>Mark {funding?.markPrice ? Number(funding.markPrice).toFixed(2) : "--"}</span><span>Index {funding?.indexPrice ? Number(funding.indexPrice).toFixed(2) : "--"}</span><span>Next {nextFunding}</span></div></section><section className="console" onClick={() => input.current?.focus()}><div className="output" ref={output}>{lines.map((line, index) => <pre className={line.kind} key={index}>{line.text}</pre>)}</div><form onSubmit={(event) => { event.preventDefault(); run(); }} onPointerDown={(event) => event.stopPropagation()}><span>$</span><input ref={input} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.stopPropagation()} autoComplete="off" spellCheck={false} /></form></section></main>;
}
