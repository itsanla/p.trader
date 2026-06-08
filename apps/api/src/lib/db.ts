import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { analyses, marketMemory, trades, usageCounters } from "../db/schema";
import { logger } from "./logger";
import type { Decision } from "./types";

const log = logger("db");

export type DB = DrizzleD1Database<Record<string, never>>;

/** Build a Drizzle client bound to the D1 database. */
export function getDb(d1: D1Database): DB {
  return drizzle(d1);
}

// ── Analyses ──────────────────────────────────────────────────────────────────

export interface AnalysisRow {
  id: string;
  symbol: string;
  ts: number;
  price: number;
  trigger: string;
  action: string;
  confidence: number;
  reasoning: string;
  stopLoss: number | null;
  executed: number;
  outcomePnlPct: number | null;
  outcomeCorrect: number | null;
}

/** Persist one decision (executed or not). Returns the inserted row id. */
export async function insertAnalysis(
  db: DB,
  args: {
    id: string;
    symbol: string;
    ts: number;
    price: number;
    snapshot: unknown;
    trigger: string;
    decision: Decision;
    executed: boolean;
    keyUsed?: string;
    modelUsed?: string;
  },
): Promise<void> {
  log.info("insertAnalysis", { id: args.id, symbol: args.symbol, action: args.decision.action, conf: args.decision.confidence, executed: args.executed });
  await db.insert(analyses).values({
    id: args.id,
    symbol: args.symbol,
    ts: args.ts,
    price: args.price,
    snapshot: JSON.stringify(args.snapshot),
    trigger: args.trigger,
    action: args.decision.action,
    confidence: Math.round(args.decision.confidence),
    timeframeBias: args.decision.timeframeBias,
    reasoning: args.decision.reasoning,
    keyFactors: JSON.stringify(args.decision.keyFactors ?? []),
    stopLoss: args.decision.stopLoss,
    takeProfit: args.decision.takeProfit ? JSON.stringify(args.decision.takeProfit) : null,
    invalidation: args.decision.invalidation,
    executed: args.executed ? 1 : 0,
    keyUsed: args.keyUsed ?? null,
    modelUsed: args.modelUsed ?? null,
  });
}

/** Most recent analyses for a symbol (newest first) — used for prompt context. */
export async function getRecentAnalyses(db: DB, symbol: string, limit = 5): Promise<AnalysisRow[]> {
  const rows = await db
    .select()
    .from(analyses)
    .where(eq(analyses.symbol, symbol))
    .orderBy(desc(analyses.ts))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    ts: r.ts,
    price: r.price,
    trigger: r.trigger,
    action: r.action,
    confidence: r.confidence,
    reasoning: r.reasoning,
    stopLoss: r.stopLoss,
    executed: r.executed,
    outcomePnlPct: r.outcomePnlPct,
    outcomeCorrect: r.outcomeCorrect,
  }));
}

/** Analyses old enough to evaluate but not yet scored (for the learning loop). */
export async function getUnevaluatedAnalyses(db: DB, olderThanMs: number, limit = 20): Promise<AnalysisRow[]> {
  const rows = await db
    .select()
    .from(analyses)
    .where(and(isNull(analyses.evaluatedAt), lt(analyses.ts, olderThanMs)))
    .orderBy(asc(analyses.ts))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    ts: r.ts,
    price: r.price,
    trigger: r.trigger,
    action: r.action,
    confidence: r.confidence,
    reasoning: r.reasoning,
    stopLoss: r.stopLoss,
    executed: r.executed,
    outcomePnlPct: r.outcomePnlPct,
    outcomeCorrect: r.outcomeCorrect,
  }));
}

export async function setAnalysisOutcome(
  db: DB,
  id: string,
  pnlPct: number,
  correct: boolean,
): Promise<void> {
  log.info("setAnalysisOutcome", { id, pnlPct: Math.round(pnlPct * 100) / 100, correct });
  await db
    .update(analyses)
    .set({ outcomePnlPct: pnlPct, outcomeCorrect: correct ? 1 : 0, evaluatedAt: Date.now() })
    .where(eq(analyses.id, id));
}

