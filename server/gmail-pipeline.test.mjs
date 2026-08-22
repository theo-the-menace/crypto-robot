import test from 'node:test';
import assert from 'node:assert/strict';
import { isCmeMessage } from './gmail-pipeline.mjs';

test('filters CME Group alert senders while ignoring unrelated mail', () => {
  assert.equal(isCmeMessage({ from: 'CME GROUP ALERT <alerts@cmegroup.com>', subject: 'Settlement update' }), true);
  assert.equal(isCmeMessage({ from: 'CME GROUP <no-reply@cmegroup.com>', subject: 'Notice' }), true);
  assert.equal(isCmeMessage({ from: 'other@example.com', subject: 'CME discussion' }), false);
  assert.equal(isCmeMessage({ from: 'other@example.com', subject: 'Invoice' }), false);
});
