import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Eye,
  FileText,
  History,
  Home,
  LineChart,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  Sun,
  WalletCards,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  appendedPointCount,
  chartTickSpacing,
  fillSecondRows,
  fixedTimeTickIndices,
  klineWindow,
  mergeKlineRows,
  mergeTradeIntoSecondRows,
  nearHistoryStart,
  panWindowOffset,
  updateKlinePrice,
  zoomWindowOffset,
  type KlineRow,
} from "./chart-data";
import { aggregateAssetBalances } from "./asset-summary";

type ModelId = "gpt-5.6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra";
type ReasoningId = "low" | "medium" | "high" | "xhigh" | "max";
type Status = {
  configured: boolean;
  environment: "testnet" | "live";
  liveTradingEnabled: boolean;
  allowedSymbols: string[] | null;
  maxOrderUsdt: number;
  model?: {
    provider: string;
    models: ModelId[];
    reasoning: ReasoningId[];
    defaultModel: ModelId;
    defaultReasoning: ReasoningId;
  };
};
type Balance = { asset: string; free: string; locked: string };
type Draft = {
  id: string;
  confirmationToken: string;
  intent: {
    symbol: string;
    side: "BUY" | "SELL";
    type: string;
    quantity?: string;
    quoteOrderQty?: string;
    price?: string;
    leverage?: number;
    marginType?: string;
  };
  estimate?: {
    estimatedPrice: number;
    estimatedNotional: number;
    baseQuantity: number;
    baseAsset: string;
    quoteAsset: string;
  };
  environment: string;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachment?: ImageAttachment;
  product?: "spot" | "margin" | "futures";
  draft?: Draft;
  order?: Record<string, unknown>;
};
type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
};
type ChartPoint = { time: number; close: number };
type Theme = "light" | "dark" | "system";
type NewsItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  summary: string;
  publishedAt: string;
  urgency: "normal" | "breaking";
};
type EmergencyState = {
  pending?: { id: string; title: string; budget: number };
  grant?: { id: string; remaining: number; expiresAt: number } | null;
};
type FuturesPosition = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  unRealizedProfit: string;
};
type MarginAccount = {
  marginLevel?: string;
  totalAssetOfBtc?: string;
  totalLiabilityOfBtc?: string;
  userAssets?: Array<{
    asset: string;
    borrowed: string;
    interest: string;
    free: string;
  }>;
};
type AssetSnapshot = {
  configured: boolean;
  spot: { balances?: Balance[] } | null;
  funding: Array<{
    asset: string;
    free: string;
    locked: string;
    freeze?: string;
    withdrawing?: string;
  }> | null;
  earn: {
    rows?: Array<{
      asset: string;
      totalAmount?: string;
      holdingAmount?: string;
      cumulativeTotalRewards?: string;
      latestAnnualPercentageRate?: string;
      productName?: string;
      productId?: string;
    }>;
  } | null;
  futures: {
    totalWalletBalance?: string;
    totalUnrealizedProfit?: string;
    availableBalance?: string;
    assets?: Array<{
      asset: string;
      walletBalance: string;
      unrealizedProfit: string;
      availableBalance: string;
    }>;
    positions?: Array<{
      symbol: string;
      positionAmt: string;
      unrealizedProfit: string;
    }>;
  } | null;
  wallets: Array<{
    walletName: string;
    balance: string;
    activate: boolean;
  }> | null;
  prices: Record<string, number>;
  errors: string[];
};
type AssetTab = "overview" | "earn" | "spot" | "funding" | "futures";
type CoinMMarket = {
  symbol: string;
  interval: string;
  klines: Array<Array<string | number>>;
  depth: { bids: string[][]; asks: string[][] };
  premium: {
    markPrice: string;
    indexPrice: string;
    lastFundingRate?: string;
    nextFundingTime?: number;
  };
  orderBook24h?: Record<string, unknown> | null;
  partial?: boolean;
};
type MarketContext = {
  symbol: string;
  interval: string;
  candles: CoinMCandle[];
  markPrice: number;
  fundingRate: number;
  depth: {
    bidDepth: number;
    askDepth: number;
    imbalance: number;
    spreadBps: number;
  } | null;
  orderBook24h?: Record<string, unknown> | null;
};
type ImageAttachment = { dataUrl: string; name: string; type: string };
type FuturesTrade = {
  id: number;
  orderId: number;
  symbol: string;
  side: string;
  positionSide?: string;
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  realizedPnl: string;
  time: number;
  maker?: boolean;
};
const LEFT_SIDEBAR_MIN = 160;
const TIME_SHARE_ZOOM_KEY = "crypto-agent-time-share-visible-points";
const MIN_TIME_SHARE_POINTS = 9;
const MAX_TIME_SHARE_POINTS = 145;
const MIN_KLINE_POINTS = 9;
const MAX_KLINE_POINTS = 129;
const KLINE_INTERVAL_MS: Record<string, number> = {
  "1s": 1_000,
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

declare global {
  interface Window {
    cryptoAgent?: { notify: (title: string, body: string) => void };
  }
}

if (
  window.cryptoAgent &&
  new URLSearchParams(window.location.search).get("widget") !== "1"
)
  document.documentElement.dataset.desktop = "true";

function formatNumber(value: number | string) {
  const number = Number(value);
  // Binance mobile balances display two decimal places by truncating the visible amount.
  const display = Math.floor(number * 100) / 100;
  return Number.isFinite(number)
    ? display.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "-";
}

function modelLabel(model: ModelId, prefix = "GPT-") {
  const family = model.replace("gpt-", "").replace("-", " ");
  return `${prefix}${family[0].toUpperCase()}${family.slice(1)}`;
}

function MarketPanel({ items }: { items: NewsItem[] }) {
  return (
    <section className="market-panel" aria-label="市场动态">
      <div className="section-title">
        <span>Market</span>
      </div>
      <div className="market-event-list">
        {items.length ? (
          items.map((item) => (
            <article
              className={`market-event${item.urgency === "breaking" ? " breaking" : ""}`}
              key={item.id}
            >
              <div>
                <span>{item.source}</span>
                <time>
                  {new Date(item.publishedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </a>
            </article>
          ))
        ) : (
          <p className="market-empty">市场消息正在同步</p>
        )}
      </div>
    </section>
  );
}

function EmergencyPanel({
  state,
  onChange,
}: {
  state: EmergencyState;
  onChange: (next: EmergencyState) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!state.pending && !state.grant) return null;
  async function confirm() {
    setBusy(true);
    try {
      const result = await api<{ grant: EmergencyState["grant"] }>(
        "/emergency/confirm",
        {
          method: "POST",
          body: JSON.stringify({
            confirmation: "CONFIRM",
            allowLeverage: false,
            maxLeverage: 1,
          }),
        },
      );
      onChange({ grant: result.grant });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="emergency-panel" aria-label="紧急授权">
      {state.pending && (
        <>
          <strong>紧急新闻待确认</strong>
          <span>{state.pending.title}</span>
          <small>
            预授权预算 {formatNumber(state.pending.budget)} USDT，仅限现货
          </small>
          <button disabled={busy} onClick={() => void confirm()}>
            {busy ? "授权中" : "确认紧急授权"}
          </button>
        </>
      )}
      {state.grant && (
        <>
          <strong>紧急授权已启用</strong>
          <span>剩余预算 {formatNumber(state.grant.remaining)} USDT</span>
          <button
            onClick={() =>
              void api("/emergency/revoke", {
                method: "POST",
                body: JSON.stringify({ reason: "manual" }),
              }).then(() => onChange({}))
            }
          >
            撤销授权
          </button>
        </>
      )}
    </section>
  );
}

function DerivativesPanel({
  positions,
  margin,
}: {
  positions: FuturesPosition[];
  margin: MarginAccount | null;
}) {
  const active = positions.filter((item) => Number(item.positionAmt) !== 0);
  if (!active.length && !margin) return null;
  return (
    <section className="derivatives-panel" aria-label="杠杆与合约状态">
      <div className="news-heading">
        <strong>杠杆与合约</strong>
        <span>只读风险摘要</span>
      </div>
      {active.map((position) => (
        <div className="derivative-row" key={position.symbol}>
          <b>
            {position.symbol} {Number(position.positionAmt) > 0 ? "多" : "空"}{" "}
            {formatNumber(position.leverage)}x
          </b>
          <span>强平 {formatNumber(position.liquidationPrice)}</span>
          <span>未实现 {formatNumber(position.unRealizedProfit)} USDT</span>
        </div>
      ))}
      {margin && (
        <div className="derivative-row">
          <b>Margin</b>
          <span>保证金率 {formatNumber(margin.marginLevel || 0)}</span>
          <span>负债 {formatNumber(margin.totalLiabilityOfBtc || 0)} BTC</span>
        </div>
      )}
    </section>
  );
}

function ProductDraftPanel({ onDone }: { onDone: () => void }) {
  const [product, setProduct] = useState<"spot" | "margin" | "futures">(
    "futures",
  );
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("");
  const [leverage, setLeverage] = useState("1");
  const [marginType, setMarginType] = useState("ISOLATED");
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const path = product === "spot" ? "/chat" : `/${product}/drafts`;
      const base = symbol.replace(/USDT$/, "");
      const payload =
        product === "spot"
          ? {
              message: `${side === "BUY" ? "买入" : "卖出"} ${quantity} ${base}`,
            }
          : {
              symbol,
              side,
              type: "MARKET",
              quantity,
              ...(product === "futures"
                ? { leverage: Number(leverage), marginType }
                : { marginType }),
            };
      const result = await api<any>(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!result.draft) throw new Error(result.reply || "无法创建草案");
      setDraft(result.draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法创建草案");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await api<any>(`/${product}/drafts/${draft.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          confirmation: "CONFIRM",
          confirmationToken: draft.confirmationToken,
        }),
      });
      setDraft(null);
      onDone();
      alert(
        `订单已提交：${String(result.order?.orderId || result.order?.orderId || "accepted")}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="product-draft-panel" aria-label="产品交易草案">
      <div className="news-heading">
        <strong>产品交易草案</strong>
        <span>所有产品都需要人工确认</span>
      </div>
      <div className="draft-controls">
        <select
          value={product}
          onChange={(event) => {
            setProduct(event.target.value as typeof product);
            setDraft(null);
          }}
        >
          <option value="spot">现货 Spot</option>
          <option value="margin">杠杆现货 Margin</option>
          <option value="futures">合约 Futures</option>
        </select>
        <input
          value={symbol}
          onChange={(event) => setSymbol(event.target.value.toUpperCase())}
          aria-label="交易对"
          placeholder="BTCUSDT"
        />
        <select
          value={side}
          onChange={(event) => setSide(event.target.value as "BUY" | "SELL")}
        >
          <option value="BUY">买入 / 做多</option>
          <option value="SELL">卖出 / 做空</option>
        </select>
        <input
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          aria-label="数量"
          placeholder="数量"
        />
        {product !== "spot" && (
          <select
            value={marginType}
            onChange={(event) => setMarginType(event.target.value)}
          >
            <option value="ISOLATED">逐仓</option>
            <option value="CROSSED">全仓</option>
          </select>
        )}
        {product === "futures" && (
          <input
            value={leverage}
            onChange={(event) => setLeverage(event.target.value)}
            aria-label="杠杆"
            placeholder="杠杆 1-125x"
          />
        )}
        <button
          disabled={busy || !quantity}
          onClick={() => void (draft ? confirm() : create())}
        >
          {busy ? "处理中" : draft ? "确认并提交" : "生成草案"}
        </button>
      </div>
      {draft && (
        <div className="draft-preview">
          {product.toUpperCase()} · {draft.intent.symbol} · {draft.intent.side}{" "}
          {draft.intent.leverage ? `${draft.intent.leverage}x` : ""} ·{" "}
          {draft.intent.marginType || ""}
          <small>请核对产品、方向、数量、杠杆和保证金模式后确认。</small>
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
    </section>
  );
}

function MarginActionPanel({ onDone }: { onDone: () => void }) {
  const [action, setAction] = useState<"BORROW" | "REPAY">("BORROW");
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState("");
  async function submit() {
    setError("");
    try {
      if (!draft) {
        const result = await api<any>("/margin/actions/drafts", {
          method: "POST",
          body: JSON.stringify({ action, asset, amount }),
        });
        setDraft(result.draft);
        return;
      }
      await api(`/margin/actions/drafts/${draft.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          confirmation: "CONFIRM",
          confirmationToken: draft.confirmationToken,
        }),
      });
      setDraft(null);
      setAmount("");
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Margin 操作失败");
    }
  }
  return (
    <section className="product-draft-panel" aria-label="Margin 借贷草案">
      <div className="news-heading">
        <strong>Margin 借贷</strong>
        <span>借币与还款均需确认</span>
      </div>
      <div className="draft-controls">
        <select
          value={action}
          onChange={(event) => {
            setAction(event.target.value as typeof action);
            setDraft(null);
          }}
        >
          <option value="BORROW">借币</option>
          <option value="REPAY">还款</option>
        </select>
        <input
          value={asset}
          onChange={(event) => setAsset(event.target.value.toUpperCase())}
          aria-label="资产"
        />
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          aria-label="金额"
          placeholder="金额"
        />
        <button disabled={!amount} onClick={() => void submit()}>
          {draft ? `确认${action === "BORROW" ? "借币" : "还款"}` : "生成草案"}
        </button>
      </div>
      {draft && (
        <div className="draft-preview">
          {draft.action} · {draft.params.amount} {draft.params.asset}
          <small>
            确认后将调用 Binance Margin{" "}
            {draft.action === "BORROW" ? "借币" : "还款"}接口。
          </small>
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
    </section>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function readImageAttachment(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    return Promise.reject(new Error("只支持 PNG、JPEG 或 WebP 图片"));
  if (file.size > 4_000_000)
    return Promise.reject(new Error("图片不能超过 4 MB"));
  return new Promise<ImageAttachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        dataUrl: String(reader.result),
        name: file.name || "clipboard-image",
        type: file.type,
      });
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });
}

