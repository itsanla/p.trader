import { runDecision } from "./analysis";
import type { Ctx } from "./context";
import {
  closeTrade,
  getOpenTrades,
  getPerformance,
  getRecentAnalyses,
  getUnevaluatedAnalyses,
  insertAnalysis,
  insertTrade,
  setAnalysisOutcome,
} from "./db";
import { computeIndicators } from "./indicators";
import { logger } from "./logger";
import { evaluateTriggers } from "./triggers";
import type { Decision, MarketSnapshot } from "./types";
import { buildFingerprint, searchSimilar, storeMemory } from "./vector";
import { floorToStep, type InstrumentRules } from "./bybit";

const log = logger("trader");

export interface CycleResult {
  fired: boolean;
  reasons: string[];
  action?: string;
  confidence?: number;
  executed?: boolean;
  note?: string;
}

/** Build the multi-timeframe snapshot from fresh Bybit klines. */
async function buildSnapshot(ctx: Ctx): Promise<MarketSnapshot> {
  const [c1h, c4h, c1d, price] = await Promise.all([
    ctx.bybit.getKline("1h", 200),
    ctx.bybit.getKline("4h", 120),
    ctx.bybit.getKline("1d", 90),
    ctx.bybit.getLastPrice(),
  ]);
  return {
    symbol: ctx.cfg.symbol,
    price: price || c1h[c1h.length - 1]?.close || 0,
    tf1h: computeIndicators(c1h),
    tf4h: computeIndicators(c4h),
    tf1d: computeIndicators(c1d),
  };
}

/**
 * One monitoring cycle (called every 5 minutes). Cheap until a trigger fires; only
 * then does it wake the LLM, decide, and (optionally) execute on the demo account.
 */
export async function runCycle(ctx: Ctx): Promise<CycleResult> {
  const symbol = ctx.cfg.symbol;
  const snapshot = await buildSnapshot(ctx);
  if (snapshot.price <= 0) {
    log.warn("cycle.no-price");
    return { fired: false, reasons: [], note: "no price data" };
  }

  const [openTrades, recent] = await Promise.all([getOpenTrades(ctx.db, symbol), getRecentAnalyses(ctx.db, symbol, 1)]);
  const minutesSince = recent[0] ? (Date.now() - recent[0].ts) / 60000 : Number.POSITIVE_INFINITY;

  const trig = evaluateTriggers(snapshot, openTrades, minutesSince);
  if (!trig.fire) {
    log.info("cycle.quiet", { price: snapshot.price, rsi1h: snapshot.tf1h.rsi14.toFixed(1) });
    return { fired: false, reasons: [] };
  }
  log.info("cycle.fire", { reasons: trig.reasons.join("; ") });

  // Gather decision context (wallet, memory, performance) only now that we're firing.
  const fingerprint = buildFingerprint(snapshot);
  const [wallet, similarMemories, performance] = await Promise.all([
    ctx.bybit.getWalletBalance(),
    searchSimilar(ctx, symbol, fingerprint),
    getPerformance(ctx.db, symbol, 100),
  ]);

  const { decision, keyUsed, modelUsed } = await runDecision(ctx, {
    snapshot,
    wallet,
    openTrades,
    triggerReasons: trig.reasons,
    similarMemories,
    performance,
  });

  // Execute (or paper-record) under hard safety gates.
  const exec = await maybeExecute(ctx, snapshot, decision, wallet);

  const analysisId = crypto.randomUUID();
  await insertAnalysis(ctx.db, {
    id: analysisId,
    symbol,
    ts: Date.now(),
    price: snapshot.price,
    snapshot,
    trigger: trig.reasons.join("; "),
    decision,
    executed: exec.executed,
    keyUsed,
    modelUsed,
  });

  if (exec.executed && exec.trade) {
    await insertTrade(ctx.db, {
      id: exec.trade.id,
      analysisId,
      symbol,
      side: exec.trade.side,
      qty: exec.trade.qty,
      price: snapshot.price,
      stopLoss: decision.stopLoss,
      takeProfit: decision.takeProfit?.[0] ?? null,
      status: exec.trade.ok ? "submitted" : "rejected",
      bybitOrderId: exec.trade.orderId,
      error: exec.trade.error,
    });
  }

  // Store the decision fingerprint now; outcome is appended later by the evaluator.
  await storeMemory(ctx, symbol, buildFingerprint(snapshot, { action: decision.action, confidence: decision.confidence }));

  return {
    fired: true,
    reasons: trig.reasons,
    action: decision.action,
    confidence: decision.confidence,
    executed: exec.executed,
    note: exec.note,
  };
}

interface ExecOutcome {
  executed: boolean;
  note?: string;
  trade?: { id: string; side: "Buy" | "Sell"; qty: number; ok: boolean; orderId?: string; error?: string };
}

