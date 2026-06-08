import { int, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// D1 is the source of truth. Upstash Redis only caches the live Groq key state.
// All timestamps are epoch milliseconds (int) unless noted.

// ── Every analysis the agent runs (executed or not) ───────────────────────────
export const analyses = sqliteTable("analyses", {
  id: text().primaryKey(), // uuid
  symbol: text().notNull(),
  ts: int().notNull(), // when the analysis ran
  price: real().notNull(), // reference price at decision time
  snapshot: text().notNull(), // JSON MarketSnapshot (indicators, multi-timeframe)
  trigger: text().notNull().default(""), // what rule woke the LLM (or "scheduled")
  action: text().notNull(), // BUY | SELL | HOLD
  confidence: int().notNull().default(0),
  timeframeBias: text("timeframe_bias").notNull().default("neutral"),
  reasoning: text().notNull().default(""),
  keyFactors: text("key_factors").notNull().default("[]"), // JSON string[]
  stopLoss: real("stop_loss"),
  takeProfit: text("take_profit"), // JSON number[]
  invalidation: text().notNull().default(""),
  executed: int().notNull().default(0), // 1 if a trade was placed
  keyUsed: text("key_used"),
  modelUsed: text("model_used"),
  // Outcome (filled in later by the evaluator) — closes the learning loop.
  outcomePnlPct: real("outcome_pnl_pct"),
  outcomeCorrect: int("outcome_correct"), // 1 right / 0 wrong / null not-yet
  evaluatedAt: int("evaluated_at"),
});

// ── Executed trades (demo orders on Bybit) ────────────────────────────────────
export const trades = sqliteTable("trades", {
  id: text().primaryKey(), // our orderLinkId (uuid)
  analysisId: text("analysis_id").notNull(),
  symbol: text().notNull(),
  side: text().notNull(), // Buy | Sell
  orderType: text("order_type").notNull().default("Market"),
  qty: real().notNull(), // base-coin quantity
  price: real().notNull(), // fill / reference price
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  status: text().notNull().default("submitted"), // submitted|filled|rejected|closed
  bybitOrderId: text("bybit_order_id"),
  error: text(),
  createdAt: int("created_at").notNull(),
  closedAt: int("closed_at"),
  exitPrice: real("exit_price"),
  pnlQuote: real("pnl_quote"),
});

// ── Long-term semantic memory (mirror of Vectorize; id == vector id) ──────────
export const marketMemory = sqliteTable("market_memory", {
  id: text().primaryKey(), // also the Vectorize vector id
  symbol: text().notNull(),
  text: text().notNull(), // the "market fingerprint" + decision + outcome line
  createdAt: int("created_at").notNull(),
});

// ── Groq usage counters, per (day, key, model) — drives rotation + /usage ──────
export const usageCounters = sqliteTable(
  "usage_counters",
  {
    date: text().notNull(), // YYYY-MM-DD (UTC)
    keyIndex: int("key_index").notNull(),
    model: text().notNull(),
    totalTokens: int("total_tokens").notNull().default(0),
    totalRequests: int("total_requests").notNull().default(0),
    lastUpdated: int("last_updated").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.date, t.keyIndex, t.model] })],
);
