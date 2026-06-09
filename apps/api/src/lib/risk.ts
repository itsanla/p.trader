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

/** First take-profit honoring the minimum reward:risk. */
export function longTarget(price: number, stop: number, minRR: number): number {
  return price + minRR * (price - stop);
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
}): SizedOrder {
  const { cfg, equity, quoteAvailable, price, stop, target } = args;
  const reasons: string[] = [];
  const perUnitRisk = price - stop;
  if (perUnitRisk <= 0) return { qty: 0, riskQuote: 0, rr: 0, reasons: ["stop ≥ price (invalid)"] };

  const rr = (target - price) / perUnitRisk;
  if (rr < cfg.minRR) reasons.push(`R:R ${rr.toFixed(2)} < ${cfg.minRR} → skip`);

  const riskQuote = equity * (cfg.riskPct / 100);
  // Portfolio heat: don't let total open risk exceed the cap.
  const heatRoom = equity * (cfg.portfolioHeatPct / 100) - args.openHeatQuote;
  if (heatRoom <= 0) reasons.push(`portfolio heat penuh (${cfg.portfolioHeatPct}%)`);
  const effectiveRisk = Math.min(riskQuote, Math.max(0, heatRoom));

  let qty = effectiveRisk / perUnitRisk;
  qty = Math.min(qty, (equity * (cfg.maxPositionPct / 100)) / price); // position cap
  qty = Math.min(qty, (quoteAvailable * 0.99) / price); // can't spend more quote than we have

  if (reasons.length) return { qty: 0, riskQuote: 0, rr, reasons };
  return { qty, riskQuote: effectiveRisk, rr, reasons };
}

/** Daily kill-switch: true ⇒ trading must halt for the rest of the day. */
export function killSwitchTripped(cfg: TradingConfig, equity: number, realizedPnlTodayQuote: number): boolean {
  if (realizedPnlTodayQuote >= 0) return false;
  const lossPct = (-realizedPnlTodayQuote / Math.max(1, equity)) * 100;
  return lossPct >= cfg.killSwitchPct;
}
