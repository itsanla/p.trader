import { runSelection, type SelectionCandidate } from "./analysis";
import { floorToStep } from "./bybit";
import type { Ctx } from "./context";
import {
  closeTrade,
  getAllOpenTrades,
  getBotState,
  getOpenHeatQuote,
  getPerformanceAll,
  getRealizedPnlToday,
  recordEquityIfDue,
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
import { screenMarket } from "./screener";
import { detectRegime } from "./strategy";
import type { Decision, MarketSnapshot, Wallet } from "./types";
import { buildFingerprint, storeMemory } from "./vector";

const log = logger("trader");

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

// `seed` (price + spread from the screener's bulk ticker call) lets us skip a per-symbol
// ticker request, keeping the deep scan within the subrequest budget.
async function buildSnapshot(ctx: Ctx, symbol: string, seed?: { price: number; spreadPct: number }): Promise<MarketSnapshot | null> {
  try {
    const [c1h, c4h, c1d] = await Promise.all([
      ctx.bybit.getKline(symbol, "1h", 200),
      ctx.bybit.getKline(symbol, "4h", 120),
      ctx.bybit.getKline(symbol, "1d", 90),
    ]);
    if (!c1h.length) return null;
    let px: { price: number; spreadPct: number };
    if (seed) px = seed;
    else {
      const t = await ctx.bybit.getTicker(symbol);
      px = { price: t.last, spreadPct: t.spreadPct };
    }
    return {
      symbol,
      price: px.price || c1h[c1h.length - 1].close,
      spreadPct: px.spreadPct,
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
  // Hourly wealth snapshot (USD — a stable unit) for the dashboard chart.
  await recordEquityIfDue(
    db,
    equity,
    Object.entries(wallet.coinsUsd)
      .filter(([, usd]) => usd > 0.01)
      .map(([coin, usd]) => ({ coin, usd })),
  ).catch(() => {});
  const today = todayStr();
  if (bot.haltedDate === today) return { ran: false, note: "halted hari ini (kill-switch)" };
  const realized = await getRealizedPnlToday(db);
  if (killSwitchTripped(cfg, equity, realized)) {
    await setHaltedDate(db, today);
    log.warn("kill-switch", { realized, equity });
    return { ran: false, note: `kill-switch aktif (rugi hari ini ${realized.toFixed(2)})` };
  }

  // 2. Screen the WHOLE market in one call → deep-scan the momentum leaders + held coins.
  const screened = await screenMarket(ctx.bybit, cfg).catch((err) => {
    log.error("screen.failed", { err: err instanceof Error ? err.message : String(err) });
    return [];
  });
  const openTrades = await getAllOpenTrades(db);
  const openSymbols = new Set(openTrades.map((t) => t.symbol));
  const seedBySymbol = new Map(screened.map((c) => [c.symbol, c]));

  const toScan = [...new Set([...screened.map((c) => c.symbol), ...openSymbols])];
  const snaps = (
    await Promise.all(toScan.map((s) => buildSnapshot(ctx, s, seedBySymbol.has(s) ? { price: seedBySymbol.get(s)!.price, spreadPct: seedBySymbol.get(s)!.spreadPct } : undefined)))
  ).filter((s): s is MarketSnapshot => s != null);
  const snapBySymbol = new Map(snaps.map((s) => [s.symbol, s]));

  for (const c of screened.slice(0, 8)) {
    const s = snapBySymbol.get(c.symbol);
    if (s) log.info("scan", { sym: c.symbol, chg24h: +c.chg24h.toFixed(1), regime: detectRegime(s), rsi1h: +s.tf1h.rsi14.toFixed(1), adx4h: +s.tf4h.adx14.toFixed(1), volX: s.tf1h.volumeSma20 > 0 ? +(s.tf1h.volume / s.tf1h.volumeSma20).toFixed(1) : 0 });
  }

  // 3. EXIT pass (rule-based, fast, no LLM).
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

  // 4. ENTRY pass — the AI picks the best BUY from the long-eligible momentum leaders.
  let entry: CycleResult = { ran: true, scanned: snaps.length, exits };
  if (openTrades.length - exits < cfg.maxOpenPositions) {
    const shortlist = screened
      .filter((c) => !openSymbols.has(c.symbol))
      .map((c) => ({ symbol: c.symbol, snapshot: snapBySymbol.get(c.symbol), chg24h: c.chg24h }))
      .filter((c): c is { symbol: string; snapshot: MarketSnapshot; chg24h: number } => c.snapshot != null && isLongEligible(c.snapshot))
      .slice(0, 12);

    if (shortlist.length > 0) {
      entry = { ...entry, ...(await selectAndEnter(ctx, shortlist, equity, wallet, await getOpenHeatQuote(db))) };
    } else {
      log.info("entry.skip", { reason: "tak ada momentum leader yang long-eligible" });
    }
  } else {
    log.info("entry.skip", { reason: `posisi penuh (${cfg.maxOpenPositions})` });
  }
  log.info("cycle.done", { screened: screened.length, scanned: snaps.length, exits, action: entry.action, executed: entry.executed, note: entry.note });
  return entry;
}

/** A momentum leader is tradeable-long if it's not clearly downtrending or blown-off. */
function isLongEligible(s: MarketSnapshot): boolean {
  const h = s.tf1h;
  if (detectRegime(s) === "trend_down") return false;
  if (h.price < h.ema200) return false; // below long-term mean → not a leader
  if (h.rsi14 >= 80) return false; // blow-off top → chasing risk
  return true;
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

/** Let the AI pick the best BUY from the momentum shortlist, then risk-gate + execute it. */
async function selectAndEnter(ctx: Ctx, shortlist: SelectionCandidate[], equity: number, wallet: Wallet, openHeat: number): Promise<Partial<CycleResult>> {
  const { db } = ctx;
  const performance = await getPerformanceAll(db, 100);
  const sel = await runSelection(ctx, shortlist, wallet, performance);
  log.info("entry.select", { pick: sel.pick ?? "HOLD", confidence: sel.confidence, candidates: shortlist.length });
  if (!sel.pick) return { action: "HOLD", note: sel.reasoning.slice(0, 100) };

  const snap = shortlist.find((c) => c.symbol === sel.pick)?.snapshot;
  if (!snap) return { action: "HOLD", note: "pick tak valid" };

  const decision: Decision = {
    action: "BUY",
    confidence: sel.confidence,
    timeframeBias: "bullish",
    entryZone: null,
    stopLoss: sel.stopLoss,
    takeProfit: sel.takeProfit,
    reasoning: sel.reasoning,
    keyFactors: [],
    invalidation: "",
  };
  const exec = await maybeEnterLong(ctx, snap, decision, equity, wallet.quote, openHeat);

  const analysisId = crypto.randomUUID();
  await insertAnalysis(db, {
    id: analysisId,
    symbol: snap.symbol,
    ts: Date.now(),
    price: snap.price,
    snapshot: snap,
    trigger: `AI memilih dari ${shortlist.length} momentum leaders`,
    decision,
    executed: exec.executed,
    keyUsed: sel.keyUsed,
    modelUsed: sel.modelUsed,
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
  await storeMemory(ctx, snap.symbol, buildFingerprint(snap, { action: "BUY", confidence: sel.confidence }));
  return { entrySymbol: snap.symbol, action: "BUY", confidence: sel.confidence, executed: exec.executed, note: exec.note };
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
  // The AI sets the STOP (defines risk); the SYSTEM sets the TARGET to enforce the minimum
  // R:R after costs. Honor the AI's take-profit only when it's MORE ambitious than that floor —
  // otherwise a tight AI target would fail the R:R gate and we'd never trade momentum.
  const sysTarget = longTarget(price, stop, cfg.minRR, cfg, snap.spreadPct);
  const aiTP = decision.takeProfit?.[0];
  const target = aiTP && aiTP > sysTarget ? aiTP : sysTarget;

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
