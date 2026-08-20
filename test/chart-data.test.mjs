import test from 'node:test';
import assert from 'node:assert/strict';
import { appendedPointCount, chartTickSpacing, fillSecondRows, fixedTimeTickIndices, klineWindow, mergeKlineRows, mergeTradeIntoSecondRows, nearHistoryStart, panWindowOffset, updateKlinePrice, zoomWindowOffset } from '../src/chart-data.ts';

test('merges older pages and live candles without sorting or duplicates', () => {
  const current = [[3, 'old-3'], [4, 'old-4']];
  assert.deepEqual(mergeKlineRows(current, [[1, 'one'], [2, 'two'], [3, 'new-3']]), [[1, 'one'], [2, 'two'], [3, 'new-3'], [4, 'old-4']]);
  assert.deepEqual(mergeKlineRows(current, [[4, 'new-4']]), [[3, 'old-3'], [4, 'new-4']]);
  assert.deepEqual(mergeKlineRows(current, [[5, 'five']]), [[3, 'old-3'], [4, 'old-4'], [5, 'five']]);
});

test('updates the active candle from a live trade price', () => {
  const rows = [[1_000, 100, 105, 95, 102, 2, 1_999, 204]];
  assert.deepEqual(updateKlinePrice(rows, 108), [[1_000, 100, 108, 95, 108, 2, 1_999, 204]]);
  assert.deepEqual(updateKlinePrice(rows, 92), [[1_000, 100, 105, 92, 92, 2, 1_999, 204]]);
});

test('aggregates trades into bounded one-second OHLCV rows', () => {
  let rows = mergeTradeIntoSecondRows([], 1_100, 100, 2);
  rows = mergeTradeIntoSecondRows(rows, 1_900, 105, 3);
  rows = mergeTradeIntoSecondRows(rows, 2_100, 103, 1);
  assert.deepEqual(rows, [[1_000, 100, 105, 100, 105, 5, 1_999, 515], [2_000, 105, 105, 103, 103, 1, 2_999, 103]]);
  assert.equal(mergeTradeIntoSecondRows(rows, 900, 99, 1), rows);
});

test('fills quiet seconds with the previous close', () => {
  const rows = fillSecondRows([
    [1_000, 100, 101, 99, 100, 2, 1_999, 200],
    [4_000, 103, 104, 102, 103, 1, 4_999, 103],
  ]);
  assert.deepEqual(rows.map((row) => row[0]), [1_000, 2_000, 3_000, 4_000]);
  assert.deepEqual(rows[1], [2_000, 100, 100, 100, 100, 0, 2_999, 0]);
  assert.deepEqual(rows[3], [4_000, 100, 104, 100, 103, 1, 4_999, 103]);
  assert.deepEqual(fillSecondRows(rows, 2).map((row) => row[0]), [3_000, 4_000]);
});

test('moves the visible K-line window left and right without crossing its bounds', () => {
  const rows = Array.from({ length: 240 }, (_, index) => index);
  assert.deepEqual(klineWindow(rows, 0, 120), rows.slice(120));
  assert.deepEqual(klineWindow(rows, 60, 120), rows.slice(60, 180));
  assert.deepEqual(klineWindow(rows, 999, 120), rows.slice(0, 120));
  assert.equal(panWindowOffset(240, 0, 120, 20), 20);
  assert.equal(panWindowOffset(240, 5, 120, -20), 0);
  assert.equal(panWindowOffset(240, 115, 120, 20), 120);
});

test('keeps time-axis ticks anchored to absolute time while the window moves', () => {
  assert.equal(chartTickSpacing(9), 4);
  assert.equal(chartTickSpacing(129), 64);
  assert.deepEqual(fixedTimeTickIndices([1, 2, 3, 4, 5, 6, 7, 8], 4), [3, 7]);
  assert.deepEqual(fixedTimeTickIndices([3, 4, 5, 6, 7, 8, 9], 4), [1, 5]);
});

test('distinguishes older history prepends from live appends', () => {
  assert.equal(appendedPointCount([1, 2, 3, 4], 4), 0);
  assert.equal(appendedPointCount([3, 4, 5], 4), 1);
});

test('zooms around the gesture center without crossing history bounds', () => {
  assert.equal(zoomWindowOffset(240, 60, 120, 60), 90);
  assert.equal(zoomWindowOffset(240, 0, 120, 145), 0);
  assert.equal(zoomWindowOffset(240, 120, 120, 145), 95);
});

test('prefetches enough history to keep long moving averages continuous', () => {
  assert.equal(nearHistoryStart(240, 20, 20, 99), false);
  assert.equal(nearHistoryStart(240, 121, 20, 99), true);
  assert.equal(nearHistoryStart(240, 100, 120), true);
});
