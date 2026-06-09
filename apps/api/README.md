# trader-api

Autonomous multi-symbol crypto trading agent on Cloudflare Workers. A **per-minute**
cron runs a zero-token, rule-based watcher that scans a universe of pairs, classifies
each one's market regime, and only wakes an LLM when a setup warrants it — a quick
single-model call for routine signals, or a **multi-agent debate** for abnormal events.
A risk layer sizes every trade and prevents ruin; a bot on/off switch and daily
kill-switch stop trading entirely when needed. Everything is recorded in D1 and
embedded into Vectorize so the agent learns from its own outcomes.

## Strategy (distilled from professional crypto TA)

Regime-first, multi-timeframe (1D macro · 4H trend · 1H entry):

| Regime (ADX-based) | Strategy |
|--------------------|----------|
| **trend_up** (ADX≥25, EMAs stacked up, price>1D EMA200) | trend-following longs on momentum + pullback |
| **range** (ADX<20) | mean-reversion: buy oversold at BB-lower, exit at BB-upper |
| **trend_down** | stay in cash / exit (spot can't short) |
| **choppy** (ADX 20-25) | **stand aside** — preserve capital |

Coins are ranked by a composite of conviction + relative strength + liquidity; the
best long candidate is acted on, up to `MAX_OPEN_POSITIONS`.

**Risk layer** (the real loss-preventer): 1% equity risk/trade, ATR-based stops, a
minimum **2:1 reward:risk** gate, portfolio-heat cap, position-size cap, and a daily
**kill-switch** that halts trading after a set loss.

## Decision routing

```
cron * * * * *  ──▶  scan universe (klines → indicators → regime → signal)   [0 tokens]
                          │
              ┌───────────┼─────────────────────────────┐
           none         normal                        debate
        (no setup)  (single model + self-consistency)  (abnormal event → Bull/Bear/Risk
                                                         on 3 models → Judge)
                          │                                  │
                          └────────── risk gates → size → execute (demo) ─────┘
                                          │
                              record (D1) + learn (Vectorize outcomes)
```

Debate fires on abnormal/high-stakes conditions only (volatility/volume spikes, price
extension, timeframe conflict, a position near its stop) — where deliberation earns its
tokens. Its value is **A/B-measured** against single-model decisions via the outcome table.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/wallet` | live balances + equity |
| GET | `/bot` | bot state + today's PnL + config |
| POST | `/bot` `{enabled}` | turn trading ON/OFF (guard: `x-admin-secret`) |
| GET | `/status` | open trades + recent decisions |
| GET | `/usage` | Groq per-key usage + rotation |
| GET | `/diag`, `/diag/test-order` | Bybit connectivity probe / place a test order |
| POST | `/run`, `/evaluate` | manually run one cycle / score matured decisions |

## Setup & test

```bash
pnpm install
# wrangler.jsonc holds keys (gitignored). 3+ Groq keys must be SEPARATE orgs.
pnpm db:migrate:remote
pnpm deploy
```

Local end-to-end (no Cloudflare login needed) — drop the remote AI/Vectorize bindings
into a `wrangler.local.jsonc` (memory fails open), then:
`wrangler d1 migrations apply trader --local -c wrangler.local.jsonc` and
`wrangler dev -c wrangler.local.jsonc --local`. Hit `/wallet`, `/bot`, `/run`.

## Frontend (`apps/web`)

Next.js dashboard: wallet summary, a bot **on/off toggle** (off ⇒ trading fully stops),
open positions, and recent decisions with outcomes. Set `NEXT_PUBLIC_API_URL` to the
Worker URL; the admin secret (for toggling) is stored in the browser.

## Knobs (wrangler vars)

`UNIVERSE`, `RISK_PCT`, `MIN_RR`, `ATR_STOP_MULT`, `KILL_SWITCH_PCT`, `MAX_OPEN_POSITIONS`,
`MAX_POSITION_PCT`, `PORTFOLIO_HEAT_PCT`, `MIN_CONFIDENCE`, `SELF_CONSISTENCY`,
`DEBATE_ENABLED`, `EXECUTE_TRADES` (false ⇒ paper).

## Known follow-ups

- Native Bybit spot TP/SL isn't attached to orders (SL/TP kept in D1; exits managed by
  rules/evaluator).
- Consider a dedicated Vectorize index instead of the shared `linda-memory`.
- Add Upstash Redis so Groq key rate-limit state persists across cron isolates.
