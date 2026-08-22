const intervals = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 'week' };

export function aggregateMarketKlines(rows, interval) {
  const duration = intervals[interval];
  if (!duration || interval === '1m') return rows;
  const grouped = [];
  for (const row of rows) {
    const date = new Date(Number(row[0]));
    const time = duration === 'week'
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (date.getUTCDay() + 6) % 7)
      : Math.floor(Number(row[0]) / duration) * duration;
    const previous = grouped.at(-1);
    if (!previous || Number(previous[0]) !== time) { grouped.push([time, ...row.slice(1)]); continue; }
    previous[2] = Math.max(Number(previous[2]), Number(row[2])); previous[3] = Math.min(Number(previous[3]), Number(row[3]));
    previous[4] = row[4]; previous[5] = Number(previous[5]) + Number(row[5]); previous[6] = row[6]; previous[7] = Number(previous[7]) + Number(row[7]);
  }
  return grouped;
}

export { intervals as marketIntervals };
