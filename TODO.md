# CryptoAgent Implementation Record

## Phase 0: Scope And Safety

- [x] Choose research-only, paper-trading, and live-trading trust boundaries for the first Binance Spot client.
- [ ] Define supported jurisdictions, exchanges, instruments, and prohibited actions.
- [x] Specify credential isolation; API keys must disable withdrawals and remain outside prompts and learning storage.
- [ ] Define human approvals, maximum loss, maximum position, maximum leverage, stale-data shutdown, and a global kill switch.
- [ ] Create a threat model for prompt injection, poisoned market content, compromised APIs, replayed orders, and key theft.

## Phase 1: Knowledge Research

- [x] Create a financial-knowledge adapter over `@evolving-agents/learning-engine`.
- [x] Preserve asset scope, evidence type, authority, publication time, and system `knownAt` time.
- [x] Prevent historical retrieval from using material learned in the future.
- [ ] Define extraction schemas for theory, mechanism, empirical finding, regulation, protocol change, risk, and disputed thesis.
- [ ] Rank primary sources above commentary and social-media claims.
- [ ] Add contradiction, supersession, retraction, and market-regime policies.
- [ ] Build citation-entailment and answer-abstention evaluations.

## Phase 2: Data And Reproducible Research

- [ ] Select licensed historical market, reference, derivatives, and on-chain datasets.
- [ ] Store bars, trades, order books, funding, open interest, and corporate actions outside the learning engine.
- [ ] Record event time, ingestion time, exchange time, timezone, missing intervals, and corrections.
- [ ] Implement deterministic feature computation with versioned dataset and code hashes.
- [ ] Prevent look-ahead, survivorship, selection, and repeated-testing bias.
- [ ] Model fees, funding, spread, slippage, latency, liquidity, borrow, and partial fills.

## Phase 3: Strategy Research

- [ ] Define a versioned `StrategySpec`: universe, signal, sizing, entry, exit, risk, assumptions, and code hash.
- [ ] Separate LLM-generated hypotheses from executable deterministic strategy code.
- [ ] Add train/validation/test splits, walk-forward analysis, sensitivity checks, and stress scenarios.
- [ ] Establish baselines and minimum evidence thresholds before paper deployment.
- [ ] Store every experiment, failure, parameter search, and result to avoid selective reporting.

## Phase 4: Paper Trading

- [x] Build the first Binance Spot exchange adapter behind a narrow contract.
- [ ] Maintain an append-only order, fill, position, balance, and reconciliation ledger.
- [ ] Test idempotent submission, reconnects, rate limits, partial fills, rejects, clock drift, and duplicate events.
- [ ] Run shadow and paper modes long enough to compare simulated and observed execution costs.
- [ ] Require explicit promotion of one immutable strategy version.

## Phase 5: Constrained Live Execution

- [ ] Begin with minimum capital and no leverage.
- [ ] Enforce risk limits in an independent process that the agent cannot override.
- [ ] Require previews and human approval until operational evidence supports narrower automation.
- [ ] Add health monitoring, alerts, automatic cancel, dead-man control, and incident runbooks.
- [ ] Reconcile exchange state continuously; stop on disagreement.
- [ ] Feed signed execution outcomes and post-trade analysis back into research, never directly into strategy authority.

## Exit Criteria Before Any Live Order

- [ ] Independent review of data integrity, backtest code, risk rules, and credential permissions.
- [ ] Reproducible out-of-sample and paper-trading evidence after all realistic costs.
- [ ] Passing failure-injection tests for disconnects, stale prices, API errors, and process crashes.
- [ ] Documented rollback, capital-loss tolerance, tax/accounting handling, and applicable legal obligations.
- [ ] A human explicitly enables a fixed strategy version, account, instrument allowlist, and capital limit.
