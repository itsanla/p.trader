# trader-api

Autonomous crypto trading agent on Cloudflare Workers. A 5-minute cron runs a cheap
rule-based **watcher**; only when a trigger fires does it wake a Groq LLM to make a
structured BUY/SELL/HOLD decision, size it under risk caps, and execute on the
**Bybit demo** account. Every decision and its later outcome are stored in D1, and
each market situation is embedded into Vectorize so similar past setups (and how they
turned out) inform future calls.

## Architecture

```
cron */5  ──▶  buildSnapshot (Bybit kline 1H/4H/1D → indicators)
                     │
                     ▼
               evaluateTriggers (RSI/Bollinger/volume/ATR/MACD/near-SL · heartbeat)
                     │ fire?
            no ──────┴────── yes
            (record nothing)   │
                               ▼
        wallet + Vectorize recall + past performance
                               │
                               ▼
        runDecision  (Groq gpt-oss-120b, structured, self-consistency vote)
                               │
                               ▼
        maybeExecute (confidence ≥ MIN, risk-sized, balance-capped) → Bybit order
                               │
                               ▼
        insertAnalysis + insertTrade + storeMemory
        evaluateOutcomes (score matured decisions, append outcome to memory)
```

Key modules: `bybit.ts` (signed V5 client), `indicators.ts` (TA math), `triggers.ts`
(LLM gating), `analysis.ts` (prompt + Zod decision + voting), `vector.ts` (semantic
memory), `trader.ts` (orchestrator), `groq.ts` (3-org key rotation + failover).

## Setup

1. `pnpm install`
2. Copy `wrangler.example.jsonc` → `wrangler.jsonc` and fill in keys (this file is
   gitignored). The 3 Groq keys **must be from 3 separate Groq accounts/orgs** — only
   then do the daily limits add up (3×).
3. Apply migrations: `pnpm db:migrate:remote` (D1 `trader`).
4. Deploy: `pnpm deploy`.

> Each Groq key is a separate org, so usable budget is per-model-limit × 3
> (e.g. gpt-oss-120b ≈ 3000 req/day). A 5-min cron is ~288 fires/day max — well under.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | health + active symbol |
| GET | `/status` | recent decisions + open trades + config |
| GET | `/usage` | Groq per-key usage + rotation state |
| POST | `/run` | manually trigger one cycle (guard: `x-admin-secret`) |
| POST | `/evaluate` | manually score matured decisions |

## Testing on demo

- Set `EXECUTE_TRADES=false` first to **paper-trade** (decide + record, no order),
  watch `/status`, then flip to `true` once the loop looks sane.
- `wrangler dev --test-scheduled` then `curl localhost:8787/__scheduled` to fire a cron
  locally, or `curl -XPOST localhost:8787/run` to force one cycle.

## Knobs (wrangler vars)

`MIN_CONFIDENCE` (skip below), `RISK_PCT` (% equity risked per trade), `MAX_POSITION_PCT`
(hard size cap), `SELF_CONSISTENCY` (LLM samples to majority-vote), `TRADING_SYMBOL`.

## Known follow-ups

- Native Bybit **spot TP/SL** is not attached to orders yet (needs `tpslMode` etc.);
  SL/TP are stored in D1 and exits are bookkept by the evaluator. Wire native TP/SL
  once the base loop is validated.
- Consider a **dedicated Vectorize index** (not the shared `linda-memory`) for clean
  separation.
- Add **Upstash Redis** so live key rate-limit state persists across cron isolates.
