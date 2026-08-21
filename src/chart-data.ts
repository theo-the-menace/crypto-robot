export type KlineRow = Array<string | number>;

export type IndicatorPoint = { time: number; value: number };

function closes(rows: KlineRow[]) {
  return rows.map((row) => ({ time: Number(row[0]), value: Number(row[4]) })).filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
}

export function sma(rows: KlineRow[], period: number): IndicatorPoint[] {
  if (!Number.isInteger(period) || period < 1) return [];
  const points = closes(rows); const result: IndicatorPoint[] = []; let sum = 0;
  for (let index = 0; index < points.length; index++) {
    sum += points[index].value;
    if (index >= period) sum -= points[index - period].value;
    if (index >= period - 1) result.push({ time: points[index].time, value: sum / period });
  }
  return result;
}

export function ema(rows: KlineRow[], period: number): IndicatorPoint[] {
  if (!Number.isInteger(period) || period < 1) return [];
  const points = closes(rows); if (points.length < period) return [];
  const multiplier = 2 / (period + 1); let value = points.slice(0, period).reduce((sum, point) => sum + point.value, 0) / period;
  const result = [{ time: points[period - 1].time, value }];
  for (let index = period; index < points.length; index++) { value = (points[index].value - value) * multiplier + value; result.push({ time: points[index].time, value }); }
  return result;
}

export function bollinger(rows: KlineRow[], period = 20, deviations = 2) {
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(deviations)) return { middle: [], upper: [], lower: [] };
  const points = closes(rows); const middle: IndicatorPoint[] = []; const upper: IndicatorPoint[] = []; const lower: IndicatorPoint[] = [];
  for (let index = period - 1; index < points.length; index++) {
    const window = points.slice(index - period + 1, index + 1); const average = window.reduce((sum, point) => sum + point.value, 0) / period;
    const deviation = Math.sqrt(window.reduce((sum, point) => sum + (point.value - average) ** 2, 0) / period);
    middle.push({ time: points[index].time, value: average }); upper.push({ time: points[index].time, value: average + deviations * deviation }); lower.push({ time: points[index].time, value: average - deviations * deviation });
  }
  return { middle, upper, lower };
}

export function aggregateKlines<T extends KlineRow>(rows: T[], intervalMs: number): T[] {
  if (!rows.length || !Number.isFinite(intervalMs) || intervalMs <= 0) return rows;
  const grouped: T[] = [];
  for (const row of rows) {
    const time = Number(row[0]);
    const bucket = Math.floor(time / intervalMs) * intervalMs;
    const previous = grouped.at(-1);
    if (!previous || Number(previous[0]) !== bucket) {
      const next = [...row] as T;
      next[0] = bucket;
      grouped.push(next);
      continue;
    }
    previous[2] = Math.max(Number(previous[2]), Number(row[2]));
    previous[3] = Math.min(Number(previous[3]), Number(row[3]));
    previous[4] = row[4];
    if (previous.length > 5) previous[5] = Number(previous[5]) + Number(row[5]);
    if (previous.length > 7) previous[7] = Number(previous[7]) + Number(row[7]);
  }
  return grouped;
}

export function klineWindow<T>(rows: T[], offset: number, limit = 120) {
  const end = rows.length - Math.min(Math.max(0, rows.length - limit), Math.max(0, offset));
  return rows.slice(Math.max(0, end - limit), end);
}

export function chartTickSpacing(visible: number) {
  const target = Math.min(64, Math.max(4, (visible - 1) / 2));
  return 2 ** Math.round(Math.log2(target));
}

export function fixedTimeTickIndices(buckets: number[], spacing: number) {
  if (spacing <= 0) return [];
  return buckets.flatMap((bucket, index) =>
    Number.isInteger(bucket) && ((bucket % spacing) + spacing) % spacing === 0
      ? [index]
      : [],
  );
}

export function appendedPointCount(times: number[], previousLastTime: number | null) {
  if (previousLastTime === null) return 0;
  const previousLast = times.indexOf(previousLastTime);
  return previousLast < 0 ? 0 : times.length - previousLast - 1;
}

