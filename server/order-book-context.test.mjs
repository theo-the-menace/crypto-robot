import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedOrderBookRange } from './order-book-context.mjs';

test('extracts recent and historical order-book ranges from Chinese questions', () => {
  const now = Date.UTC(2026, 7, 18, 12);
  assert.deepEqual(requestedOrderBookRange('分析最近5分钟的盘口数据', now), { startTime: now - 300_000, endTime: now, label: '分析最近5分钟的盘口数据' });
  assert.deepEqual(requestedOrderBookRange('分析两个小时之前到三个小时之前的盘口', now), { startTime: now - 10_800_000, endTime: now - 7_200_000, label: '分析两个小时之前到三个小时之前的盘口' });
  assert.equal(requestedOrderBookRange('分析今天的盘口', now)?.startTime, Date.UTC(2026, 7, 17, 16));
  assert.equal(requestedOrderBookRange('分析最近行情', now), null);
});
