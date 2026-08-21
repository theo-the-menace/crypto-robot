import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, TickMarkType } from "lightweight-charts";
import { aggregateKlines } from "./chart-data";

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number };
type Funding = { lastFundingRate?: string; nextFundingTime?: number; markPrice?: string; indexPrice?: string };
type Line = { kind: "input" | "output" | "error"; text: string };
type Dashboard = { service: { environment: string; mode: string; healthy: boolean }; strategies: Array<{ name: string; status: string; symbol: string }>; recentOrders: Array<{ state: string; symbol: string; client_order_id: string }>; risk: { allowedSymbols: string[]; maxOrderUsdt: number }; orders: { unknown: number } };

const BASE = __DASHBOARD_API_URL__;
const MARKET_BASE = "/api";
const TOKEN = __DASHBOARD_TOKEN__;
const intervals = ["1m", "5m", "15m", "1h", "4h", "1d"];
const intervalMs: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const cacheKey = "crypto-robot-btcusd-perp-v3-1m";
const parseRow = (row: Array<string | number>): Candle => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), quoteVolume: Number(row[7]) });
const merge = (left: Candle[], right: Candle[]) => [...new Map([...left, ...right].map((item) => [item.time, item])).values()].sort((a, b) => a.time - b.time);
const cached = (): Candle[] => { try { return JSON.parse(localStorage.getItem(cacheKey) || "[]"); } catch { return []; } };
const chinaTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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

function Chart({ candles, loadOlder }: { candles: Candle[]; loadOlder: () => Promise<void> }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const series = useRef<any>(null);
  const volume = useRef<any>(null);
  const previous = useRef<Candle[]>([]);
  const loading = useRef(false);

  useLayoutEffect(() => {
    if (!host.current) return;
    chart.current = createChart(host.current, { autoSize: true, localization: { locale: "zh-CN", timeFormatter: (time: unknown) => formatChinaTime(Number(time)) }, layout: { background: { type: ColorType.Solid, color: "#10151c" }, textColor: "#8290a0" }, grid: { vertLines: { color: "#27313d" }, horzLines: { color: "#27313d" } }, rightPriceScale: { borderColor: "#33404d" }, timeScale: { borderColor: "#33404d", timeVisible: true, secondsVisible: false, rightOffset: 5, tickMarkFormatter: (time: unknown, type: TickMarkType) => formatChinaTick(Number(time), type) }, crosshair: { mode: 0 } });
    series.current = chart.current.addSeries(CandlestickSeries, { upColor: "#39c58a", downColor: "#ef6672", borderVisible: false, wickUpColor: "#39c58a", wickDownColor: "#ef6672" });
    volume.current = chart.current.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    return () => chart.current?.remove();
  }, []);

  useLayoutEffect(() => {
    if (!series.current || !candles.length) return;
    const bars = candles.map((item) => ({ time: Math.floor(item.time / 1000) as any, open: item.open, high: item.high, low: item.low, close: item.close }));
    const volumes = candles.map((item) => ({ time: Math.floor(item.time / 1000) as any, value: item.volume, color: item.close >= item.open ? "#39c58a66" : "#ef667266" }));
    const old = previous.current;
    const prepend = old.length && candles[0].time < old[0].time ? candles.findIndex((item) => item.time === old[0].time) : 0;
    const sameWindow = old.length === candles.length && old[0]?.time === candles[0].time && old.at(-2)?.time === candles.at(-2)?.time;
    if (sameWindow) { series.current.update(bars.at(-1)); volume.current.update(volumes.at(-1)); }
    else {
      const range = chart.current.timeScale().getVisibleLogicalRange();
      series.current.setData(bars); volume.current.setData(volumes);
      if (!old.length) chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 160), to: bars.length + 5 });
      else if (prepend && range) chart.current.timeScale().setVisibleLogicalRange({ from: range.from + prepend, to: range.to + prepend });
    }
    previous.current = candles;
  }, [candles]);

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

  return <div className="market-chart" ref={host} />;
}

