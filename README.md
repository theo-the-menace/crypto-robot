# Crypto Quant Bot

Crypto Quant Bot is a crypto-currency quantitative trading bot with a server-side Binance integration for market data, account reads, and constrained order execution. It starts in Binance Spot Testnet mode and keeps API credentials out of source control.

The architecture must keep three cores separate:

```text
Learning engine -> research/orchestration -> deterministic risk and execution
```

- The learning engine owns theories, papers, protocol documentation, regulatory material, evidence, conflicts, and time-aware retrieval.
- The research layer will own market datasets, feature definitions, strategy specifications, backtests, and out-of-sample evaluation.
- The execution layer will own positions, orders, reconciliation, limits, approvals, and kill switches.

An LLM never converts a conversational conclusion directly into a live order. It may only propose a structured order draft. The server independently checks the symbol allowlist, spot availability, Binance filters, available balance, and a hard per-order USDT limit, then sends Binance's test-order request. A separate, expiring confirmation is required for submission. Exchange credentials, wallet keys, orders, balances, and tick data never enter the learning database.

## Configure Binance API keys

The local credential file is `.env` (created from `.env.example`). Keep `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` server-side only. Start with Binance Spot Testnet; use an IP-restricted key with trading enabled and withdrawal disabled.

## Run the Binance client

Production Binance writes belong to the standalone execution service in `execution/`. It listens on server port `8888`, persists every order before submission, deduplicates by `clientOrderId`, and reconciles an unknown result before allowing any retry. The service starts with `BINANCE_EXECUTION_MODE=disabled`; use Testnet before considering live execution. Its read-only dashboard API reports actual service, risk, order, and strategy state without exposing Binance credentials. Remote dashboard GET requests use `BINANCE_DASHBOARD_API_KEY`; write endpoints are restricted to loopback requests.

The local frontend uses the server dashboard API at `http://43.163.91.179:8888`. Set `VITE_DASHBOARD_API_URL` for another address and provide the dashboard token at runtime; never place Binance credentials in frontend code.

For local development, the React/Vite frontend listens on `127.0.0.1:8888` and the local Node API listens on `127.0.0.1:8889`; Vite proxies `/api` to the Node API.

Market datasets live under the ignored `data/` directory and are never stored in Git. On a new host, configure `MARKET_DATA_DOWNLOAD_URL` and run `npm run download:market-data` before starting the API. The download mirrors immutable monthly 1-minute files and pre-aggregated display intervals; missing local data is reported as an error instead of silently showing an incomplete chart.

At startup the API repairs the gap from the last local candle with Binance REST, then subscribes to the Binance COIN-M 1-minute K-line WebSocket. Every open-candle update is merged into the current month's runtime overlay and relayed to browsers over SSE. A reconnect runs REST repair again before resuming the stream.

Wallet-routing experiments are Testnet-only in `execution/scenario_simulator.py`. They model USDT wallet transfers, close simulated COIN-M positions before returning collateral, and generate a dry-run COIN-M market-order draft for the requested 20x one-second momentum scenario. The unrestricted scenario is explicitly rejected outside Testnet and never submits a live order.

```bash
npm install
npm run dev -- crypto-agent
```

Open `http://127.0.0.1:5450`. Without a model gateway, explicit market instructions such as `用 50 USDT 市价买入 BTC` still work. Configuring `GATEWAY_BASE_URL` and `GATEWAY_API_KEY` enables natural-language clarification and LIMIT order extraction; Binance credentials are never sent to the model.

The model control uses the gateway's transparent `openai` provider payload. It exposes `GPT-5.6 Luna`, `GPT-5.6 Sol`, and `GPT-5.6 Terra`, with independent `Light` (`low`), `Medium`, `High`, `Extra High` (`xhigh`), and `Ultra` (`max`) reasoning choices. The selected values are sent as `model` and `reasoning_effort`.

For a resident macOS window, use `npm run desktop -- crypto-agent`. Closing the window hides it while the app remains available from the Dock; use `Cmd+Q` to exit.

To create a normal double-clickable Apple Silicon app/DMG, run `npm run dist:mac -- crypto-agent`. The output is `dist/CryptoAgent-0.1.0-arm64.dmg`. For a packaged app, place the ignored `.env` at `~/Library/Application Support/CryptoAgent/.env`; the app starts its local API itself and never bundles that file.

The previous RSS news collector and generated market-event relay have been removed. The Market panel remains empty until a replacement signal source is connected.

The client capability policy targets full Binance trading coverage: all configured Spot symbols, USDⓈ-M and COIN-M futures, margin trading without borrow/repay, internal account transfers, and automated strategy execution. Withdrawals, borrow/repay, and external transfers remain disabled. Live account reads require `BINANCE_ENV=live`; live submission additionally requires the separate `BINANCE_LIVE_TRADING=true` unlock. API keys should be IP-restricted.

`GET /api/permissions` performs a safe account-capability audit. Binance's Spot account response cannot prove every API Management checkbox, so futures, transfers, and withdrawals are reported as `not_used` rather than probed. The client never calls those APIs.

The client permission policy is explicit: withdrawals, borrow/repay, and external transfers are disabled; internal universal transfers, margin trading, futures, algo trading, and automated strategies are in scope. Product-specific clients are being added separately; the Spot client does not probe destructive APIs.

See [`TODO.md`](TODO.md) for the remaining production exit criteria. This client is not an autonomous strategy and does not provide investment advice.
