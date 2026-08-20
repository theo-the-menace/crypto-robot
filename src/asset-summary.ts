export type AssetSummary = {
  asset: string;
  spot: number;
  funding: number;
  earn: number;
  futures: number;
  total: number;
  price: number;
  estimatedUsdt: number;
};

type Balance = { asset: string; free?: string; locked?: string; freeze?: string; withdrawing?: string };
type EarnRow = { asset: string; totalAmount?: string; holdingAmount?: string };
type FuturesAsset = { asset: string; walletBalance?: string };

const numberValue = (value: string | number | undefined) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function aggregateAssetBalances({
  spot = [],
  funding = [],
  earn = [],
  futures = [],
  prices = {},
}: {
  spot?: Balance[];
  funding?: Balance[];
  earn?: EarnRow[];
  futures?: FuturesAsset[];
  prices?: Record<string, number>;
}): AssetSummary[] {
  const buckets = new Map<string, Omit<AssetSummary, 'asset' | 'total' | 'price' | 'estimatedUsdt'>>();
  const ensure = (asset: string) => {
    const current = buckets.get(asset) || { spot: 0, funding: 0, earn: 0, futures: 0 };
    buckets.set(asset, current);
    return current;
  };
  for (const item of spot) {
    if (item.asset.startsWith('LD')) continue;
    ensure(item.asset).spot += numberValue(item.free) + numberValue(item.locked);
  }
  for (const item of funding) {
    ensure(item.asset).funding += numberValue(item.free) + numberValue(item.locked) + numberValue(item.freeze) + numberValue(item.withdrawing);
  }
  for (const item of earn) ensure(item.asset).earn += numberValue(item.totalAmount || item.holdingAmount);
  for (const item of futures) ensure(item.asset).futures += numberValue(item.walletBalance);
  return [...buckets.entries()].map(([asset, values]) => {
    const total = values.spot + values.funding + values.earn + values.futures;
    const price = asset === 'USDT' ? 1 : numberValue(prices[asset]);
    return { asset, ...values, total, price, estimatedUsdt: total * price };
  }).filter((item) => item.total !== 0).sort((a, b) => b.estimatedUsdt - a.estimatedUsdt || a.asset.localeCompare(b.asset));
}
