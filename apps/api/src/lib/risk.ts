import type { TradingConfig } from "./config";

// The risk layer is what actually prevents ruin — far more than decision cleverness.
// Sizing caps loss per trade; the R:R gate rejects low-quality setups; portfolio heat
// caps correlated exposure; the daily kill-switch stops a bad day from compounding.

export interface SizedOrder {
  qty: number; // base-coin quantity (0 ⇒ do not trade)
  riskQuote: number; // quote risked if stop hit
  rr: number; // reward:risk of the planned trade
  reasons: string[]; // why it was rejected / adjusted
}

/** ATR-based stop for a LONG entry: a multiple of ATR below price. */
export function longStop(price: number, atr14: number, mult: number): number {
  return price - mult * atr14;
}

/**
 * Round-trip cost fraction = both-side fees + crossing the spread on entry AND exit.
 * Bybit spot taker fee is 0.1%/side (verified in their fee docs); the spread is the
 * LIVE measured bid/ask gap when provided, else falls back to the configured assumption.
 */
export function roundTripCostFrac(cfg: TradingConfig, spreadPct?: number): number {
  const feeFrac = 2 * (cfg.feePct / 100);
  const spreadFrac = (spreadPct != null ? spreadPct : 2 * cfg.slippagePct) / 100;
  return feeFrac + spreadFrac;
}

/** Trading cost in quote currency for a position of `qty` at `entry`→`exit`. */
export function tradeCostQuote(cfg: TradingConfig, qty: number, entry: number, exit: number, spreadPct?: number): number {
  return (entry + exit) * qty * 0.5 * roundTripCostFrac(cfg, spreadPct);
}

/**
 * First take-profit honoring the minimum reward:risk AFTER costs. We inflate the gross
 * target so the NET reward (minus round-trip fees + real spread) still meets minRR — the
 * bot won't take a trade whose edge is eaten by trading costs.
 */
export function longTarget(price: number, stop: number, minRR: number, cfg: TradingConfig, spreadPct?: number): number {
  const risk = price - stop;
  const costPerUnit = price * roundTripCostFrac(cfg, spreadPct);
  return price + minRR * risk + costPerUnit;
}

/**
 * Size a LONG entry under all caps. Returns qty=0 with reasons when the trade should
 * be skipped (bad R:R, no balance, dust, etc.).
 */
export function sizeLong(args: {
  cfg: TradingConfig;
  equity: number;
  quoteAvailable: number;
  price: number;
  stop: number;
  target: number;
  openHeatQuote: number; // sum of risk already on open positions
  spreadPct?: number; // live measured spread (real crossing cost)
}): SizedOrder {
  const { cfg, equity, quoteAvailable, price, stop, target, spreadPct } = args;
  const perUnitRisk = price - stop;
  if (perUnitRisk <= 0) return { qty: 0, riskQuote: 0, rr: 0, reasons: ["stop ≥ price (invalid)"] };
  const stopFrac = perUnitRisk / price; // fractional distance to stop

  // Reward:risk NET of fees + real spread (loosened gate — momentum exits are dynamic).
  const costFrac = roundTripCostFrac(cfg, spreadPct);
  const rr = (target - price - price * costFrac) / perUnitRisk;
  if (rr < cfg.minRR) return { qty: 0, riskQuote: 0, rr, reasons: [`R:R net ${rr.toFixed(2)} < ${cfg.minRR} → skip`] };

  // ALLOCATION-FIRST (proactive: keep capital deployed). Start from the target position
  // size, then clamp by the per-trade risk ceiling, portfolio heat, and available cash.
  let notional = equity * (cfg.maxPositionPct / 100);
  notional = Math.min(notional, (equity * (cfg.maxRiskPct / 100)) / stopFrac); // per-trade risk ceiling
  const heatRoom = equity * (cfg.portfolioHeatPct / 100) - args.openHeatQuote;
  if (heatRoom <= 0) return { qty: 0, riskQuote: 0, rr, reasons: [`portfolio heat penuh (${cfg.portfolioHeatPct}%)`] };
  notional = Math.min(notional, heatRoom / stopFrac); // total-risk cap
  notional = Math.min(notional, quoteAvailable * (1 - cfg.cashReservePct / 100)); // cash cap (avoids insufficient-balance)

  const qty = notional / price;
  if (qty <= 0) return { qty: 0, riskQuote: 0, rr, reasons: ["notional 0"] };
  return { qty, riskQuote: notional * stopFrac, rr, reasons: [] };
}

/** Daily kill-switch: true ⇒ trading must halt for the rest of the day. */
export function killSwitchTripped(cfg: TradingConfig, equity: number, realizedPnlTodayQuote: number): boolean {
  if (realizedPnlTodayQuote >= 0) return false;
  const lossPct = (-realizedPnlTodayQuote / Math.max(1, equity)) * 100;
  return lossPct >= cfg.killSwitchPct;
}