export function zoomWindowOffset(total: number, offset: number, oldCount: number, newCount: number, anchorFraction = .5) {
  const oldVisible = Math.min(total, oldCount); const nextVisible = Math.min(total, newCount); const anchor = Math.min(1, Math.max(0, anchorFraction));
  const oldEnd = total - 1 - Math.min(Math.max(0, total - oldVisible), Math.max(0, offset));
  const oldStart = Math.max(0, oldEnd - oldVisible + 1);
  const anchorIndex = oldStart + anchor * Math.max(0, oldVisible - 1);
  const nextEnd = Math.round(anchorIndex + (1 - anchor) * Math.max(0, nextVisible - 1));
  return Math.min(Math.max(0, total - nextVisible), Math.max(0, total - 1 - nextEnd));
}

export function nearHistoryStart(total: number, offset: number, visible: number, warmup = visible) {
  return offset >= Math.max(0, total - visible - Math.max(visible, warmup));
}

export function panWindowOffset(total: number, offset: number, visible: number, steps: number) {
  return Math.max(0, Math.min(Math.max(0, total - visible), offset + steps));
}

export function mergeKlineRows(current: KlineRow[], incoming: KlineRow[]) {
  // ponytail: History stays in memory; move pages to IndexedDB if multi-year minute browsing becomes a normal workflow.
  if (!current.length) return [...incoming].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (incoming.length === 1) {
    const row = incoming[0]; const time = Number(row[0]); let low = 0; let high = current.length;
    while (low < high) { const middle = (low + high) >> 1; if (Number(current[middle][0]) < time) low = middle + 1; else high = middle; }
    const next = [...current]; if (Number(next[low]?.[0]) === time) next[low] = row; else next.splice(low, 0, row); return next;
  }
  const next: KlineRow[] = []; let left = 0; let right = 0;
  while (left < current.length || right < incoming.length) {
    const currentTime = left < current.length ? Number(current[left][0]) : Infinity;
    const incomingTime = right < incoming.length ? Number(incoming[right][0]) : Infinity;
    if (currentTime < incomingTime) next.push(current[left++]);
    else if (incomingTime < currentTime) next.push(incoming[right++]);
    else { next.push(incoming[right++]); left += 1; }
  }
  return next;
}

export function updateKlinePrice(rows: KlineRow[], price: number) {
  if (!rows.length || !Number.isFinite(price)) return rows;
  const last = rows.at(-1)!;
  const next = [...last];
  next[2] = Math.max(Number(last[2]), price);
  next[3] = Math.min(Number(last[3]), price);
  next[4] = price;
  return [...rows.slice(0, -1), next];
}

export function fillSecondRows(rows: KlineRow[], limit = 240) {
  const filled: KlineRow[] = [];
  for (let row of rows) {
    const time = Number(row[0]);
    const previous = filled.at(-1);
    if (previous && time <= Number(previous[0])) {
      if (time === Number(previous[0])) filled[filled.length - 1] = row;
      continue;
    }
    if (previous) {
      const close = Number(previous[4]);
      for (let missing = Number(previous[0]) + 1_000; missing < time; missing += 1_000)
        filled.push([missing, close, close, close, close, 0, missing + 999, 0]);
      row = [
        row[0],
        close,
        Math.max(close, Number(row[2])),
        Math.min(close, Number(row[3])),
        row[4],
        ...row.slice(5),
      ];
    }
    filled.push(row);
  }
  return filled.slice(-limit);
}

export function mergeTradeIntoSecondRows(current: KlineRow[], timestamp: number, price: number, quantity: number, limit = 240) {
  const time = Math.floor(timestamp / 1_000) * 1_000;
  const last = current.at(-1);
  if (last && Number(last[0]) > time) return current;
  if (!last || Number(last[0]) !== time) {
    const open = last ? Number(last[4]) : price;
    return fillSecondRows([...current, [time, open, Math.max(open, price), Math.min(open, price), price, quantity, time + 999, price * quantity]], limit);
  }
  const next = [...current];
  next[next.length - 1] = [time, last[1], Math.max(Number(last[2]), price), Math.min(Number(last[3]), price), price, Number(last[5]) + quantity, time + 999, Number(last[7]) + price * quantity];
  return next;
}
