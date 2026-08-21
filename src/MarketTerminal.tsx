import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries } from "lightweight-charts";

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number };
type Line = { kind: "input" | "output" | "error"; text: string };
type Dashboard = { service: { environment: string; mode: string; healthy: boolean }; strategies: Array<{ name: string; status: string; symbol: string }>; recentOrders: Array<{ state: string; symbol: string; client_order_id: string }>; risk: { allowedSymbols: string[]; maxOrderUsdt: number }; orders: { unknown: number } };

const BASE = __DASHBOARD_API_URL__;
const TOKEN = __DASHBOARD_TOKEN__;
const intervals = ["1m", "5m", "15m", "1h", "4h", "1d"];
const cacheKey = (interval: string) => `crypto-robot-btcusd-perp-${interval}`;
const parseRow = (row: Array<string | number>): Candle => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), quoteVolume: Number(row[7]) });
const merge = (left: Candle[], right: Candle[]) => [...new Map([...left, ...right].map((item) => [item.time, item])).values()].sort((a, b) => a.time - b.time);
const cached = (interval: string): Candle[] => { try { return JSON.parse(localStorage.getItem(cacheKey(interval)) || "[]"); } catch { return []; } };
const chinaTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const formatChinaTime = (time: number) => {
  const parts = Object.fromEntries(chinaTime.formatToParts(new Date(time * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${Number(parts.month)}-${Number(parts.day)} ${parts.hour}:${parts.minute}`;
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
    chart.current = createChart(host.current, { autoSize: true, localization: { locale: "zh-CN", timeFormatter: (time: unknown) => formatChinaTime(Number(time)) }, layout: { background: { type: ColorType.Solid, color: "#10151c" }, textColor: "#8290a0" }, grid: { vertLines: { color: "#27313d" }, horzLines: { color: "#27313d" } }, rightPriceScale: { borderColor: "#33404d" }, timeScale: { borderColor: "#33404d", timeVisible: true, secondsVisible: false, rightOffset: 5, tickMarkFormatter: (time: unknown) => formatChinaTime(Number(time)) }, crosshair: { mode: 0 } });
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
  const [candles, setCandles] = useState<Candle[]>(() => cached(localStorage.getItem("crypto-robot-interval") || "5m"));
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const candlesRef = useRef(candles);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  const history = useCallback(async (endTime?: number) => {
    const suffix = endTime ? `&endTime=${endTime}` : "";
    const response = await fetch(`${BASE}/v1/market/klines?symbol=BTCUSD_PERP&interval=${interval}&limit=1000${suffix}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`history failed (${response.status})`);
    return (await response.json()).klines.map(parseRow) as Candle[];
  }, [interval]);

  const loadOlder = useCallback(async () => {
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    const rows = await history(oldest.time - 1);
    setCandles((current) => merge(rows, current));
  }, [history]);

  useEffect(() => {
    localStorage.setItem("crypto-robot-interval", interval);
    const saved = cached(interval); candlesRef.current = saved; setCandles(saved);
    let active = true;
    void (async () => {
      try {
        let rows = await history();
        if (!active) return;
        setCandles((current) => merge(current, rows));
        for (let page = 0; page < 2 && rows.length; page++) {
          rows = await history(rows[0].time - 1);
          if (!active) return;
          setCandles((current) => merge(rows, current));
        }
      } catch (error) { setLines((current) => [...current, { kind: "error", text: error instanceof Error ? error.message : "history unavailable" }]); }
    })();
    return () => { active = false; };
  }, [history, interval]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${BASE}/v1/market/stream?symbol=BTCUSD_PERP&interval=${interval}`, { cache: "no-store", signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`stream failed (${response.status})`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += chunk.value; const rows = buffer.split("\n"); buffer = rows.pop() || "";
            for (const row of rows) if (row) {
              const value = JSON.parse(row); const next: Candle = { time: Number(value.time), open: Number(value.open), high: Number(value.high), low: Number(value.low), close: Number(value.close), volume: Number(value.volume), quoteVolume: Number(value.quoteVolume) };
              setCandles((current) => current.at(-1)?.time === next.time ? [...current.slice(0, -1), next] : [...current, next]);
            }
          }
        } catch { if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 500)); }
      }
    })();
    return () => controller.abort();
  }, [interval]);

  useEffect(() => { const timer = setInterval(() => localStorage.setItem(cacheKey(interval), JSON.stringify(candlesRef.current.slice(-5000))), 500); return () => clearInterval(timer); }, [interval]);
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

  return <main className="market-terminal"><section className="chart-pane"><nav>{intervals.map((value) => <button className={value === interval ? "active" : ""} key={value} onClick={() => setIntervalValue(value)}>{value}</button>)}</nav><Chart candles={candles} loadOlder={loadOlder} /></section><section className="console" onClick={() => input.current?.focus()}><div className="output">{lines.map((line, index) => <pre className={line.kind} key={index}>{line.text}</pre>)}</div><form onSubmit={(event) => { event.preventDefault(); run(); }}><span>$</span><input ref={input} value={command} onChange={(event) => setCommand(event.target.value)} autoComplete="off" spellCheck={false} /></form></section></main>;
}