/** Win-rate stats over the last `limit` evaluated, executed analyses for a symbol. */
export async function getPerformance(db: DB, symbol: string, limit = 100): Promise<{ wins: number; losses: number; avgPnlPct: number }> {
  const rows = await db
    .select({ correct: analyses.outcomeCorrect, pnl: analyses.outcomePnlPct })
    .from(analyses)
    .where(and(eq(analyses.symbol, symbol), eq(analyses.executed, 1), sql`${analyses.outcomeCorrect} IS NOT NULL`))
    .orderBy(desc(analyses.ts))
    .limit(limit);
  let wins = 0;
  let losses = 0;
  let pnlSum = 0;
  for (const r of rows) {
    if (r.correct === 1) wins++;
    else losses++;
    pnlSum += r.pnl ?? 0;
  }
  return { wins, losses, avgPnlPct: rows.length ? pnlSum / rows.length : 0 };
}

// ── Trades ────────────────────────────────────────────────────────────────────

export async function insertTrade(
  db: DB,
  args: {
    id: string;
    analysisId: string;
    symbol: string;
    side: string;
    qty: number;
    price: number;
    stopLoss: number | null;
    takeProfit: number | null;
    status: string;
    bybitOrderId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  log.info("insertTrade", { id: args.id, side: args.side, qty: args.qty, status: args.status });
  await db.insert(trades).values({
    id: args.id,
    analysisId: args.analysisId,
    symbol: args.symbol,
    side: args.side,
    qty: args.qty,
    price: args.price,
    stopLoss: args.stopLoss,
    takeProfit: args.takeProfit,
    status: args.status,
    bybitOrderId: args.bybitOrderId ?? null,
    error: args.error ?? null,
    createdAt: Date.now(),
  });
}

export interface OpenTrade {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  createdAt: number;
}

/** Trades still open (submitted/filled) for a symbol. */
export async function getOpenTrades(db: DB, symbol: string): Promise<OpenTrade[]> {
  const rows = await db
    .select()
    .from(trades)
    .where(and(eq(trades.symbol, symbol), sql`${trades.status} IN ('submitted','filled')`))
    .orderBy(desc(trades.createdAt));
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    qty: r.qty,
    price: r.price,
    stopLoss: r.stopLoss,
    takeProfit: r.takeProfit,
    createdAt: r.createdAt,
  }));
}

export async function closeTrade(db: DB, id: string, exitPrice: number, pnlQuote: number): Promise<void> {
  log.info("closeTrade", { id, exitPrice, pnlQuote });
  await db
    .update(trades)
    .set({ status: "closed", closedAt: Date.now(), exitPrice, pnlQuote })
    .where(eq(trades.id, id));
}

// ── Market memory (mirror of Vectorize) ───────────────────────────────────────

export async function recordMemory(db: DB, id: string, symbol: string, text: string): Promise<void> {
  await db
    .insert(marketMemory)
    .values({ id, symbol, text, createdAt: Date.now() })
    .onConflictDoNothing();
}

/** Strongly-consistent exact-text dedup (Vectorize is only eventually consistent). */
export async function memoryExists(db: DB, symbol: string, text: string): Promise<boolean> {
  const row = await db
    .select({ id: marketMemory.id })
    .from(marketMemory)
    .where(and(eq(marketMemory.symbol, symbol), eq(marketMemory.text, text)))
    .limit(1);
  return row.length > 0;
}

// ── Groq usage counters (source of truth for /usage + rotation accounting) ─────

export interface UsageRow {
  date: string;
  keyIndex: number;
  model: string;
  totalTokens: number;
  totalRequests: number;
  lastUpdated: number;
}

/** Atomically add usage for a (day, key, model) triple. */
export async function addUsage(db: DB, date: string, keyIndex: number, model: string, tokens: number): Promise<void> {
  const now = Date.now();
  await db
    .insert(usageCounters)
    .values({ date, keyIndex, model, totalTokens: tokens, totalRequests: 1, lastUpdated: now })
    .onConflictDoUpdate({
      target: [usageCounters.date, usageCounters.keyIndex, usageCounters.model],
      set: {
        totalTokens: sql`${usageCounters.totalTokens} + ${tokens}`,
        totalRequests: sql`${usageCounters.totalRequests} + 1`,
        lastUpdated: now,
      },
    });
}

export async function getUsageForDay(db: DB, date: string): Promise<UsageRow[]> {
  return db
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.date, date))
    .orderBy(asc(usageCounters.keyIndex), asc(usageCounters.model));
}

export async function getUsageForKey(db: DB, date: string, keyIndex: number): Promise<UsageRow[]> {
  return db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.date, date), eq(usageCounters.keyIndex, keyIndex)))
    .orderBy(asc(usageCounters.model));
}
