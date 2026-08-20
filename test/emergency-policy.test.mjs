import test from 'node:test';
import assert from 'node:assert/strict';
import { EmergencyPolicy } from '../src/emergency-policy.mjs';

test('breaking news requires human confirmation and grants a finite, expiring budget', () => {
  let now = 1_000;
  const policy = new EmergencyPolicy({ now: () => now, grantMs: 100, cooldownMs: 20 });
  const pending = policy.trigger({ item: { id: 'n1', title: 'Exchange exploit', urgency: 'breaking' }, equity: 1_000 });
  assert.equal(pending.state, 'pending');
  assert.throws(() => policy.confirm({ confirmation: 'NO' }));
  const grant = policy.confirm({ confirmation: 'CONFIRM' });
  assert.equal(grant.remaining, 200);
  policy.consume({ grantId: grant.id, notional: 50 });
  assert.equal(policy.status().grant.remaining, 150);
  now += 101;
  assert.equal(policy.status().grant, null);
});

test('emergency grant cannot exceed configured leverage or budget', () => {
  const policy = new EmergencyPolicy({ now: () => 1_000 });
  policy.trigger({ item: { id: 'n2', title: 'Halt', urgency: 'breaking' }, equity: 100 });
  assert.throws(() => policy.confirm({ confirmation: 'CONFIRM', maxLeverage: 10 }));
  const grant = policy.confirm({ confirmation: 'CONFIRM', allowLeverage: true, maxLeverage: 2 });
  assert.throws(() => policy.consume({ grantId: grant.id, notional: 21 }));
});