function OrderDraft({
  draft,
  product = "spot",
  onConfirmed,
}: {
  draft: Draft;
  product?: "spot" | "margin" | "futures";
  onConfirmed: (order: Record<string, unknown>) => void;
}) {
  const [state, setState] = useState<"ready" | "busy" | "done">("ready");
  const [error, setError] = useState("");
  const side = draft.intent.side;
  async function confirm() {
    setState("busy");
    setError("");
    try {
      const path =
        product === "spot"
          ? `/orders/${draft.id}/confirm`
          : `/${product}/drafts/${draft.id}/confirm`;
      const result = await api<{ order: Record<string, unknown> }>(path, {
        method: "POST",
        body: JSON.stringify({
          confirmation: "CONFIRM",
          confirmationToken: draft.confirmationToken,
        }),
      });
      setState("done");
      onConfirmed(result.order);
    } catch (caught) {
      setState("ready");
      setError(caught instanceof Error ? caught.message : "Order failed.");
    }
  }
  return (
    <section
      className={`order-draft ${side.toLowerCase()}`}
      aria-label="Order preview"
    >
      <div className="order-heading">
        <span>
          {side === "BUY" ? (
            <ArrowDownLeft size={17} />
          ) : (
            <ArrowUpRight size={17} />
          )}
          {side === "BUY" ? "买入 / 做多" : "卖出 / 做空"} {draft.intent.symbol}
        </span>
        <small>
          {product.toUpperCase()} ·{" "}
          {draft.environment === "testnet" ? "测试网" : "实盘"}
        </small>
      </div>
      <dl>
        <div>
          <dt>订单类型</dt>
          <dd>{draft.intent.type}</dd>
        </div>
        <div>
          <dt>数量</dt>
          <dd>
            {formatNumber(
              draft.intent.quantity || draft.intent.quoteOrderQty || 0,
            )}
          </dd>
        </div>
        {draft.intent.leverage && (
          <div>
            <dt>杠杆</dt>
            <dd>{formatNumber(draft.intent.leverage)}x</dd>
          </div>
        )}
        {draft.intent.marginType && (
          <div>
            <dt>保证金模式</dt>
            <dd>{draft.intent.marginType}</dd>
          </div>
        )}
        {draft.estimate && (
          <div>
            <dt>预估金额</dt>
            <dd>
              {formatNumber(draft.estimate.estimatedNotional)}{" "}
              {draft.estimate.quoteAsset}
            </dd>
          </div>
        )}
      </dl>
      <p>
        <ShieldCheck size={15} /> 草案已通过本地格式校验。确认后仍需通过 Binance
        产品规则；市价单最终成交价可能不同。
      </p>
      {error && <div className="inline-error">{error}</div>}
      <button
        className="confirm-order"
        disabled={state !== "ready"}
        onClick={confirm}
      >
        {state === "busy" ? (
          <RefreshCw className="spin" size={17} />
        ) : (
          <Check size={17} />
        )}
        {state === "done"
          ? "已提交"
          : state === "busy"
            ? "提交中"
            : `确认${draft.environment === "testnet" ? "测试网" : "实盘"}订单`}
      </button>
    </section>
  );
}

