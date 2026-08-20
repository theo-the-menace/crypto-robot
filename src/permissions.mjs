export const CLIENT_PERMISSION_POLICY = Object.freeze({
  withdrawals: false,
  internalUniversalTransfers: true,
  externalTransfers: false,
  marginBorrowRepay: false,
  spotTrading: true,
  marginTrading: true,
  usdMFuturesTrading: true,
  coinMFuturesTrading: true,
  algoTrading: true,
  automatedStrategies: true,
});

// Binance does not expose every API-management checkbox through the Spot account response.
// Keep destructive capabilities as explicit policy rather than probing them.
export function auditBinancePermissions(account) {
  const warnings = [];
  if (account?.canWithdraw === true) warnings.push('The account reports withdrawal capability; this client never uses withdrawals.');
  if (account?.canTrade !== true) warnings.push('Spot trading is not available to this API key.');
  return {
    accountRead: true,
    spotTrading: account?.canTrade === true,
    accountReportsWithdrawals: account?.canWithdraw === true,
    accountReportsDeposits: account?.canDeposit === true,
    futures: 'not_used',
    transfers: 'not_used',
    withdrawals: 'not_used',
    policy: CLIENT_PERMISSION_POLICY,
    destructivePermissionsProbed: false,
    warnings,
  };
}
