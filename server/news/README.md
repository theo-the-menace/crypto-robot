# News Collection

This directory contains server-side news collectors. Collectors run on the remote crypto-agent server, cache source material under `data/news`, and send only qualifying market events to the Market store and Telegram notifier.

## Current Sources

### Processed Gmail / CME Group

- Source: Gmail messages from CME Group and CME Group Alerts.
- Input: the original Gmail message remains under `data/gmail`; Market receives the LLM-processed Markdown, not the raw email.
- Flow: Luna scores the message using its subject and opening text. Messages below 75 stop there. Messages scoring 75 or higher are analyzed fully by Terra.
- Current filter: CME Group crypto-related alerts, especially block trades.

### White House

- Collector: `whitehouse-source.mjs`.
- Public pages: Remarks, Briefing Room, Presidential Actions, and Videos.
- Polling: once at startup and every 10 minutes. The first sync is capped at 20 new pages to keep request and token usage bounded.
- Cache: `data/news/whitehouse.json`.
- Flow: the page title and opening text are scored by Luna. A score below 75 is cached only. A score of 75 or higher is analyzed by Terra, stored in Market, and sent to Telegram with the original URL.
- Cross-source deduplication is intentionally not enabled yet.

## Scoring Levels

- 75-79: watch
- 80-84: important
- 85-89: high attention
- 90-94: major
- 95-100: critical

The score is internal metadata (`impactScore`) and is not inserted into the Markdown article body.

## Recommended Next Sources

Add these in order, keeping each source as a separate adapter:

1. U.S. Treasury: stablecoins, sanctions, dollar policy, and financial-system announcements.
2. SEC: ETF decisions, securities enforcement, exchange and token rules.
3. CFTC: derivatives, futures, commodities, and crypto enforcement.
4. Federal Reserve: rates, liquidity, payment systems, and digital-dollar policy.
5. Congress.gov: crypto bills, hearings, and votes. This source requires a Congress API key.
6. Federal Register: final rules and executive-branch notices. Public access is available without a key.

X and Truth Social should be added later as fast-warning sources. X may require a paid API plan, and Truth Social does not currently offer a stable production API suitable for the main collector. They should not replace primary government sources.

## Operating Rules

- Raw source material is cached for later review and re-scoring.
- Telegram receives only items scoring 75 or higher.
- Market receives only fully analyzed items scoring 75 or higher.
- Collectors must use bounded requests and avoid polling from browser components.
