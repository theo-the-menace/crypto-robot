import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBinancePermissions, CLIENT_PERMISSION_POLICY } from '../src/permissions.mjs';

test('permission audit reports only safe account capabilities and never probes destructive APIs', () => {
  const result = auditBinancePermissions({ canTrade: true, canWithdraw: true, canDeposit: true });
  assert.equal(result.accountRead, true);
  assert.equal(result.spotTrading, true);
  assert.equal(result.accountReportsWithdrawals, true);
  assert.equal(result.withdrawals, 'not_used');
  assert.equal(result.transfers, 'not_used');
  assert.equal(result.futures, 'not_used');
  assert.equal(result.destructivePermissionsProbed, false);
  assert.deepEqual(result.policy, CLIENT_PERMISSION_POLICY);
  assert.equal(result.policy.withdrawals, false);
  assert.equal(result.policy.internalUniversalTransfers, true);
  assert.equal(result.policy.externalTransfers, false);
  assert.equal(result.policy.marginBorrowRepay, false);
  assert.equal(result.policy.marginTrading, true);
  assert.equal(result.policy.usdMFuturesTrading, true);
  assert.equal(result.policy.coinMFuturesTrading, true);
  assert.equal(result.policy.automatedStrategies, true);
  assert.match(result.warnings[0], /withdrawal/);
});
