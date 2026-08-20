export type KlineRow = Array<string | number>;

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