/** Apply confidence/risk/balance gates, size the order, and place it (if live). */
async function maybeExecute(ctx: Ctx, snap: MarketSnapshot, decision: Decision, wallet: { baseCoin: number; quoteCoin: number; totalEquityQuote: number }): Promise<ExecOutcome> {
  const { cfg } = ctx;
  if (decision.action === "HOLD") return { executed: false, note: "HOLD" };
  if (decision.confidence < cfg.minConfidence) return { executed: false, note: `confidence ${decision.confidence} < ${cfg.minConfidence}` };
  if (decision.stopLoss == null) return { executed: false, note: "no stop-loss → skip" };

  const price = snap.price;
  const side: "Buy" | "Sell" = decision.action === "BUY" ? "Buy" : "Sell";

  // Risk-based sizing: qty so that (entry→stop) loss ≈ riskPct of equity.
  const riskQuote = wallet.totalEquityQuote * (cfg.riskPct / 100);
  const perUnitRisk = Math.abs(price - decision.stopLoss);
  if (perUnitRisk <= 0) return { executed: false, note: "invalid stop distance" };
  let qty = riskQuote / perUnitRisk;

  // Cap by max position size.
  const maxQtyByCap = (wallet.totalEquityQuote * (cfg.maxPositionPct / 100)) / price;
  qty = Math.min(qty, maxQtyByCap);

  // Cap by what we can actually trade on spot.
  if (side === "Buy") qty = Math.min(qty, (wallet.quoteCoin * 0.99) / price);
  else qty = Math.min(qty, wallet.baseCoin * 0.99);

  let rules: InstrumentRules;
  try {
    rules = await ctx.bybit.getInstrumentRules();
  } catch (err) {
    return { executed: false, note: `instrument rules failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  qty = floorToStep(qty, rules.basePrecision);
  if (qty < rules.minOrderQty || qty <= 0) return { executed: false, note: `qty ${qty} below min ${rules.minOrderQty}` };
  if (qty * price < rules.minOrderAmt) return { executed: false, note: `notional ${(qty * price).toFixed(2)} below min ${rules.minOrderAmt}` };

  if (!cfg.executeTrades) {
    log.info("paper", { side, qty, price });
    return { executed: false, note: `paper mode (would ${side} ${qty})` };
  }

  const id = crypto.randomUUID();
  // NOTE: broker-side TP/SL on Bybit SPOT needs extra params (tpslMode, slOrderType)
  // and is easily rejected, so for the demo loop we place a clean market order and
  // keep SL/TP in our own DB — exits are managed by our evaluator/triggers. Wiring
  // native spot TP/SL is a follow-up once the base loop is validated.
  const res = await ctx.bybit.placeMarketOrder({
    side,
    qtyBase: qty,
    orderLinkId: id.replace(/-/g, "").slice(0, 32),
    stopLoss: null,
    takeProfit: null,
    tickSize: rules.tickSize,
  });

  return {
    executed: res.ok,
    note: res.ok ? `${side} ${qty} @~${price}` : `order rejected: ${res.error}`,
    trade: { id, side, qty, ok: res.ok, orderId: res.orderId, error: res.error },
  };
}

/**
 * Learning loop: score analyses old enough to judge by comparing the price then vs
 * now, then append the outcome to long-term memory. Runs alongside the cycle.
 */
const EVAL_AGE_MS = 12 * 3600_000; // judge a decision after 12 hours
const CORRECT_PNL_PCT = 0.5; // a BUY/SELL is "correct" if it moved ≥0.5% the right way

export async function evaluateOutcomes(ctx: Ctx): Promise<number> {
  const due = await getUnevaluatedAnalyses(ctx.db, Date.now() - EVAL_AGE_MS, 20);
  if (due.length === 0) return 0;
  let nowPrice = 0;
  try {
    nowPrice = await ctx.bybit.getLastPrice();
  } catch {
    return 0;
  }
  if (nowPrice <= 0) return 0;

  let scored = 0;
  for (const a of due) {
    const movePct = ((nowPrice - a.price) / a.price) * 100;
    // For BUY a rise is good; for SELL a fall is good; HOLD is "correct" if price stayed flat.
    let pnlPct: number;
    let correct: boolean;
    if (a.action === "BUY") {
      pnlPct = movePct;
      correct = movePct >= CORRECT_PNL_PCT;
    } else if (a.action === "SELL") {
      pnlPct = -movePct;
      correct = -movePct >= CORRECT_PNL_PCT;
    } else {
      pnlPct = 0;
      correct = Math.abs(movePct) < CORRECT_PNL_PCT;
    }
    await setAnalysisOutcome(ctx.db, a.id, pnlPct, correct);

    // Close any open trade tied to a now-judged decision (demo bookkeeping).
    if (a.executed) {
      const open = await getOpenTrades(ctx.db, a.symbol);
      for (const t of open) {
        const pnlQuote = (t.side === "Buy" ? nowPrice - t.price : t.price - nowPrice) * t.qty;
        await closeTrade(ctx.db, t.id, nowPrice, pnlQuote);
      }
    }

    // Append the realized outcome to long-term memory so similar future setups recall it.
    await storeMemory(ctx, a.symbol, `${a.symbol} | aksi ${a.action} conf ${a.confidence} @ ${a.price} | HASIL ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% (${correct ? "benar" : "salah"})`);
    scored++;
  }
  log.info("evaluate.done", { scored });
  return scored;
}
