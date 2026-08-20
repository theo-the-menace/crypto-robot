const UNIT_MS = { 秒: 1_000, 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000 };
const CHINESE_NUMBERS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };

function quantity(value) {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (CHINESE_NUMBERS[value[1]] || 0);
  if (value.endsWith('十')) return (CHINESE_NUMBERS[value[0]] || 0) * 10;
  return CHINESE_NUMBERS[value] || 0;
}

function duration(value, unit) { return quantity(value) * UNIT_MS[unit]; }

export function requestedOrderBookRange(message, now = Date.now()) {
  const text = String(message || '');
  if (!/(?:盘口|订单簿|order\s*book|depth)/iu.test(text)) return null;
  const ago = [...text.matchAll(/(\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)个?(秒|分钟|小时|天)(?:之?前|以前|前)/g)];
  if (ago.length >= 2) {
    const offsets = ago.slice(0, 2).map((match) => duration(match[1], match[2])).sort((a, b) => b - a);
    return { startTime: now - offsets[0], endTime: now - offsets[1], label: text.slice(0, 120) };
  }
  const recent = text.match(/(?:最近|近)(\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)个?(秒|分钟|小时|天)/);
  if (recent) return { startTime: now - duration(recent[1], recent[2]), endTime: now, label: text.slice(0, 120) };
  if (/今天/.test(text)) {
    const chinaOffset = 8 * 3_600_000;
    return { startTime: Math.floor((now + chinaOffset) / 86_400_000) * 86_400_000 - chinaOffset, endTime: now, label: '今天' };
  }
  return { startTime: now - 5 * 60_000, endTime: now, label: '最近 5 分钟' };
}
