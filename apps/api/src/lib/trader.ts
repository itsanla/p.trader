import { runDecision } from "./analysis";
import { floorToStep } from "./bybit";
import type { Ctx } from "./context";
import { runDebate } from "./debate";
import {
  closeTrade,
  getAllOpenTrades,
  getBotState,
  getOpenHeatQuote,
  getPerformance,
  getRealizedPnlToday,
  getUnevaluatedAnalyses,
  insertAnalysis,
  insertTrade,
  setAnalysisOutcome,
  setHaltedDate,
  type OpenTrade,
} from "./db";
import { computeIndicators } from "./indicators";
import { logger } from "./logger";
import { killSwitchTripped, longStop, longTarget, roundTripCostFrac, sizeLong, tradeCostQuote } from "./risk";
import { buildSignal, detectRegime, rankCandidates } from "./strategy";
import { evaluateRoute } from "./triggers";
import type { Decision, MarketSnapshot, Wallet } from "./types";
import { buildFingerprint, searchSimilar, storeMemory } from "./vector";

const log = logger("trader");

const MIN_ENTRY_STRENGTH = 55; // rule-based conviction needed before consulting the LLM

export interface CycleResult {
  ran: boolean;
  note?: string;
  scanned?: number;
  exits?: number;
  entrySymbol?: string;
  action?: string;
  confidence?: number;
  executed?: boolean;
  route?: string;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function buildSnapshot(ctx: Ctx, symbol: string): Promise<MarketSnapshot | null> {
  try {
    const [c1h, c4h, c1d, ticker] = await Promise.all([
      ctx.bybit.getKline(symbol, "1h", 200),
      ctx.bybit.getKline(symbol, "4h", 120),
      ctx.bybit.getKline(symbol, "1d", 90),
      ctx.bybit.getTicker(symbol),
    ]);
    if (!c1h.length) return null;
    return {
      symbol,
      price: ticker.last || c1h[c1h.length - 1].close,
      spreadPct: ticker.spreadPct,
      tf1h: computeIndicators(c1h),
      tf4h: computeIndicators(c4h),
      tf1d: computeIndicators(c1d),
    };
  } catch (err) {
    log.warn("snapshot.failed", { symbol, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** One monitoring cycle — runs every minute. Cheap rule scan; LLM only where it earns its tokens. */
export async function runCycle(ctx: Ctx): Promise<CycleResult> {
  const { db, cfg } = ctx;

  // 0. Master switch.
  const bot = await getBotState(db);
  if (!bot.enabled) {
    log.info("cycle.bot-off");
    return { ran: false, note: "bot OFF — perdagangan dihentikan total" };
  }

  // 1. Equity + daily kill-switch.
  let wallet: Wallet;
  try {
    wallet = await ctx.bybit.getWalletBalance();
  } catch (err) {
    // Surface the real reason (was silently swallowed) — e.g. a signed-request rejection
    // that only happens in the scheduled context. The error now carries Bybit's body snippet.
    log.error("cycle.wallet.failed", { err: err instanceof Error ? err.message : String(err) });
    return { ran: false, note: "wallet unavailable" };
  }
  const equity = wallet.totalEquityQuote;
  const today = todayStr();
  if (bot.haltedDate === today) return { ran: false, note: "halted hari ini (kill-switch)" };
  const realized = await getRealizedPnlToday(db);
  if (killSwitchTripped(cfg, equity, realized)) {
    await setHaltedDate(db, today);
    log.warn("kill-switch", { realized, equity });
    return { ran: false, note: `kill-switch aktif (rugi hari ini ${realized.toFixed(2)})` };
  }

  // 2. Scan the universe (rule-based, zero tokens).
  const snaps = (await Promise.all(cfg.universe.map((s) => buildSnapshot(ctx, s)))).filter((s): s is MarketSnapshot => s != null);
  const snapBySymbol = new Map(snaps.map((s) => [s.symbol, s]));
  const openTrades = await getAllOpenTrades(db);
  const openSymbols = new Set(openTrades.map((t) => t.symbol));

  // Rich per-symbol scan summary so the 2-hour demo is fully auditable in the logs.
  for (const s of snaps) {
    const sig = buildSignal(s);
    log.info("scan", { sym: s.symbol, price: s.price, regime: sig.regime, bias: sig.bias, strength: Math.round(sig.strength), rsi1h: +s.tf1h.rsi14.toFixed(1), adx4h: +s.tf4h.adx14.toFixed(1) });
  }

  // 3. EXIT pass — protective exits are rule-based (fast, deterministic, no LLM).
  let exits = 0;
  for (const t of openTrades) {
    const snap = snapBySymbol.get(t.symbol);
    if (!snap) continue;
    const reason = exitReason(snap, t);
    if (reason) {
      await executeExit(ctx, snap, t, reason);
      exits++;
      openSymbols.delete(t.symbol);
    }
  }

  // 4. ENTRY pass — at most one new position per cycle, only if we have room.
  let entry: CycleResult = { ran: true, scanned: snaps.length, exits };
  if (openTrades.length - exits < cfg.maxOpenPositions) {
    const candidates = rankCandidates(snaps).filter((c) => c.signal.bias === "long" && c.score > 0 && !openSymbols.has(c.symbol));
    const best = candidates[0];
    if (best && best.signal.strength >= MIN_ENTRY_STRENGTH) {
      const route = evaluateRoute(best.snapshot, best.signal, {
        hasPosition: false,
        positionAtRisk: false,
        debateEnabled: cfg.debateEnabled,
        minStrength: MIN_ENTRY_STRENGTH,
      });
      log.info("entry.route", { sym: best.symbol, route: route.route, abnormal: route.abnormal, strength: Math.round(best.signal.strength), reasons: route.reasons.join("; ") });
      if (route.route !== "none") {
        entry = { ...entry, ...(await considerEntry(ctx, best.snapshot, route.route, route.reasons, equity, wallet, await getOpenHeatQuote(db))) };
      }
    } else {
      log.info("entry.skip", { reason: best ? `kandidat terbaik ${best.symbol} strength ${Math.round(best.signal.strength)} < ${MIN_ENTRY_STRENGTH}` : "tak ada kandidat long (regime tak mendukung)" });
    }
  } else {
    log.info("entry.skip", { reason: `posisi penuh (${cfg.maxOpenPositions})` });
  }
  log.info("cycle.done", { scanned: snaps.length, exits, action: entry.action, executed: entry.executed, route: entry.route, note: entry.note });
  return entry;
}

/** Rule-based exit check for an open long. */
function exitReason(snap: MarketSnapshot, t: OpenTrade): string | null {
  if (t.side !== "Buy") return null;
  const h = snap.tf1h;
  if (t.stopLoss && snap.price <= t.stopLoss) return "stop-loss kena";
  if (t.takeProfit && snap.price >= t.takeProfit) return "take-profit kena";
  if (h.rsi14 >= 78) return `RSI ${h.rsi14.toFixed(0)} sangat overbought → amankan profit`;
  const regime = detectRegime(snap);
  if (regime === "trend_down") return "regime berbalik turun → keluar";
  if (snap.price < h.ema50 && t.price < h.ema50 === false) return "harga tembus di bawah EMA50 (1H)";
  return null;
}

async function executeExit(ctx: Ctx, snap: MarketSnapshot, t: OpenTrade, reason: string): Promise<void> {
  // PnL net of round-trip trading costs (entry + exit fees + slippage).
  const cost = tradeCostQuote(ctx.cfg, t.qty, t.price, snap.price, snap.spreadPct);
  const pnl = (snap.price - t.price) * t.qty - cost;
  log.info("exit", { symbol: t.symbol, reason, gross: ((snap.price - t.price) * t.qty).toFixed(2), cost: cost.toFixed(2), pnlNet: pnl.toFixed(2), execute: ctx.cfg.executeTrades });
  if (ctx.cfg.executeTrades) {
    await ctx.bybit.placeMarketOrder({ symbol: t.symbol, side: "Sell", qtyBase: t.qty, orderLinkId: crypto.randomUUID().replace(/-/g, "").slice(0, 32) });
  }
  await closeTrade(ctx.db, t.id, snap.price, pnl);
  await storeMemory(ctx, t.symbol, `${t.symbol} | EXIT (${reason}) @ ${snap.price} | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} quote`);
}

async function considerEntry(
  ctx: Ctx,
  snap: MarketSnapshot,
  route: "normal" | "debate",
  reasons: string[],
  equity: number,
  wallet: Wallet,
  openHeat: number,
): Promise<Partial<CycleResult>> {
  const { db, cfg, bybit } = ctx;
  const baseCoin = bybit.baseOf(snap.symbol);

  const [similar, performance] = await Promise.all([
    searchSimilar(ctx, snap.symbol, buildFingerprint(snap)),
    getPerformance(db, snap.symbol, 100),
  ]);

  const dctx = { snapshot: snap, wallet, baseCoin, openTrades: [], triggerReasons: reasons, similarMemories: similar, performance };
  const out = route === "debate" ? await runDebate(ctx, dctx) : await runDecision(ctx, dctx);
  const decision = out.decision;

  const exec = await maybeEnterLong(ctx, snap, decision, equity, wallet.quote, openHeat);

  const analysisId = crypto.randomUUID();
  await insertAnalysis(db, {
    id: analysisId,
    symbol: snap.symbol,
    ts: Date.now(),
    price: snap.price,
    snapshot: snap,
    trigger: `${route}: ${reasons.join("; ")}`,
    decision,
    executed: exec.executed,
    keyUsed: out.keyUsed,
    modelUsed: out.modelUsed,
  });

  if (exec.executed && exec.trade) {
    await insertTrade(db, {
      id: exec.trade.id,
      analysisId,
      symbol: snap.symbol,
      side: "Buy",
      qty: exec.trade.qty,
      price: snap.price,
      stopLoss: exec.stop,
      takeProfit: exec.target,
      status: exec.trade.ok ? "submitted" : "rejected",
      bybitOrderId: exec.trade.orderId,
      error: exec.trade.error,
    });
  }
  await storeMemory(ctx, snap.symbol, buildFingerprint(snap, { action: decision.action, confidence: decision.confidence }));

  return { entrySymbol: snap.symbol, action: decision.action, confidence: decision.confidence, executed: exec.executed, route, note: exec.note };
}

interface EnterOutcome {
  executed: boolean;
  note?: string;
  stop: number | null;
  target: number | null;
  trade?: { id: string; qty: number; ok: boolean; orderId?: string; error?: string };
}

/** Apply confidence + risk gates, size the long, and place it (if live). */
async function maybeEnterLong(ctx: Ctx, snap: MarketSnapshot, decision: Decision, equity: number, quoteAvailable: number, openHeat: number): Promise<EnterOutcome> {
  const { cfg } = ctx;
  if (decision.action !== "BUY") return { executed: false, note: decision.action, stop: null, target: null };
  if (decision.confidence < cfg.minConfidence) return { executed: false, note: `confidence ${decision.confidence} < ${cfg.minConfidence}`, stop: null, target: null };

  const price = snap.price;
  // Prefer the model's stop if sane, else ATR-based; target honors min R:R.
  const atrStop = longStop(price, snap.tf1h.atr14, cfg.atrStopMult);
  const stop = decision.stopLoss && decision.stopLoss < price && decision.stopLoss > atrStop * 0.9 ? decision.stopLoss : atrStop;
  const target = decision.takeProfit?.[0] && decision.takeProfit[0] > price ? decision.takeProfit[0] : longTarget(price, stop, cfg.minRR, cfg, snap.spreadPct);

  const sized = sizeLong({ cfg, equity, quoteAvailable, price, stop, target, openHeatQuote: openHeat, spreadPct: snap.spreadPct });
  if (sized.qty <= 0) return { executed: false, note: sized.reasons.join("; ") || "size 0", stop, target };

  let rules;
  try {
    rules = await ctx.bybit.getInstrumentRules(snap.symbol);
  } catch (err) {
    return { executed: false, note: `rules failed: ${err instanceof Error ? err.message : String(err)}`, stop, target };
  }
  const qty = floorToStep(sized.qty, rules.basePrecision);
  if (qty < rules.minOrderQty || qty <= 0) return { executed: false, note: `qty ${qty} < min ${rules.minOrderQty}`, stop, target };
  if (qty * price < rules.minOrderAmt) return { executed: false, note: `notional ${(qty * price).toFixed(2)} < min ${rules.minOrderAmt}`, stop, target };

  if (!cfg.executeTrades) return { executed: false, note: `paper: would BUY ${qty} (R:R ${sized.rr.toFixed(2)})`, stop, target };

  const id = crypto.randomUUID();
  const res = await ctx.bybit.placeMarketOrder({ symbol: snap.symbol, side: "Buy", qtyBase: qty, orderLinkId: id.replace(/-/g, "").slice(0, 32) });
  return {
    executed: res.ok,
    note: res.ok ? `BUY ${qty} @~${price} (R:R ${sized.rr.toFixed(2)})` : `rejected: ${res.error}`,
    stop,
    target,
    trade: { id, qty, ok: res.ok, orderId: res.orderId, error: res.error },
  };
}

// ── Learning loop ─────────────────────────────────────────────────────────────
const EVAL_AGE_MS = 12 * 3600_000;
const CORRECT_PNL_PCT = 0.5;

export async function evaluateOutcomes(ctx: Ctx): Promise<number> {
  const due = await getUnevaluatedAnalyses(ctx.db, Date.now() - EVAL_AGE_MS, 20);
  if (due.length === 0) return 0;
  const priceCache = new Map<string, number>();
  let scored = 0;
  for (const a of due) {
    let nowPrice = priceCache.get(a.symbol);
    if (nowPrice == null) {
      nowPrice = await ctx.bybit.getLastPrice(a.symbol).catch(() => 0);
      priceCache.set(a.symbol, nowPrice);
    }
    if (!nowPrice) continue;
    const movePct = ((nowPrice - a.price) / a.price) * 100;
    // Net of round-trip trading costs for actual trades — so the learning signal and
    // win-rate reflect what the account would really keep, not a fee-free fantasy.
    const costPct = a.action === "HOLD" ? 0 : roundTripCostFrac(ctx.cfg) * 100;
    let pnlPct: number;
    let correct: boolean;
    if (a.action === "BUY") {
      pnlPct = movePct - costPct;
      correct = pnlPct >= CORRECT_PNL_PCT;
    } else if (a.action === "SELL") {
      pnlPct = -movePct - costPct;
      correct = pnlPct >= CORRECT_PNL_PCT;
    } else {
      pnlPct = 0;
      correct = Math.abs(movePct) < CORRECT_PNL_PCT;
    }
    await setAnalysisOutcome(ctx.db, a.id, pnlPct, correct);
    await storeMemory(ctx, a.symbol, `${a.symbol} | aksi ${a.action} conf ${a.confidence} @ ${a.price} | HASIL ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% (${correct ? "benar" : "salah"})`);
    scored++;
  }
  log.info("evaluate.done", { scored });
  return scored;
}