export function MarketTerminal() {
  const [interval, setIntervalValue] = useState(() => localStorage.getItem("crypto-robot-interval") || "5m");
  const [baseCandles, setBaseCandles] = useState<Candle[]>(cached);
  const [funding, setFunding] = useState<Funding | null>(null);
  const candles = aggregateKlines(baseCandles.map((item) => [item.time, item.open, item.high, item.low, item.close, item.volume, item.time + intervalMs["1m"] - 1, item.quoteVolume]), intervalMs[interval]).map(parseRow);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const candlesRef = useRef(baseCandles);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { candlesRef.current = baseCandles; }, [baseCandles]);

  const history = useCallback(async (endTime?: number) => {
    const suffix = endTime ? `&endTime=${endTime}` : "";
    const response = await fetch(`${MARKET_BASE}/market/klines?symbol=BTCUSD_PERP&limit=1000${suffix}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`history failed (${response.status})`);
    return (await response.json()).klines.map(parseRow) as Candle[];
  }, []);

  const loadOlder = useCallback(async () => {
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    const rows = await history(oldest.time - 1);
    if (rows.at(-1)?.time === oldest.time - intervalMs["1m"]) setBaseCandles((current) => merge(rows, current));
  }, [history]);

  useEffect(() => {
    localStorage.setItem("crypto-robot-interval", interval);
    let active = true;
    void (async () => {
      try {
        let rows = await history();
        if (!active) return;
        setBaseCandles((current) => { const next = merge(current, rows); candlesRef.current = next; return next; });
        for (let page = 0; page < 2 && rows.length; page++) {
          const oldest = candlesRef.current[0];
          rows = await history(oldest.time - 1);
          if (!active) return;
          if (rows.at(-1)?.time !== oldest.time - intervalMs["1m"]) break;
          setBaseCandles((current) => { const next = merge(rows, current); candlesRef.current = next; return next; });
        }
      } catch (error) { setLines((current) => [...current, { kind: "error", text: error instanceof Error ? error.message : "history unavailable" }]); }
    })();
    return () => { active = false; };
  }, [history]);

  useEffect(() => {
    const refresh = async () => { try { const rows = await history(); setBaseCandles((current) => merge(current, rows)); } catch {} };
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [history]);

  useEffect(() => {
    const refresh = async () => { try { const response = await fetch(`${MARKET_BASE}/market/funding?symbol=BTCUSD_PERP`, { cache: "no-store" }); if (response.ok) setFunding((await response.json()).premium || null); } catch {} };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 10_000); return () => clearInterval(timer);
  }, []);

  useEffect(() => { const timer = setInterval(() => localStorage.setItem(cacheKey, JSON.stringify(candlesRef.current.slice(-1_000))), 500); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!TOKEN) return;
    const refresh = async () => { try { const response = await fetch(`${BASE}/v1/dashboard`, { cache: "no-store", headers: { Authorization: `Bearer ${TOKEN}` } }); if (response.ok) setDashboard(await response.json()); } catch {} };
    void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer);
  }, []);

  const run = () => {
    const value = command.trim(); if (!value) return;
    const next: Line[] = [...lines, { kind: "input", text: `$ ${value}` }]; const [name, arg] = value.toLowerCase().split(/\s+/);
    if (name === "clear") next.splice(0);
    else if (name === "status") next.push({ kind: "output", text: dashboard ? `${dashboard.service.environment} · ${dashboard.service.mode} · ${dashboard.service.healthy ? "healthy" : "offline"}` : "connecting" });
    else if (name === "strategies") next.push({ kind: "output", text: dashboard?.strategies.length ? dashboard.strategies.map((item) => `${item.status.padEnd(10)} ${item.symbol.padEnd(12)} ${item.name}`).join("\n") : "no active strategies" });
    else if (name === "orders") next.push({ kind: "output", text: dashboard?.recentOrders.length ? dashboard.recentOrders.map((item) => `${item.state.padEnd(18)} ${item.symbol} ${item.client_order_id}`).join("\n") : "no recent orders" });
    else if (name === "risk") next.push({ kind: "output", text: dashboard ? `symbols: ${dashboard.risk.allowedSymbols.join(", ")}\nmax order: ${dashboard.risk.maxOrderUsdt} USDT\nunknown orders: ${dashboard.orders.unknown}` : "connecting" });
    else if (name === "interval" && intervals.includes(arg)) setIntervalValue(arg);
    else next.push({ kind: "error", text: `unknown command: ${name}` });
    setLines(next.slice(-100)); setCommand("");
  };

  const fundingRate = Number(funding?.lastFundingRate);
  const nextFunding = funding?.nextFundingTime ? new Date(funding.nextFundingTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "--:--";
  return <main className="market-terminal"><section className="chart-pane"><nav>{intervals.map((value) => <button className={value === interval ? "active" : ""} key={value} onClick={() => setIntervalValue(value)}>{value}</button>)}</nav><Chart key={interval} candles={candles} loadOlder={loadOlder} /><div className="funding-strip"><span>Funding</span><strong className={fundingRate >= 0 ? "positive" : "negative"}>{Number.isFinite(fundingRate) ? `${(fundingRate * 100).toFixed(4)}%` : "--"}</strong><span>Mark {funding?.markPrice ? Number(funding.markPrice).toFixed(2) : "--"}</span><span>Index {funding?.indexPrice ? Number(funding.indexPrice).toFixed(2) : "--"}</span><span>Next {nextFunding}</span></div></section><section className="console" onClick={() => input.current?.focus()}><div className="output">{lines.map((line, index) => <pre className={line.kind} key={index}>{line.text}</pre>)}</div><form onSubmit={(event) => { event.preventDefault(); run(); }}><span>$</span><input ref={input} value={command} onChange={(event) => setCommand(event.target.value)} autoComplete="off" spellCheck={false} /></form></section></main>;
}