function PriceChart({
  symbol,
  environment,
}: {
  symbol: string;
  environment: "testnet" | "live";
}) {
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await api<{ klines: Array<Array<string | number>> }>(
          `/klines?symbol=${symbol}&interval=1m`,
        );
        if (active) {
          setPoints(
            result.klines.map((item) => ({
              time: Number(item[0]),
              close: Number(item[4]),
            })),
          );
          setError("");
        }
      } catch (caught) {
        if (active)
          setError(caught instanceof Error ? caught.message : "行情暂不可用");
      }
    }
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [symbol, environment]);
  const width = 720;
  const height = 150;
  const pad = 12;
  const values = points.map((point) => point.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const path = points
    .map(
      (point, index) =>
        `${index ? "L" : "M"} ${(pad + index * ((width - pad * 2) / Math.max(points.length - 1, 1))).toFixed(2)} ${(height - pad - ((point.close - min) / range) * (height - pad * 2)).toFixed(2)}`,
    )
    .join(" ");
  return (
    <section
      className="price-chart"
      aria-label={`${symbol} 1 minute price chart`}
    >
      <div className="chart-heading">
        <div>
          <strong>{symbol}</strong>
          <span>1m · Binance Spot</span>
        </div>
        {values.length ? (
          <b>{formatNumber(values.at(-1)!)} USDT</b>
        ) : (
          <span>{error || "加载中"}</span>
        )}
      </div>
      {values.length ? (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${symbol} recent price`}
        >
          <path
            className="chart-fill"
            d={`${path} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`}
          />
          <path className="chart-line" d={path} />
        </svg>
      ) : (
        <div className="chart-empty">{error || "读取行情中…"}</div>
      )}
    </section>
  );
}

type CoinMCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};

function useChartNavigation({
  times,
  visibleCount,
  setVisibleCount,
  historyOffset,
  setHistoryOffset,
  step,
  minPoints,
  maxPoints,
  warmupPoints = visibleCount,
  storageKey,
  onLoadOlder,
  onDrag,
}: {
  times: number[];
  visibleCount: number;
  setVisibleCount: Dispatch<SetStateAction<number>>;
  historyOffset: number;
  setHistoryOffset: Dispatch<SetStateAction<number>>;
  step: number;
  minPoints: number;
  maxPoints: number;
  warmupPoints?: number;
  storageKey: string;
  onLoadOlder: () => Promise<void>;
  onDrag?: () => void;
}) {
  const chartRef = useRef<SVGSVGElement | null>(null);
  const visibleCountRef = useRef(visibleCount);
  const historyOffsetRef = useRef(historyOffset);
  const dragStart = useRef<number | null>(null);
  const dragAnchor = useRef(0);
  const pendingPointerX = useRef<number | null>(null);
  const dragFrame = useRef<number | null>(null);
  const dragged = useRef(false);
  const activePointers = useRef(new Map<number, number>());
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartCount = useRef(visibleCount);
  const pinchAnchor = useRef(0.5);
  const prefetchRequested = useRef(false);
  const zoomSaveTimer = useRef<number | null>(null);
  const applyZoomRef = useRef<(next: number, anchor: number) => void>(() => {});
  const onLoadOlderRef = useRef(onLoadOlder);
  const timesLengthRef = useRef(times.length);
  const stepRef = useRef(step);
  const warmupPointsRef = useRef(warmupPoints);
  const storageKeyRef = useRef(storageKey);
  visibleCountRef.current = visibleCount;
  historyOffsetRef.current = historyOffset;
  onLoadOlderRef.current = onLoadOlder;
  timesLengthRef.current = times.length;
  stepRef.current = step;
  warmupPointsRef.current = warmupPoints;
  storageKeyRef.current = storageKey;
  const updateOffset = (next: number) => {
    historyOffsetRef.current = next;
    setHistoryOffset(next);
  };
  const previousLastTime = useRef<number | null>(times.at(-1) ?? null);
  useEffect(() => {
    const appended = appendedPointCount(times, previousLastTime.current);
    if (appended > 0 && historyOffsetRef.current > 0) {
      updateOffset(historyOffsetRef.current + appended);
      if (dragStart.current !== null) dragAnchor.current += appended;
    }
    prefetchRequested.current = false;
    previousLastTime.current = times.at(-1) ?? null;
  }, [times.length, times.at(-1)]);
  const applyZoom = (nextCount: number, centerFraction: number) => {
    const currentCount = visibleCountRef.current;
    const next = Math.min(maxPoints, Math.max(minPoints, nextCount));
    if (next === currentCount) return;
    visibleCountRef.current = next;
    setVisibleCount(next);
    updateOffset(
      zoomWindowOffset(
        times.length,
        historyOffsetRef.current,
        currentCount,
        next,
        centerFraction,
      ),
    );
  };
  applyZoomRef.current = applyZoom;
  const saveZoom = () =>
    window.localStorage.setItem(
      storageKeyRef.current,
      String(visibleCountRef.current),
    );
  const requestOlder = () => {
    if (prefetchRequested.current) return;
    prefetchRequested.current = true;
    void onLoadOlderRef.current().finally(() => {
      prefetchRequested.current = false;
    });
  };
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    activePointers.current.set(event.pointerId, event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (activePointers.current.size >= 2) {
      const xs = [...activePointers.current.values()];
      pinchStartDistance.current = Math.abs(xs[1] - xs[0]) || 1;
      pinchStartCount.current = visibleCountRef.current;
      const bounds = event.currentTarget.getBoundingClientRect();
      pinchAnchor.current = Math.min(
        1,
        Math.max(0, ((xs[0] + xs[1]) / 2 - bounds.left) / bounds.width),
      );
      dragStart.current = null;
      return;
    }
    dragStart.current = event.clientX;
    dragAnchor.current = historyOffsetRef.current;
    dragged.current = false;
  };
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (activePointers.current.has(event.pointerId))
      activePointers.current.set(event.pointerId, event.clientX);
    if (
      activePointers.current.size >= 2 &&
      pinchStartDistance.current !== null
    ) {
      const xs = [...activePointers.current.values()];
      applyZoom(
        Math.round(
          (pinchStartCount.current * pinchStartDistance.current) /
            Math.max(1, Math.abs(xs[1] - xs[0])),
        ),
        pinchAnchor.current,
      );
      return;
    }
    pendingPointerX.current = event.clientX;
    if (dragFrame.current !== null) return;
    dragFrame.current = window.requestAnimationFrame(() => {
      dragFrame.current = null;
      if (dragStart.current === null || pendingPointerX.current === null)
        return;
      const delta = pendingPointerX.current - dragStart.current;
      if (Math.abs(delta) > 3) {
        dragged.current = true;
        onDrag?.();
      }
      const count = visibleCountRef.current;
      const maximum = Math.max(0, times.length - count);
      const nextOffset = Math.max(
        0,
        Math.min(
          maximum,
          dragAnchor.current + Math.round(delta / Math.max(step, 1)),
        ),
      );
      updateOffset(nextOffset);
      if (
        delta > step &&
        times.length &&
        nearHistoryStart(times.length, nextOffset, count, warmupPoints)
      )
        requestOlder();
    });
  };
  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragFrame.current !== null)
      window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    pendingPointerX.current = null;
    activePointers.current.delete(event.pointerId);
    if (activePointers.current.size < 2 && pinchStartDistance.current !== null) {
      pinchStartDistance.current = null;
      saveZoom();
    }
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleTouchStart = (event: React.TouchEvent<SVGSVGElement>) => {
    if (event.touches.length < 2) return;
    event.preventDefault();
    const [first, second] = [event.touches[0], event.touches[1]];
    pinchStartDistance.current =
      Math.hypot(
        second.clientX - first.clientX,
        second.clientY - first.clientY,
      ) || 1;
    pinchStartCount.current = visibleCountRef.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    pinchAnchor.current = Math.min(
      1,
      Math.max(
        0,
        ((first.clientX + second.clientX) / 2 - bounds.left) / bounds.width,
      ),
    );
    dragStart.current = null;
  };
  const handleTouchMove = (event: React.TouchEvent<SVGSVGElement>) => {
    if (event.touches.length < 2 || pinchStartDistance.current === null) return;
    event.preventDefault();
    const [first, second] = [event.touches[0], event.touches[1]];
    applyZoom(
      Math.round(
        (pinchStartCount.current * pinchStartDistance.current) /
          Math.max(
            1,
            Math.hypot(
              second.clientX - first.clientX,
              second.clientY - first.clientY,
            ),
          ),
      ),
      pinchAnchor.current,
    );
  };
  const handleTouchEnd = (event: React.TouchEvent<SVGSVGElement>) => {
    if (event.touches.length < 2 && pinchStartDistance.current !== null) {
      pinchStartDistance.current = null;
      saveZoom();
    }
  };
  useLayoutEffect(() => {
    const svg = chartRef.current;
    if (!svg) return;
    let wheelPan = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey && event.deltaY) {
        event.preventDefault();
        const bounds = svg.getBoundingClientRect();
        const appliedSteps = event.deltaY < 0 ? -1 : 1;
        applyZoomRef.current(
          visibleCountRef.current + appliedSteps,
          Math.min(
            1,
            Math.max(0, (event.clientX - bounds.left) / bounds.width),
          ),
        );
        if (zoomSaveTimer.current !== null)
          window.clearTimeout(zoomSaveTimer.current);
        zoomSaveTimer.current = window.setTimeout(saveZoom, 180);
        return;
      }
      if (!event.deltaX || Math.abs(event.deltaX) <= Math.abs(event.deltaY))
        return;
      event.preventDefault();
      wheelPan -= event.deltaX;
      const chartStep = Math.max(stepRef.current, 1);
      const appliedSteps = Math.trunc(wheelPan / chartStep);
      if (!appliedSteps) return;
      wheelPan -= appliedSteps * chartStep;
      const count = visibleCountRef.current;
      const total = timesLengthRef.current;
      const nextOffset = panWindowOffset(
        total,
        historyOffsetRef.current,
        count,
        appliedSteps,
      );
      updateOffset(nextOffset);
      if (
        appliedSteps > 0 &&
        nearHistoryStart(
          total,
          nextOffset,
          count,
          warmupPointsRef.current,
        )
      )
        requestOlder();
    };
    let startScale = 1;
    const start = (event: Event) => {
      startScale = (event as Event & { scale?: number }).scale || 1;
      pinchStartCount.current = visibleCountRef.current;
      event.preventDefault();
    };
    const change = (event: Event) => {
      const scale = (event as Event & { scale?: number }).scale || 1;
      applyZoomRef.current(
        Math.round(pinchStartCount.current / (scale / startScale)),
        0.5,
      );
      event.preventDefault();
    };
    const end = () => saveZoom();
    svg.addEventListener("wheel", wheel, { passive: false });
    svg.addEventListener("gesturestart", start, { passive: false });
    svg.addEventListener("gesturechange", change, { passive: false });
    svg.addEventListener("gestureend", end);
    return () => {
      svg.removeEventListener("wheel", wheel);
      svg.removeEventListener("gesturestart", start);
      svg.removeEventListener("gesturechange", change);
      svg.removeEventListener("gestureend", end);
    };
  }, [Boolean(times.length)]);
  return {
    chartRef,
    dragged,
    visibleCountRef,
    historyOffsetRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}

function TimeShareChart({
  candles,
  selectedIndex,
  onSelect,
  onLoadOlder,
  onVisibleChange,
  last,
}: {
  candles: CoinMCandle[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onLoadOlder: () => Promise<void>;
  onVisibleChange: (candles: CoinMCandle[]) => void;
  last: number;
}) {
  const [historyOffset, setHistoryOffset] = useState(0);
  const [visibleCount, setVisibleCount] = useState(() => {
    const saved = Number(window.localStorage.getItem(TIME_SHARE_ZOOM_KEY));
    return Number.isFinite(saved)
      ? Math.min(
          MAX_TIME_SHARE_POINTS,
          Math.max(MIN_TIME_SHARE_POINTS, Math.round(saved)),
        )
      : 120;
  });
  const candleTimes = useMemo(
    () => candles.map((item) => item.time),
    [candles],
  );
  const width = 900;
  const height = 330;
  const pad = 20;
  const plotRight = width - 100;
  const visibleEnd = Math.max(0, candles.length - 1 - historyOffset);
  const start = Math.max(0, visibleEnd - visibleCount + 1);
  const visibleCandles = candles.slice(start, visibleEnd + 1);
  const low = visibleCandles.length
    ? Math.min(...visibleCandles.map((item) => item.low))
    : 0;
  const high = visibleCandles.length
    ? Math.max(...visibleCandles.map((item) => item.high))
    : 1;
  const range = high - low || 1;
  const step = (plotRight - pad) / Math.max(visibleCandles.length, 1);
  const navigation = useChartNavigation({
    times: candleTimes,
    visibleCount,
    setVisibleCount,
    historyOffset,
    setHistoryOffset,
    step,
    minPoints: MIN_TIME_SHARE_POINTS,
    maxPoints: MAX_TIME_SHARE_POINTS,
    storageKey: TIME_SHARE_ZOOM_KEY,
    onLoadOlder,
  });
  const y = (price: number) =>
    pad + ((high - price) / range) * (height - pad * 2);
  const closes = visibleCandles.map((item) => item.close);
  const average = closes.map(
    (_, index) =>
      closes
        .slice(Math.max(0, index - 59), index + 1)
        .reduce((sum, value) => sum + value, 0) / Math.min(index + 1, 60),
  );
  const pathFor = (values: Array<number | null>) => {
    let started = false;
    return values
      .flatMap((value, index) => {
        if (value === null) return [];
        const command = started ? "L" : "M";
        started = true;
        return [`${command} ${pad + index * step + step / 2} ${y(value)}`];
      })
      .join(" ");
  };
  const linePath = pathFor(closes);
  const areaPath = `${linePath} L ${pad + (visibleCandles.length - 1) * step + step / 2} ${height - pad} L ${pad + step / 2} ${height - pad} Z`;
  const selected = selectedIndex === null ? null : candles[selectedIndex];
  const selectedLocalIndex =
    selectedIndex === null ? null : selectedIndex - start;
  const visibleLast = visibleCandles.at(-1)?.close ?? last;
  useEffect(() => {
    onVisibleChange(visibleCandles);
  }, [start, visibleEnd, visibleLast, candles.length]);
  const lastY = y(visibleLast);
  const priceLabel = visibleLast.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
  const axisPoints = [0, 1, 2, 3, 4, 5];
  const axisIndices = fixedTimeTickIndices(
    visibleCandles.map((item) => Math.floor(item.time / 60_000)),
    chartTickSpacing(visibleCount),
  );
  const datePoints = axisIndices.map((localIndex) => ({
    time: visibleCandles[localIndex].time,
    x: pad + localIndex * step + step / 2,
  }));
  const formatTime = (time: number) =>
    new Date(time).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const handleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (navigation.dragged.current) {
      navigation.dragged.current = false;
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - bounds.left) / bounds.width) * width;
    onSelect(
      start +
        Math.max(
          0,
          Math.min(
            visibleCandles.length - 1,
            Math.round((chartX - pad - step / 2) / step),
          ),
        ),
    );
  };
  return (
    <section className="coinm-time-share">
      <div className="coinm-ma-legend">
        <span className="time-ma-legend">
          MA(60):{" "}
          {average
            .at(-1)
            ?.toLocaleString(undefined, { maximumFractionDigits: 1 }) || "-"}
        </span>
      </div>
      <div className="coinm-chart-canvas">
        <svg
          ref={navigation.chartRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="BTCUSD coin-m time-sharing chart"
          onClick={handleClick}
          onPointerDown={navigation.handlePointerDown}
          onPointerMove={navigation.handlePointerMove}
          onPointerUp={navigation.handlePointerUp}
          onPointerCancel={navigation.handlePointerUp}
          onTouchStart={navigation.handleTouchStart}
          onTouchMove={navigation.handleTouchMove}
          onTouchEnd={navigation.handleTouchEnd}
          onTouchCancel={navigation.handleTouchEnd}
        >
          <g className="chart-grid">
            {axisPoints.map((line) => (
              <line
                key={line}
                x1={pad}
                x2={width}
                y1={pad + (line * (height - pad * 2)) / 5}
                y2={pad + (line * (height - pad * 2)) / 5}
              />
            ))}
            {datePoints.map((item) => (
              <line
                className="time-date-guide"
                key={item.time}
                x1={item.x}
                x2={item.x}
                y1={pad}
                y2={height - pad}
              />
            ))}
            <path className="time-area" d={areaPath} />
            <path className="time-line" d={linePath} />
            <path className="time-ma" d={pathFor(average)} />
            {selected &&
              selectedLocalIndex !== null &&
              selectedLocalIndex >= 0 &&
              selectedLocalIndex < visibleCandles.length && (
                <g className="chart-crosshair">
                  <line
                    x1={pad + selectedLocalIndex * step + step / 2}
                    x2={pad + selectedLocalIndex * step + step / 2}
                    y1={pad}
                    y2={height - pad}
                  />
                  <line
                    x1={pad}
                    x2={width}
                    y1={y(selected.close)}
                    y2={y(selected.close)}
                  />
                  <circle
                    cx={pad + selectedLocalIndex * step + step / 2}
                    cy={y(selected.close)}
                    r="4"
                  />
                </g>
              )}
          </g>
          <line
            className="time-price-guide"
            x1={pad}
            x2={width}
            y1={lastY}
            y2={lastY}
          />
        </svg>
        <div className="coinm-axis">
          {axisPoints.map((line) => (
            <span
              key={line}
              style={{
                top: `${((pad + (line * (height - pad * 2)) / 5) / height) * 100}%`,
              }}
            >
              {(high - (line * range) / 5).toLocaleString(undefined, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })}
            </span>
          ))}
        </div>
        {visibleCandles.length > 0 && (
          <div
            className="time-price-overlay"
            style={{ top: `${(lastY / height) * 100}%` }}
          >
            {priceLabel}
          </div>
        )}
        <div className="time-x-axis">
          {datePoints.map((item) => (
            <span
              key={item.time}
              style={{ left: `${(item.x / width) * 100}%` }}
            >
              {formatTime(item.time)}
            </span>
          ))}
        </div>
        {selected && (
          <div className="coinm-tooltip">
            <b>{formatTime(selected.time)}</b>
            <span>
              价格 <em>{selected.close.toLocaleString()}</em>
            </span>
            <span>
              涨跌{" "}
              <em
                className={
                  selected.close >= selected.open ? "positive" : "negative"
                }
              >
                {(selected.close - selected.open).toFixed(1)}
              </em>
            </span>
            <span>
              涨跌幅{" "}
              <em>
                {(
                  ((selected.close - selected.open) / selected.open) *
                  100
                ).toFixed(2)}
                %
              </em>
            </span>
            <span>
              量 <em>{selected.volume.toLocaleString()}</em>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function ContractHistory({
  marketType,
  onBack,
}: {
  marketType: "usdm" | "coinm";
  onBack: () => void;
}) {
  const tabs = [
    "当前委托",
    "历史委托",
    "仓位历史",
    "历史成交",
    "资金流水",
    "资金费率",
  ] as const;
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("历史成交");
  const [rows, setRows] = useState<FuturesTrade[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    if (marketType !== "usdm") {
      setLoading(false);
      return;
    }
    void api<{ rows: FuturesTrade[] }>("/usdm-history?symbol=BTCUSDT")
      .then((result) => {
        if (active) setRows(result.rows);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [marketType]);
  return (
    <section className="contract-history">
      <header>
        <button title="返回" aria-label="返回" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <div>
          <strong>交易</strong>
          <span>{marketType === "usdm" ? "U 本位合约" : "币本位合约"}</span>
        </div>
      </header>
      <nav className="contract-history-tabs" aria-label="历史记录分类">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab ? "active" : ""}
            key={tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>
      {activeTab === "历史成交" ? (
        <div className="trade-history-list">
          {loading ? (
            <p className="history-empty">正在读取历史成交…</p>
          ) : rows.length ? (
            rows.map((trade) => (
              <article key={`${trade.id}-${trade.time}`}>
                <header>
                  <div>
                    <strong>{trade.symbol}</strong>
                    <span>永续</span>
                    <b
                      className={trade.side === "BUY" ? "positive" : "negative"}
                    >
                      {trade.side === "BUY" ? "买入" : "卖出"}
                      {trade.positionSide && trade.positionSide !== "BOTH"
                        ? ` · ${trade.positionSide}`
                        : ""}
                    </b>
                  </div>
                  <time>
                    {new Date(trade.time).toLocaleString("zh-CN", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                </header>
                <dl>
                  <div>
                    <dt>订单号</dt>
                    <dd>{trade.orderId}</dd>
                  </div>
                  <div>
                    <dt>价格</dt>
                    <dd>{Number(trade.price).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>成交数量 (BTC)</dt>
                    <dd>{Number(trade.qty).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>手续费 ({trade.commissionAsset || "USDT"})</dt>
                    <dd>{Number(trade.commission).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>角色</dt>
                    <dd>{trade.maker ? "挂单" : "吃单"}</dd>
                  </div>
                  <div>
                    <dt>已实现盈亏 (USDT)</dt>
                    <dd
                      className={
                        Number(trade.realizedPnl) >= 0 ? "positive" : "negative"
                      }
                    >
                      {Number(trade.realizedPnl).toFixed(8)}
                    </dd>
                  </div>
                </dl>
              </article>
            ))
          ) : (
            <p className="history-empty">暂无历史成交</p>
          )}
        </div>
      ) : (
        <p className="history-empty">暂无记录</p>
      )}
    </section>
  );
}

function CoinMWorkspace({
  onMarketContext,
}: {
  onMarketContext: (context: MarketContext) => void;
}) {
  const [marketType, setMarketType] = useState<"usdm" | "coinm">("coinm");
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [interval, setInterval] = useState("5m");
  const [market, setMarket] = useState<CoinMMarket | null>(null);
  const [error, setError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [tickDirection, setTickDirection] = useState<"up" | "down" | "">("");
  const [priceGrouping, setPriceGrouping] = useState("0.1");
  const [secondRows, setSecondRows] = useState<KlineRow[]>([]);
  const [klineOffset, setKlineOffset] = useState(0);
  const [klineVisibleCount, setKlineVisibleCount] = useState(() =>
    Math.min(
      MAX_KLINE_POINTS,
      Math.max(
        MIN_KLINE_POINTS,
        Number(
          window.localStorage.getItem("crypto-agent-kline-visible-points:5m"),
        ) || 120,
      ),
    ),
  );
  const marketCache = useRef(new Map<string, CoinMMarket>());
  const klineViewCache = useRef(new Map<string, { offset: number }>());
  const pendingScrollTop = useRef<number | null>(null);
  const latestMarket = useRef<CoinMMarket | null>(market);
  latestMarket.current = market;
  const previousPrice = useRef(0);
  const pendingPrice = useRef<number | null>(null);
  const pendingDepth = useRef<{ bids: string[][]; asks: string[][] } | null>(
    null,
  );
  const pendingRelay = useRef<CoinMMarket | null>(null);
  const pendingSecondRows = useRef<KlineRow[]>([]);
  const loadingOlder = useRef(false);
  const oldestReached = useRef(false);
  const timeVisibleCandles = useRef<CoinMCandle[]>([]);
  const orderBook = useRef({
    bids: new Map<string, string>(),
    asks: new Map<string, string>(),
  });
  const depthCache = useRef(
    new Map<"usdm" | "coinm", { bids: string[][]; asks: string[][] }>(),
  );
  const marketPriceCache = useRef(new Map<"usdm" | "coinm", number>());
  const marketSymbol = marketType === "usdm" ? "BTCUSDT" : "BTCUSD_PERP";
  const marketPath = marketType === "usdm" ? "usdm-market" : "coinm-market";
  const marketCacheKey = `${marketType}:${interval}`;
  const changeInterval = (next: string) => {
    if (next === interval) return;
    const content = document.querySelector<HTMLElement>(".asset-content");
    pendingScrollTop.current = content?.scrollTop ?? null;
    klineViewCache.current.set(marketCacheKey, {
      offset: klineOffset,
    });
    window.localStorage.setItem(
      `crypto-agent-kline-visible-points:${interval}`,
      String(klineVisibleCount),
    );
    setKlineVisibleCount(
      Math.min(
        MAX_KLINE_POINTS,
        Math.max(
          MIN_KLINE_POINTS,
          Number(
            window.localStorage.getItem(
              `crypto-agent-kline-visible-points:${next}`,
            ),
          ) || 120,
        ),
      ),
    );
    setInterval(next);
    setSelectedIndex(null);
  };
  useLayoutEffect(() => {
    if (pendingScrollTop.current === null) return;
    const top = pendingScrollTop.current;
    pendingScrollTop.current = null;
    const content = document.querySelector<HTMLElement>(".asset-content");
    if (content) content.scrollTop = top;
    const frame = window.requestAnimationFrame(() => {
      if (content) content.scrollTop = top;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [interval, marketType]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.(".coinm-chart-canvas svg"))
        setSelectedIndex(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    let active = true;
    if (interval === "1s") {
      pendingSecondRows.current = [];
      setSecondRows([]);
    }
    const cachedMarket = marketCache.current.get(marketCacheKey);
    setMarket(cachedMarket || null);
    const cachedView = klineViewCache.current.get(marketCacheKey);
    setKlineOffset(cachedView?.offset || 0);
    oldestReached.current = false;
    const sourceInterval =
      interval === "time" || interval === "1s" ? "1m" : interval;
    const load = () =>
      api<CoinMMarket>(
        `/${marketPath}?symbol=${marketSymbol}&interval=${sourceInterval}`,
      )
        .then((result) => {
          if (active) {
            orderBook.current = {
              bids: new Map(
                result.depth.bids.map(
                  ([price, quantity]) => [price, quantity] as const,
                ),
              ),
              asks: new Map(
                result.depth.asks.map(
                  ([price, quantity]) => [price, quantity] as const,
                ),
              ),
            };
            setMarket((current) => {
              const next =
                current?.symbol === result.symbol &&
                current.interval === result.interval
                  ? {
                      ...result,
                      klines: mergeKlineRows(current.klines, result.klines),
                    }
                  : result;
              marketCache.current.set(marketCacheKey, next);
              return next;
            });
            setError("");
          }
        })
        .catch((caught) => {
          if (active)
            setError(
              caught instanceof Error
                ? caught.message
                : `${marketType === "usdm" ? "U 本位" : "币本位"}行情不可用`,
            );
        });
    void load();
    const timer = window.setInterval(load, marketType === "usdm" ? 2_000 : 60_000);
    const loadSeconds = () =>
      api<CoinMMarket>(`/${marketType}-1s?symbol=${marketSymbol}`)
        .then((result) => {
          if (!active) return;
          pendingSecondRows.current = mergeKlineRows(
            fillSecondRows(result.klines),
            pendingSecondRows.current,
          );
          setSecondRows(pendingSecondRows.current);
        })
        .catch(() => {});
    if (interval === "1s") void loadSeconds();
    const secondTimer =
      interval === "1s" ? window.setInterval(loadSeconds, 1_000) : null;
    const serverStream =
      marketType === "coinm"
        ? new EventSource(
            `/api/coinm-stream?interval=${interval === "time" || interval === "1s" ? "1m" : interval}`,
          )
        : null;
    if (serverStream) {
      serverStream.addEventListener("market", (event) => {
        try {
          pendingRelay.current = JSON.parse(
            (event as MessageEvent).data,
          ) as CoinMMarket;
        } catch {
          /* ignore malformed relay events */
        }
      });
      serverStream.onerror = () => {
        serverStream.close();
        if (active) setError("服务端行情暂时中断");
      };
    }
    const bookTimer = window.setInterval(() => {
      const price = pendingPrice.current;
      const depth = pendingDepth.current;
      if (price === null && !depth) return;
      if (price !== null) {
        if (previousPrice.current)
          setTickDirection(price >= previousPrice.current ? "up" : "down");
        previousPrice.current = price;
      }
      setMarket((current) =>
        current
          ? {
              ...current,
              ...(price !== null && interval !== "1s"
                ? { klines: updateKlinePrice(current.klines, price) }
                : {}),
              ...(depth ? { depth } : {}),
              ...(price !== null
                ? { premium: { ...current.premium, markPrice: String(price) } }
                : {}),
            }
          : current,
      );
      if (interval === "1s") setSecondRows(pendingSecondRows.current);
      pendingPrice.current = null;
      pendingDepth.current = null;
    }, 400);
    const relayTimer = window.setInterval(() => {
      const next = pendingRelay.current;
      if (!next || !active) return;
      pendingRelay.current = null;
      const relayPrice = Number(next.premium.markPrice);
      if (interval === "1s" && relayPrice > 0) {
        pendingSecondRows.current = mergeTradeIntoSecondRows(
          pendingSecondRows.current,
          Date.now(),
          relayPrice,
          0,
        );
        setSecondRows(pendingSecondRows.current);
      }
      setMarket((current) => {
        if (!next.partial || !current || !next.klines[0]) return next;
        const klines = [...current.klines];
        const existing = klines.findIndex(
          (row) => Number(row[0]) === Number(next.klines[0][0]),
        );
        if (existing >= 0) klines[existing] = next.klines[0];
        else klines.push(next.klines[0]);
        return {
          ...next,
          orderBook24h: next.orderBook24h || current.orderBook24h,
          klines: updateKlinePrice(
            mergeKlineRows(klines, next.klines),
            Number(next.premium.markPrice),
          ),
        };
      });
    }, 300);
    return () => {
      active = false;
      window.clearInterval(timer);
      if (secondTimer !== null) window.clearInterval(secondTimer);
      window.clearInterval(bookTimer);
      window.clearInterval(relayTimer);
      serverStream?.close();
      if (latestMarket.current)
        marketCache.current.set(marketCacheKey, latestMarket.current);
    };
  }, [interval, marketType, marketCacheKey]);
  const chartRows = interval === "1s" ? secondRows : market?.klines || [];
  const allCandles = [
    ...new Map(
      chartRows.map((item) => [
        Number(item[0]),
        {
          time: Number(item[0]),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5]),
          quoteVolume: Number(item[7]),
        },
      ]),
    ).values(),
  ];
  const candleTimes = useMemo(
    () => allCandles.map((item) => item.time),
    [allCandles],
  );
  const candles = klineWindow(allCandles, klineOffset, klineVisibleCount);
  const candleStartIndex = candles.length
    ? allCandles.findIndex((item) => item.time === candles[0].time)
    : 0;
  const width = 900;
  const height = 330;
  const pad = 20;
  const plotRight = width - 100;
  const maValues = (period: number) =>
    candles.map((_, localIndex) => {
      const index = candleStartIndex + localIndex;
      const window = allCandles.slice(
        Math.max(0, index - period + 1),
        index + 1,
      );
      return window.length
        ? window.reduce((sum, item) => sum + item.close, 0) / window.length
        : null;
    });
  const ma7 = maValues(7);
  const ma25 = maValues(25);
  const ma99 = maValues(99);
  const currentMarketPrice =
    market?.symbol === marketSymbol
      ? Number(market.premium.markPrice || candles.at(-1)?.close || 0)
      : 0;
  if (currentMarketPrice > 0)
    marketPriceCache.current.set(marketType, currentMarketPrice);
  const livePrice =
    currentMarketPrice || marketPriceCache.current.get(marketType) || 0;
  const scaleValues = [
    ...candles.flatMap((item) => [item.low, item.high]),
    ...ma7,
    ...ma25,
    ...ma99,
    livePrice || null,
  ].filter((value): value is number => value !== null);
  const scaleLow = scaleValues.length ? Math.min(...scaleValues) : 0;
  const scaleHigh = scaleValues.length ? Math.max(...scaleValues) : 1;
  const scalePadding = (scaleHigh - scaleLow || Math.abs(scaleHigh) * 0.0001 || 1) * 0.05;
  const low = scaleLow - scalePadding;
  const high = scaleHigh + scalePadding;
  const range = high - low || 1;
  const step = (plotRight - pad) / Math.max(candles.length, 1);
  const y = (price: number) =>
    pad + ((high - price) / range) * (height - pad * 2);
  const maPath = (values: Array<number | null>) =>
    values
      .map((value, index) =>
        value === null
          ? ""
          : `${values.slice(0, index).every((item) => item === null) ? "M" : "L"} ${pad + index * step + step / 2} ${y(value)}`,
      )
      .join(" ");
  const last = livePrice;
  const xAxisIndices = fixedTimeTickIndices(
    candles.map((item) => {
      if (interval !== "1M")
        return Math.floor(item.time / (KLINE_INTERVAL_MS[interval] || 60_000));
      const date = new Date(item.time);
      return date.getUTCFullYear() * 12 + date.getUTCMonth();
    }),
    chartTickSpacing(klineVisibleCount),
  );
  const axisTime = (time: number) =>
    new Date(time).toLocaleString(
      "zh-CN",
      interval === "1s"
        ? {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }
        : ["1d", "1w", "1M"].includes(interval)
          ? { month: "2-digit", day: "2-digit" }
          : {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            },
    );
  const groupDepth = (levels: string[][], side: "ask" | "bid") => {
    const size = Number(priceGrouping);
    const grouped = new Map<number, number>();
    for (const [rawPrice, rawQuantity] of levels) {
      const quantity = Number(rawQuantity);
      if (!(quantity > 0)) continue;
      const price = Number(rawPrice);
      const bucket = Number(
        (
          (side === "ask"
            ? Math.ceil(price / size)
            : Math.floor(price / size)) * size
        ).toFixed(size < 1 ? 1 : 0),
      );
      grouped.set(bucket, (grouped.get(bucket) || 0) + quantity);
    }
    const sorted = [...grouped].sort(([left], [right]) =>
      side === "ask" ? left - right : right - left,
    );
    return sorted
      .slice(0, 6)
      .map(([price, quantity]) => [String(price), String(quantity)]);
  };
  if (
    market?.symbol === marketSymbol &&
    (market.depth.asks.length || market.depth.bids.length)
  )
    depthCache.current.set(marketType, market.depth);
  const cachedDepth =
    market?.symbol === marketSymbol &&
    (market.depth.asks.length || market.depth.bids.length)
      ? market.depth
      : depthCache.current.get(marketType);
  const padDepth = (levels: string[][], side: "ask" | "bid") => {
    const grouped = groupDepth(levels, side);
    return [
      ...grouped,
      ...Array.from({ length: 6 - grouped.length }, () => ["", ""]),
    ];
  };
  const displayAsks = padDepth(cachedDepth?.asks || [], "ask");
  const displayBids = padDepth(cachedDepth?.bids || [], "bid");
  const depthMax = Math.max(
    ...displayAsks.map(([, quantity]) => Number(quantity)),
    ...displayBids.map(([, quantity]) => Number(quantity)),
    1,
  );
  const askTotal = displayAsks.reduce(
    (sum, [, quantity]) => sum + Number(quantity),
    0,
  );
  const bidTotal = displayBids.reduce(
    (sum, [, quantity]) => sum + Number(quantity),
    0,
  );
  const bidPercent =
    bidTotal + askTotal ? (bidTotal / (bidTotal + askTotal)) * 100 : 50;
  const bookPrice = (value: string | number) =>
    Number(value).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const first = candles[0]?.open || last;
  const change = first ? ((last - first) / first) * 100 : 0;
  const selected = selectedIndex === null ? null : candles[selectedIndex];
  const axisValues = [0, 1, 2, 3, 4, 5].map((line) => high - (line * range) / 5);
  const selectCandle = (event: React.MouseEvent<SVGSVGElement>) => {
    if (klineNavigation.dragged.current) {
      klineNavigation.dragged.current = false;
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - bounds.left) / bounds.width) * width;
    setSelectedIndex(
      Math.max(
        0,
        Math.min(
          candles.length - 1,
          Math.round((chartX - pad - step / 2) / step),
        ),
      ),
    );
  };
  const selectTimeShare = (index: number) => setSelectedIndex(index);
  const loadOlderTimeShare = () => {
    const before = allCandles[0]?.time;
    if (!before || loadingOlder.current || oldestReached.current)
      return Promise.resolve();
    loadingOlder.current = true;
    return api<CoinMMarket>(
      `/${marketPath}?symbol=${marketSymbol}&interval=1m&endTime=${before - 1}`,
    )
      .then((result) => {
        const older = result.klines.filter((row) => Number(row[0]) < before);
        oldestReached.current = older.length === 0;
        if (older.length) {
          setSelectedIndex(null);
          setMarket((current) =>
            current
              ? { ...current, klines: mergeKlineRows(current.klines, older) }
              : current,
          );
        }
      })
      .catch(() => setError("历史分时数据暂时不可用"))
      .finally(() => {
        loadingOlder.current = false;
      });
  };
  const loadOlderKlines = () => {
    const before = allCandles[0]?.time;
    if (
      !before ||
      interval === "time" ||
      loadingOlder.current ||
      oldestReached.current
    )
      return Promise.resolve();
    loadingOlder.current = true;
    if (interval === "1s")
      return api<CoinMMarket>(
        `/${marketType}-1s?symbol=${marketSymbol}&endTime=${before - 1}`,
      )
        .then((result) => {
          const older = fillSecondRows(result.klines).filter(
            (row) => Number(row[0]) < before,
          );
          oldestReached.current = older.length === 0;
          if (!older.length) return;
          pendingSecondRows.current = mergeKlineRows(
            pendingSecondRows.current,
            older,
          );
          setSecondRows(pendingSecondRows.current);
        })
        .catch(() => setError("历史 1 秒 K 线暂时不可用"))
        .finally(() => {
          loadingOlder.current = false;
        });
    return api<CoinMMarket>(
      `/${marketPath}?symbol=${marketSymbol}&interval=${interval}&endTime=${before - 1}`,
    )
      .then((result) => {
        const older = result.klines.filter((row) => Number(row[0]) < before);
        oldestReached.current = older.length === 0;
        if (older.length) {
          setMarket((current) =>
            current
              ? { ...current, klines: mergeKlineRows(current.klines, older) }
              : current,
          );
        }
      })
      .catch(() => setError("历史 K 线暂时不可用"))
      .finally(() => {
        loadingOlder.current = false;
      });
  };
  const klineNavigation = useChartNavigation({
    times: candleTimes,
    visibleCount: klineVisibleCount,
    setVisibleCount: setKlineVisibleCount,
    historyOffset: klineOffset,
    setHistoryOffset: setKlineOffset,
    step,
    minPoints: MIN_KLINE_POINTS,
    maxPoints: MAX_KLINE_POINTS,
    warmupPoints: 99,
    storageKey: `crypto-agent-kline-visible-points:${interval}`,
    onLoadOlder: loadOlderKlines,
    onDrag: () => setSelectedIndex(null),
  });
  const contextDepth = (levels: string[][]) =>
    levels
      .slice(0, 20)
      .reduce((sum, [, quantity]) => sum + Number(quantity), 0);
  const publishMarketContext = (
    visible: CoinMCandle[],
    displayInterval = interval,
  ) => {
    const bids = market?.depth.bids || [];
    const asks = market?.depth.asks || [];
    const bid = Number(bids[0]?.[0] || 0);
    const ask = Number(asks[0]?.[0] || 0);
    const mid = bid && ask ? (bid + ask) / 2 : last;
    onMarketContext({
      symbol: marketSymbol,
      interval: displayInterval,
      candles: visible,
      markPrice: last,
      fundingRate: Number(market?.premium.lastFundingRate || 0),
      depth:
        bid && ask
          ? {
              bidDepth: contextDepth(bids),
              askDepth: contextDepth(asks),
              imbalance:
                (contextDepth(bids) - contextDepth(asks)) /
                Math.max(contextDepth(bids) + contextDepth(asks), 1),
              spreadBps: ((ask - bid) / mid) * 10_000,
            }
          : null,
      orderBook24h: market?.orderBook24h,
    });
  };
  const topBid = market?.depth.bids[0]?.join(":") || "";
  const topAsk = market?.depth.asks[0]?.join(":") || "";
  useEffect(() => {
    const visible = interval === "time" ? timeVisibleCandles.current : candles;
    if (visible.length)
      publishMarketContext(visible, interval === "time" ? "1m" : interval);
  }, [
    interval,
    candles.length,
    last,
    market?.premium.lastFundingRate,
    topBid,
    topAsk,
    market?.orderBook24h?.endTime,
  ]);
  if (historyOpen)
    return (
      <ContractHistory
        marketType={marketType}
        onBack={() => setHistoryOpen(false)}
      />
    );
  const quoteAsset = marketType === "usdm" ? "USDT" : "USD";
  const quantityAsset = marketType === "usdm" ? "BTC" : "张";
  return (
    <div className={`coinm-page${interval === "time" ? " time-mode" : ""}`}>
      <div className="coinm-products">
        <button
          className={marketType === "usdm" ? "active" : ""}
          onClick={() => {
            setMarketType("usdm");
            setMarket(null);
            setSelectedIndex(null);
          }}
        >
          U本位
        </button>
        <button
          className={marketType === "coinm" ? "active" : ""}
          onClick={() => {
            setMarketType("coinm");
            setMarket(null);
            setSelectedIndex(null);
          }}
        >
          币本位
        </button>
        <button>期权</button>
        <button>涨跌</button>
        <button>聪明钱</button>
      </div>
      <div className="coinm-heading">
        <div>
          <strong>{marketType === "usdm" ? "BTCUSDT" : "BTCUSD CM"}</strong>
          <span>永续</span>
          <b className={change >= 0 ? "positive" : "negative"}>
            {change >= 0 ? "+" : ""}
            {change.toFixed(2)}%
          </b>
        </div>
        <div className="contract-heading-actions">
          <small>
            资金费率{" "}
            {(Number(market?.premium.lastFundingRate || 0) * 100).toFixed(6)}%
          </small>
          <div className="contract-more">
            <button
              title="更多"
              aria-label="更多"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={20} />
            </button>
            {menuOpen && (
              <div className="contract-more-menu">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setHistoryOpen(true);
                  }}
                >
                  <History size={17} />
                  <span>历史记录</span>
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="coinm-trade-grid">
        <section className="coinm-order">
          <div className="coinm-order-tabs">
            <button className="active">开仓</button>
            <button>平仓</button>
          </div>
          <div className="coinm-order-options">
            <button>全仓</button>
            <button>20x</button>
          </div>
          <button className="coinm-select">市价单</button>
          <label>
            数量 <span>{quantityAsset}</span>
            <input inputMode="decimal" placeholder="0" />
          </label>
          <div className="coinm-order-buttons">
            <button disabled>开多 · 看涨</button>
            <button disabled>开空 · 看跌</button>
          </div>
        </section>
        <section className="coinm-book">
          <header>
            <span>价格 ({quoteAsset})</span>
            <span>数量 ({quantityAsset})</span>
          </header>
          {displayAsks
            .slice(0, 6)
            .reverse()
            .map(([price, quantity], index) => (
              <div className="ask" key={`ask-${index}`}>
                <i
                  style={{
                    width: `${Math.min(100, (Number(quantity) / depthMax) * 100)}%`,
                  }}
                />
                <span>{price ? bookPrice(price) : "-"}</span>
                <span>{quantity ? Number(quantity).toLocaleString() : "-"}</span>
              </div>
            ))}
          <strong
            className={
              tickDirection === "up"
                ? "tick-up"
                : tickDirection === "down"
                  ? "tick-down"
                  : ""
            }
          >
            {bookPrice(last)}
          </strong>
          {displayBids.slice(0, 6).map(([price, quantity], index) => (
            <div className="bid" key={`bid-${index}`}>
              <i
                style={{
                  width: `${Math.min(100, (Number(quantity) / depthMax) * 100)}%`,
                }}
              />
              <span>{price ? bookPrice(price) : "-"}</span>
              <span>{quantity ? Number(quantity).toLocaleString() : "-"}</span>
            </div>
          ))}
          <div className="depth-ratio">
            <span>{bidPercent.toFixed(2)}%</span>
            <i>
              <b style={{ width: `${bidPercent}%` }} />
            </i>
            <span>{(100 - bidPercent).toFixed(2)}%</span>
          </div>
          <label className="depth-grouping">
            <select
              value={priceGrouping}
              onChange={(event) => setPriceGrouping(event.target.value)}
            >
              {["0.1", "1", "10", "50", "100", "1000"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </section>
      </div>
      <div className="coinm-position-tabs">
        <b>持有仓位 (0)</b>
        <span>当前委托 (0)</span>
        <span>交易机器人</span>
      </div>
      <div className="coinm-intervals coinm-full-intervals">
        {[
          ["time", "分时"],
          ["1s", "1秒"],
          ["1m", "1分"],
          ["3m", "3分"],
          ["5m", "5分"],
          ["15m", "15分"],
          ["30m", "30分"],
          ["1h", "1小时"],
          ["2h", "2小时"],
          ["4h", "4小时"],
          ["6h", "6小时"],
          ["8h", "8小时"],
          ["12h", "12小时"],
          ["1d", "1天"],
          ["1w", "1周"],
          ["1M", "1月"],
        ].map(([id, label]) => (
          <button
            className={interval === id ? "active" : ""}
            key={id}
            onClick={() => changeInterval(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {interval === "time" && (
        <TimeShareChart
          candles={allCandles}
          selectedIndex={selectedIndex}
          onSelect={selectTimeShare}
          onLoadOlder={loadOlderTimeShare}
          onVisibleChange={(visible) => {
            timeVisibleCandles.current = visible;
            publishMarketContext(visible, "1m");
          }}
          last={last}
        />
      )}
      <section className="coinm-chart">
        <div className="coinm-intervals">
          {[
            ["1s", "1秒"],
            ["1m", "1分"],
            ["3m", "3分"],
            ["5m", "5分"],
            ["15m", "15分"],
            ["30m", "30分"],
            ["1h", "1小时"],
          ].map(([id, label]) => (
            <button
              className={interval === id ? "active" : ""}
              key={id}
              onClick={() => changeInterval(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="coinm-ma-legend">
          <span>
            MA(7):{" "}
            {ma7
              .at(-1)
              ?.toLocaleString(undefined, { maximumFractionDigits: 1 }) || "-"}
          </span>
          <span>
            MA(25):{" "}
            {ma25
              .at(-1)
              ?.toLocaleString(undefined, { maximumFractionDigits: 1 }) || "-"}
          </span>
          <span>
            MA(99):{" "}
            {ma99
              .at(-1)
              ?.toLocaleString(undefined, { maximumFractionDigits: 1 }) || "-"}
          </span>
        </div>
        {candles.length ? (
          <div className="coinm-chart-canvas">
            <svg
              ref={klineNavigation.chartRef}
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="BTCUSD coin-m candlestick chart"
              onClick={selectCandle}
              onPointerDown={klineNavigation.handlePointerDown}
              onPointerMove={klineNavigation.handlePointerMove}
              onPointerUp={klineNavigation.handlePointerUp}
              onPointerCancel={klineNavigation.handlePointerUp}
              onTouchStart={klineNavigation.handleTouchStart}
              onTouchMove={klineNavigation.handleTouchMove}
              onTouchEnd={klineNavigation.handleTouchEnd}
              onTouchCancel={klineNavigation.handleTouchEnd}
            >
              <g className="chart-grid">
                {[0, 1, 2, 3, 4, 5].map((line) => (
                  <line
                    key={line}
                    x1={pad}
                    x2={width}
                    y1={pad + (line * (height - pad * 2)) / 5}
                    y2={pad + (line * (height - pad * 2)) / 5}
                  />
                ))}
                {xAxisIndices.map((index) => (
                  <line
                    className="kline-date-guide"
                    key={`time-${index}`}
                    x1={pad + index * step + step / 2}
                    x2={pad + index * step + step / 2}
                    y1={pad}
                    y2={height - pad}
                  />
                ))}
              </g>
              {candles.map((item, index) => {
                const x = pad + index * step + step / 2;
                const displayOpen = candles[index - 1]?.close ?? item.open;
                const displayHigh = Math.max(item.high, displayOpen);
                const displayLow = Math.min(item.low, displayOpen);
                const rising = item.close >= displayOpen;
                return (
                  <g
                    className={rising ? "candle-up" : "candle-down"}
                    key={item.time}
                  >
                    <rect
                      x={x - step / 2}
                      y={Math.min(y(displayOpen), y(item.close))}
                      width={step}
                      height={Math.max(
                        1,
                        Math.abs(y(displayOpen) - y(item.close)),
                      )}
                    />
                    <line
                      x1={x}
                      x2={x}
                      y1={y(displayHigh)}
                      y2={y(displayLow)}
                    />
                  </g>
                );
              })}
              <path className="ma ma7" d={maPath(ma7)} />
              <path className="ma ma25" d={maPath(ma25)} />
              <path className="ma ma99" d={maPath(ma99)} />
              {last > 0 && (
                <line
                  className="current-price-guide"
                  x1={pad}
                  x2={width}
                  y1={y(last)}
                  y2={y(last)}
                />
              )}
              {selected && (
                <g className="chart-crosshair">
                  <line
                    x1={pad + selectedIndex! * step + step / 2}
                    x2={pad + selectedIndex! * step + step / 2}
                    y1={pad}
                    y2={height - pad}
                  />
                  <line
                    x1={pad}
                    x2={width}
                    y1={y(selected.close)}
                    y2={y(selected.close)}
                  />
                  <circle
                    cx={pad + selectedIndex! * step + step / 2}
                    cy={y(selected.close)}
                    r="4"
                  />
                </g>
              )}
            </svg>
            <div className="coinm-axis">
              {axisValues.map((value, index) => (
                <span
                  key={index}
                  style={{
                    top: `${((pad + (index * (height - pad * 2)) / 5) / height) * 100}%`,
                  }}
                >
                  {value.toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                </span>
              ))}
            </div>
            {last > 0 && (
              <div
                className="current-price-overlay"
                style={{ top: `${(y(last) / height) * 100}%` }}
              >
                {bookPrice(last)}
              </div>
            )}
            <div className="kline-x-axis">
              {xAxisIndices.map((index) => (
                <span
                  key={candles[index].time}
                  style={{
                    left: `${((pad + index * step + step / 2) / width) * 100}%`,
                  }}
                >
                  {axisTime(candles[index].time)}
                </span>
              ))}
            </div>
            {selected && (
              <div className="coinm-tooltip">
                <b>
                  {new Date(selected.time).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: interval === "1s" ? "2-digit" : undefined,
                  })}
                </b>
                <span>
                  开 <em>{selected.open.toLocaleString()}</em>
                </span>
                <span>
                  高 <em>{selected.high.toLocaleString()}</em>
                </span>
                <span>
                  低 <em>{selected.low.toLocaleString()}</em>
                </span>
                <span>
                  收 <em>{selected.close.toLocaleString()}</em>
                </span>
                <span>
                  涨跌{" "}
                  <em
                    className={
                      selected.close >= selected.open ? "positive" : "negative"
                    }
                  >
                    {(selected.close - selected.open).toFixed(1)}
                  </em>
                </span>
                <span>
                  涨跌幅{" "}
                  <em>
                    {(
                      ((selected.close - selected.open) / selected.open) *
                      100
                    ).toFixed(2)}
                    %
                  </em>
                </span>
                <span>
                  振幅{" "}
                  <em>
                    {(
                      ((selected.high - selected.low) / selected.open) *
                      100
                    ).toFixed(2)}
                    %
                  </em>
                </span>
                <span>
                  量 <em>{selected.volume.toLocaleString()}</em>
                </span>
                <span>
                  额 <em>{selected.quoteVolume.toLocaleString()}</em>
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="chart-empty">
            {error ||
              (interval === "1s" ? "正在聚合 1 秒 K 线…" : "正在读取 K 线…")}
          </div>
        )}
      </section>
    </div>
  );
}

function CoinIcon({ asset }: { asset: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="asset-symbol">
      {asset === "USDT" ? "₮" : asset.slice(0, 1)}
    </span>
  ) : (
    <img
      className="asset-symbol asset-icon-image"
      src={`https://bin.bnbstatic.com/static/assets/logos/${asset.toLowerCase()}.png`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

function AssetWorkspace({
  onMarketContext,
}: {
  onMarketContext: (context: MarketContext) => void;
}) {
  const [bottomTab, setBottomTab] = useState("assets");
  const [assetTab, setAssetTab] = useState<AssetTab>("overview");
  const [overviewTab, setOverviewTab] = useState<"all" | "accounts">("all");
  const [earnView, setEarnView] = useState<"assets" | "products">("assets");
  const [spotView, setSpotView] = useState<"spot" | "cross" | "isolated">(
    "spot",
  );
  const [data, setData] = useState<AssetSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [hidden, setHidden] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabScroll = useRef(new Map<string, number>());
  const changeBottomTab = (next: string) => {
    if (next === bottomTab) return;
    tabScroll.current.set(bottomTab, contentRef.current?.scrollTop || 0);
    setBottomTab(next);
  };
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const top = tabScroll.current.get(bottomTab) || 0;
    content.scrollTop = top;
    const frame = window.requestAnimationFrame(() => {
      content.scrollTop = top;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bottomTab]);
  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      setData(await api<AssetSnapshot>("/assets"));
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : "无法读取 Binance 资产",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const spot = data?.spot?.balances || [];
  const funding = data?.funding || [];
  const earn = data?.earn?.rows || [];
  const futuresAssets =
    data?.futures?.assets?.filter(
      (item) => Number(item.walletBalance) || Number(item.unrealizedProfit),
    ) || [];
  const assetTotals = aggregateAssetBalances({
    spot,
    funding,
    earn,
    futures: futuresAssets,
    prices: data?.prices,
  });
  const accountValues = {
    earn: assetTotals.reduce((sum, item) => sum + item.earn * item.price, 0),
    spot: assetTotals.reduce((sum, item) => sum + item.spot * item.price, 0),
    funding: assetTotals.reduce(
      (sum, item) => sum + item.funding * item.price,
      0,
    ),
    futures: assetTotals.reduce(
      (sum, item) => sum + item.futures * item.price,
      0,
    ),
  };
  const estimatedTotal = assetTotals.reduce(
    (sum, item) => sum + item.estimatedUsdt,
    0,
  );
  const cnyTotal = estimatedTotal * 6.74;
  const amount = (value: number | string | undefined) =>
    hidden ? "••••••" : formatNumber(value || 0);
  const summaryAmount = (value: number | string | undefined) =>
    hidden
      ? "••••••"
      : formatNumber(Math.floor(Number(value || 0) * 100) / 100);
  const earnRows =
    earnView === "assets"
      ? Object.entries(
          earn.reduce<Record<string, number>>((result, item) => {
            result[item.asset] =
              (result[item.asset] || 0) +
              Number(item.totalAmount || item.holdingAmount || 0);
            return result;
          }, {}),
        ).map(([asset, primary]) => ({
          asset,
          primary,
          secondary: "按资产汇总",
        }))
      : earn.map((item) => ({
          asset: item.productName || item.productId || item.asset,
          primary: item.totalAmount || item.holdingAmount || "0",
          secondary: `${item.asset} · 累计收益 ${amount(item.cumulativeTotalRewards)} · APR ${item.latestAnnualPercentageRate || "-"}`,
        }));
  const rows =
    assetTab === "spot"
      ? spotView === "spot"
        ? spot
            .filter((item) => !item.asset.startsWith("LD"))
            .map((item) => ({
              asset: item.asset,
              primary: Number(item.free) + Number(item.locked),
              secondary: `可用 ${amount(item.free)} · 冻结 ${amount(item.locked)}`,
            }))
        : []
      : assetTab === "funding"
        ? funding.map((item) => ({
            asset: item.asset,
            primary: Number(item.free) + Number(item.locked || 0),
            secondary: `可用 ${amount(item.free)} · 冻结 ${amount(item.locked)}`,
          }))
        : assetTab === "earn"
          ? earnRows
          : futuresAssets.map((item) => ({
              asset: item.asset,
              primary: item.walletBalance,
              secondary: `可用 ${amount(item.availableBalance)} · 未实现盈亏 ${amount(item.unrealizedProfit)}`,
            }));
  const tabs: Array<[AssetTab, string]> = [
    ["overview", "总览"],
    ["earn", "理财"],
    ["spot", "现货"],
    ["funding", "资金"],
    ["futures", "合约"],
  ];
  const nav = [
    [Home, "首页", "home"],
    [LineChart, "行情", "markets"],
    [ArrowLeftRight, "交易", "trade"],
    [FileText, "合约", "contracts"],
    [WalletCards, "资产", "assets"],
  ] as const;
  const accountRows = [
    ["理财", accountValues.earn],
    ["现货", accountValues.spot],
    ["资金", accountValues.funding],
    ["合约", accountValues.futures],
  ] as const;
  const assetName = (asset: string) => (asset === "USDT" ? "TetherUS" : asset);
  const visibleErrors =
    data?.errors.filter((item) => !item.startsWith("futures:")) || [];
  const totalValue =
    assetTab === "overview"
      ? estimatedTotal
      : assetTab === "futures"
        ? accountValues.futures
        : assetTab === "earn"
          ? accountValues.earn
          : assetTab === "spot"
            ? accountValues.spot
            : accountValues.funding;
  return (
    <section className="asset-app">
      <div className="asset-content" ref={contentRef}>
        <div hidden={bottomTab !== "assets"}>
            <div className="asset-tabs" role="tablist">
              {tabs.map(([id, label]) => (
                <button
                  className={assetTab === id ? "active" : ""}
                  key={id}
                  onClick={() => setAssetTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {assetTab === "spot" && (
              <div className="asset-subtabs" role="tablist">
                {(
                  [
                    ["spot", "现货账户"],
                    ["cross", "杠杆账户（全仓）"],
                    ["isolated", "杠杆账户（逐仓）"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    className={spotView === id ? "active" : ""}
                    key={id}
                    onClick={() => setSpotView(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="asset-summary">
              <div>
                <span>
                  {assetTab === "overview"
                    ? "预估总资产"
                    : `${tabs.find(([id]) => id === assetTab)?.[1]}资产`}
                </span>
                <button
                  title={hidden ? "显示余额" : "隐藏余额"}
                  aria-label={hidden ? "显示余额" : "隐藏余额"}
                  onClick={() => setHidden((value) => !value)}
                >
                  <Eye size={15} />
                </button>
              </div>
              <strong>
                {amount(totalValue)} <small>USDT</small>
              </strong>
              {assetTab === "overview" && (
                <div className="asset-cny">≈ ¥{amount(cnyTotal)}</div>
              )}
              <div className="asset-actions">
                <button disabled title="资金操作尚未启用">
                  添加资金
                </button>
                <button disabled title="资金操作尚未启用">
                  转出
                </button>
                <button disabled title="资金操作尚未启用">
                  划转
                </button>
              </div>
            </div>
            {assetTab === "overview" ? (
              <div className="wallet-overview">
                <div className="overview-tabs" role="tablist">
                  <button
                    className={overviewTab === "all" ? "active" : ""}
                    onClick={() => setOverviewTab("all")}
                  >
                    全部
                  </button>
                  <button
                    className={overviewTab === "accounts" ? "active" : ""}
                    onClick={() => setOverviewTab("accounts")}
                  >
                    账户
                  </button>
                  <button
                    className="overview-refresh"
                    title="刷新资产"
                    aria-label="刷新资产"
                    onClick={() => void load()}
                  >
                    <RefreshCw className={loading ? "spin" : ""} size={15} />
                  </button>
                </div>
                {overviewTab === "all"
                  ? assetTotals.map((item) => (
                      <div className="asset-row" key={item.asset}>
                        <div>
                          <CoinIcon asset={item.asset} />
                          <span>
                            <strong>{item.asset}</strong>
                            <small>
                              {item.asset === "USDT"
                                ? "TetherUS"
                                : `≈ ${amount(item.estimatedUsdt)} USDT`}
                            </small>
                          </span>
                        </div>
                        <b>{amount(item.total)}</b>
                      </div>
                    ))
                  : accountRows.map(([label, value]) => (
                      <div className="account-row" key={label}>
                        <strong>{label}</strong>
                        <b>{amount(value)} USDT</b>
                      </div>
                    ))}
              </div>
            ) : (
              <div className="asset-list">
                <div className="asset-list-heading">
                  <strong>
                    {tabs.find(([id]) => id === assetTab)?.[1]}资产
                  </strong>
                  {assetTab === "earn" ? (
                    <div className="inline-tabs">
                      <button
                        className={earnView === "assets" ? "active" : ""}
                        onClick={() => setEarnView("assets")}
                      >
                        按资产
                      </button>
                      <button
                        className={earnView === "products" ? "active" : ""}
                        onClick={() => setEarnView("products")}
                      >
                        按产品
                      </button>
                    </div>
                  ) : (
                    <Search size={17} />
                  )}
                </div>
                {rows.length ? (
                  rows.map((item) => (
                    <div className="asset-row" key={item.asset}>
                      <div>
                        <CoinIcon asset={item.asset} />
                        <span>
                          <strong>{item.asset}</strong>
                          <small>
                            {item.secondary || assetName(item.asset)}
                          </small>
                        </span>
                      </div>
                      <b>{amount(item.primary)}</b>
                    </div>
                  ))
                ) : (
                  <p className="asset-empty">
                    {loading
                      ? "正在读取 Binance 账户…"
                      : data?.errors.find((item) =>
                          item.startsWith(assetTab),
                        ) || "该账户暂无非零资产"}
                  </p>
                )}
              </div>
            )}
            {visibleErrors.length ? (
              <details className="asset-errors">
                <summary>部分账户不可用</summary>
                {visibleErrors.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </details>
            ) : null}
        </div>
        <div hidden={bottomTab !== "contracts"}>
          <CoinMWorkspace onMarketContext={onMarketContext} />
        </div>
        {bottomTab !== "assets" && bottomTab !== "contracts" && (
          <div className="asset-placeholder">
            <strong>{nav.find(([, , id]) => id === bottomTab)?.[1]}</strong>
            <span>此导航将在后续视图中实现</span>
          </div>
        )}
        {bottomTab === "assets" && loadError && (
          <p className="asset-load-error">{loadError}</p>
        )}
      </div>
      <nav
        className="asset-bottom-nav"
        aria-label="Binance workspace navigation"
      >
        {nav.map(([Icon, label, id]) => (
          <button
            className={bottomTab === id ? "active" : ""}
            key={id}
            onClick={() => changeBottomTab(id)}
          >
            <Icon size={19} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </section>
  );
}

export function App() {
  if (new URLSearchParams(window.location.search).get("widget") === "1")
    return (
      <main className="widget-shell">
        <PriceChart symbol="BTCUSDT" environment="live" />
      </main>
    );
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("crypto-agent-theme");
    return saved === "light" || saved === "dark" || saved === "system"
      ? saved
      : "system";
  });
  const [modelId, setModelId] = useState<ModelId>("gpt-5.6-luna");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningId>("medium");
  const [modelOpen, setModelOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      return JSON.parse(
        window.localStorage.getItem("crypto-agent-recents") || "[]",
      ) as ChatSession[];
    } catch {
      return [];
    }
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const marketContext = useRef<MarketContext | null>(null);
  useLayoutEffect(() => {
    const textarea =
      document.querySelector<HTMLTextAreaElement>(".composer textarea");
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, 144);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 144 ? "auto" : "hidden";
  }, [input]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const news: NewsItem[] = [];
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() =>
    Math.min(
      window.innerWidth * 0.2,
      Math.max(
        LEFT_SIDEBAR_MIN,
        Number(window.localStorage.getItem("crypto-agent-left-width")) ||
          window.innerWidth * 0.14,
      ),
    ),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    Math.min(
      window.innerWidth * 0.6,
      Math.max(
        window.innerWidth * 0.3,
        Number(window.localStorage.getItem("crypto-agent-right-width")) ||
          window.innerWidth * 0.36,
      ),
    ),
  );
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [resizing, setResizing] = useState<"left" | "right" | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const dragValue = useRef<number | null>(null);
  const dragFrame = useRef<number | null>(null);

  async function refresh() {
    try {
      const next = await api<Status>("/status");
      setStatus(next);
      if (next.model) {
        setModelId((current) =>
          next.model?.models.includes(current)
            ? current
            : next.model!.defaultModel,
        );
        setReasoningEffort((current) =>
          next.model?.reasoning.includes(current)
            ? current
            : next.model!.defaultReasoning,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("crypto-agent-theme", theme);
  }, [theme]);
  useEffect(() => {
    window.localStorage.setItem("crypto-agent-left-width", String(leftWidth));
  }, [leftWidth]);
  useEffect(() => {
    window.localStorage.setItem("crypto-agent-right-width", String(rightWidth));
  }, [rightWidth]);
  useEffect(() => {
    if (!modelOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node))
        setModelOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [modelOpen]);
  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      dragValue.current =
        resizing === "left"
          ? Math.min(
              window.innerWidth * 0.2,
              Math.max(LEFT_SIDEBAR_MIN, event.clientX),
            )
          : Math.min(
              window.innerWidth * 0.6,
              Math.max(
                window.innerWidth * 0.3,
                window.innerWidth - event.clientX,
              ),
            );
      if (dragFrame.current !== null) return;
      dragFrame.current = window.requestAnimationFrame(() => {
        if (dragValue.current !== null)
          shellRef.current?.style.setProperty(
            resizing === "left" ? "--left-width" : "--right-width",
            `${dragValue.current}px`,
          );
        dragFrame.current = null;
      });
    };
    const stop = () => {
      if (dragFrame.current !== null) {
        window.cancelAnimationFrame(dragFrame.current);
        dragFrame.current = null;
      }
      const value = dragValue.current;
      if (value !== null) {
        if (resizing === "left") setLeftWidth(value);
        else setRightWidth(value);
      }
      dragValue.current = null;
      setResizing(null);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [resizing]);
  useEffect(() => {
    const safeSessions = sessions
      .slice(0, 20)
      .map((session) => ({
        ...session,
        messages: session.messages.map(({ id, role, content, product }) => ({
          id,
          role,
          content,
          product,
        })),
      }));
    window.localStorage.setItem(
      "crypto-agent-recents",
      JSON.stringify(safeSessions),
    );
  }, [sessions]);

  function newChat() {
    setActiveSessionId(null);
    setMessages([]);
    setInput("");
    setAttachment(null);
    setError("");
  }
  function openSession(session: ChatSession) {
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setInput("");
    setAttachment(null);
    setError("");
  }

  async function send() {
    const content = input.trim() || (attachment ? "请分析这张图片。" : "");
    if (!content || busy) return;
    const sentAttachment = attachment;
    const user: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      ...(sentAttachment ? { attachment: sentAttachment } : {}),
    };
    const sessionId = activeSessionId || crypto.randomUUID();
    const title = content.length > 32 ? `${content.slice(0, 32)}...` : content;
    const baseMessages = [...messages, user];
    setActiveSessionId(sessionId);
    setMessages(baseMessages);
    setInput("");
    setAttachment(null);
    setBusy(true);
    setError("");
    try {
      const history = messages
        .slice(-12)
        .map(({ role, content }) => ({ role, content }));
      const result = await api<{
        reply: string;
        product?: Message["product"];
        draft?: Draft;
      }>("/chat", {
        method: "POST",
        body: JSON.stringify({
          message: content,
          model: modelId,
          reasoning_effort: reasoningEffort,
          history,
          marketContext: marketContext.current,
          ...(sentAttachment ? { image: sentAttachment.dataUrl } : {}),
        }),
      });
      const assistant: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        product: result.product,
        draft: result.draft,
      };
      setMessages((current) => [...current, assistant]);
      for (const chunk of result.reply.match(/.{1,4}/gs) || []) {
        await new Promise((resolve) => window.setTimeout(resolve, 12));
        setMessages((current) =>
          current.map((message) =>
            message.id === assistant.id
              ? { ...message, content: message.content + chunk }
              : message,
          ),
        );
      }
      const nextMessages = [
        ...baseMessages,
        { ...assistant, content: result.reply },
      ];
      setMessages(nextMessages);
      setSessions((existing) => [
        {
          id: sessionId,
          title: existing.find((item) => item.id === sessionId)?.title || title,
          messages: nextMessages,
          updatedAt: Date.now(),
        },
        ...existing.filter((item) => item.id !== sessionId),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to prepare the order.",
      );
    } finally {
      setBusy(false);
    }
  }

  const shellStyle = {
    "--left-width": leftCollapsed ? "0px" : `${leftWidth}px`,
    "--right-width": rightCollapsed ? "0px" : `${rightWidth}px`,
  } as CSSProperties;
  return (
    <main
      ref={shellRef}
      className={`terminal-shell ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""} ${resizing ? "is-resizing" : ""}`}
      style={shellStyle}
    >
      <aside className="portfolio">
        <header>
          <CircleDollarSign size={23} />
          <div>
            <strong>CryptoAgent</strong>
          </div>
          <button
            className="sidebar-toggle left-panel-toggle"
            title="隐藏左侧栏"
            aria-label="隐藏左侧栏"
            onClick={() => setLeftCollapsed(true)}
          >
            <PanelLeftClose size={17} />
          </button>
        </header>
        <button className="new-chat" onClick={newChat}>
          <Plus size={17} />
          New chat
        </button>
        <div className="sidebar-lists">
          <nav className="recents" aria-label="最近对话">
            <div className="section-title">
              <span>Recents</span>
            </div>
            <div className="recents-list">
              {sessions.length ? (
                sessions.map((session) => (
                  <button
                    className={activeSessionId === session.id ? "active" : ""}
                    key={session.id}
                    onClick={() => openSession(session)}
                  >
                    <MessageSquare size={14} />
                    <span>{session.title}</span>
                  </button>
                ))
              ) : (
                <p>暂无最近对话</p>
              )}
            </div>
          </nav>
          <MarketPanel items={news} />
        </div>
        <button
          className="settings-entry"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 size={16} />
          设置与外观
        </button>
        <button
          className="resize-handle left-resize"
          title="调整左侧栏宽度"
          aria-label="调整左侧栏宽度"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing("left");
          }}
        />
      </aside>
      {leftCollapsed && (
        <button
          className="sidebar-reopen left-reopen"
          title="显示左侧栏"
          aria-label="显示左侧栏"
          onClick={() => setLeftCollapsed(false)}
        >
          <PanelLeftOpen size={18} />
        </button>
      )}
      <section className="conversation">
        <div className="conversation-top">
          <div>
            <Bot size={18} />
            <strong>
              {activeSessionId
                ? sessions.find((item) => item.id === activeSessionId)?.title ||
                  "交易对话"
                : "新对话"}
            </strong>
          </div>
          <div className="top-actions">
            <span>{status?.environment === "live" ? "LIVE" : "TESTNET"}</span>
          </div>
        </div>
        <div className="messages">
          {!messages.length && (
            <div className="empty">
              <Bot size={32} />
              <h1>随时可以开始对话</h1>
            </div>
          )}
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="bubble">
                {message.attachment && (
                  <img
                    className="message-attachment"
                    src={message.attachment.dataUrl}
                    alt={message.attachment.name}
                  />
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
                {message.draft && (
                  <OrderDraft
                    draft={message.draft}
                    product={message.product}
                    onConfirmed={(order) => {
                      setMessages((current) =>
                        current.map((item) =>
                          item.id === message.id ? { ...item, order } : item,
                        ),
                      );
                      void refresh();
                    }}
                  />
                )}
                {message.order && (
                  <div className="order-success">
                    <Check size={16} />
                    订单已提交 · ID{" "}
                    {String(
                      message.order.orderId ||
                        message.order.clientOrderId ||
                        "accepted",
                    )}
                  </div>
                )}
              </div>
            </article>
          ))}
          {busy && (
            <article className="message assistant">
              <div className="bubble thinking">
                <i />
                <i />
                <i />
              </div>
            </article>
          )}
          {error && <div className="global-error">{error}</div>}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <div className="composer-input">
              {attachment && (
                <div className="composer-attachment">
                  <img src={attachment.dataUrl} alt={attachment.name} />
                  <span>{attachment.name}</span>
                  <button
                    title="移除图片"
                    aria-label="移除图片"
                    onClick={() => setAttachment(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <textarea
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={(event) => {
                  const file = [...event.clipboardData.items]
                    .find((item) => item.type.startsWith("image/"))
                    ?.getAsFile();
                  if (!file) return;
                  event.preventDefault();
                  void readImageAttachment(file)
                    .then(setAttachment)
                    .catch((caught) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "无法读取图片",
                      ),
                    );
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="输入交易指令、分析问题或粘贴图片"
              />
            </div>
            <div className="model-picker" ref={modelPickerRef}>
              <button
                className="model-trigger"
                aria-haspopup="menu"
                aria-expanded={modelOpen}
                onClick={() => setModelOpen((open) => !open)}
              >
                5.6{" "}
                {modelId.split("-").at(-1)![0].toUpperCase() +
                  modelId.split("-").at(-1)!.slice(1)}{" "}
                ·{" "}
                {
                  (
                    {
                      low: "Light",
                      medium: "Medium",
                      high: "High",
                      xhigh: "Extra High",
                      max: "Ultra",
                    } as Record<ReasoningId, string>
                  )[reasoningEffort]
                }
                <ChevronDown size={15} />
              </button>
              {modelOpen && (
                <div className="model-menu" role="menu">
                  <div className="model-menu-label">Reasoning</div>
                  {(
                    status?.model?.reasoning || [
                      "low",
                      "medium",
                      "high",
                      "xhigh",
                      "max",
                    ]
                  ).map((option) => (
                    <button
                      key={option}
                      className={reasoningEffort === option ? "selected" : ""}
                      onClick={() => {
                        setReasoningEffort(option);
                        setModelOpen(false);
                      }}
                    >
                      {
                        (
                          {
                            low: "Light",
                            medium: "Medium",
                            high: "High",
                            xhigh: "Extra High",
                            max: "Ultra",
                          } as Record<ReasoningId, string>
                        )[option]
                      }
                      {reasoningEffort === option && <Check size={15} />}
                    </button>
                  ))}
                  <div className="model-menu-divider" />
                  <div className="model-menu-label">Model</div>
                  {(
                    [
                      "gpt-5.6-luna",
                      "gpt-5.6-terra",
                      "gpt-5.6-sol",
                    ] as ModelId[]
                  )
                    .filter((option) =>
                      (
                        status?.model?.models || [
                          "gpt-5.6-luna",
                          "gpt-5.6-sol",
                          "gpt-5.6-terra",
                        ]
                      ).includes(option),
                    )
                    .map((option) => (
                      <button
                        key={option}
                        className={modelId === option ? "selected" : ""}
                        onClick={() => {
                          setModelId(option);
                          setModelOpen(false);
                        }}
                      >
                        {modelLabel(option)}
                      </button>
                    ))}
                </div>
              )}
            </div>
            <button
              className="composer-send"
              title="发送"
              aria-label="发送"
              disabled={(!input.trim() && !attachment) || busy}
              onClick={() => void send()}
            >
              <SendHorizontal size={19} />
            </button>
          </div>
        </div>
      </section>
      <aside className="market-rail">
        <button
          className="sidebar-toggle right-panel-toggle"
          title="隐藏右侧栏"
          aria-label="隐藏右侧栏"
          onClick={() => setRightCollapsed(true)}
        >
          <PanelRightClose size={17} />
        </button>
        <AssetWorkspace
          onMarketContext={(context) => {
            marketContext.current = context;
          }}
        />
        <button
          className="resize-handle right-resize"
          title="调整右侧栏宽度"
          aria-label="调整右侧栏宽度"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing("right");
          }}
        />
      </aside>
      {rightCollapsed && (
        <button
          className="sidebar-reopen right-reopen"
          title="显示右侧栏"
          aria-label="显示右侧栏"
          onClick={() => setRightCollapsed(false)}
        >
          <PanelRightOpen size={18} />
        </button>
      )}
      {settingsOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="dialog-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => setSettingsOpen(false)}
            >
              <X size={18} />
            </button>
            <h2 id="settings-title">设置</h2>
            <label>外观</label>
            <div className="theme-options">
              {(
                [
                  ["light", Sun, "浅色"],
                  ["dark", Moon, "深色"],
                  ["system", Monitor, "跟随系统"],
                ] as const
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  className={theme === value ? "selected" : ""}
                  onClick={() => setTheme(value)}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
