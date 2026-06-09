import type { Candidate, Indicators, MarketSnapshot, Regime, Signal } from "./types";

// Rule-based strategy distilled from professional crypto TA practice (see README
// sources). It runs every minute with ZERO tokens and produces a Signal per symbol;
// the LLM is only consulted afterwards on the symbols/events that warrant it.
//
// Core ideas:
//  • Regime first (ADX): trend-following when trending, mean-reversion when ranging,
//    and STAND ASIDE when choppy — most losses come from trading a regime that
//    doesn't suit the strategy.
//  • Multi-timeframe confluence: 1D sets macro bias, 4H sets regime/trend, 1H times entries.
//  • Spot-only: we cannot short, so a bearish read means "flat / be in cash", not "sell short".

const ADX_TREND = 25; // ≥ ⇒ trending
const ADX_CHOP = 20; // < ⇒ ranging (mean-reversion); between = transitional/choppy

/** Classify the market regime from the 4H (trend) + 1D (macro) timeframes. */
export function detectRegime(snap: MarketSnapshot): Regime {
  const t = snap.tf4h;
  const d = snap.tf1d;
  const adx = t.adx14;
  const up4h = t.ema20 > t.ema50 && t.ema50 > t.ema200;
  const down4h = t.ema20 < t.ema50 && t.ema50 < t.ema200;
  const macroUp = d.price >= d.ema200;

  if (adx >= ADX_TREND && up4h && macroUp) return "trend_up";
  if (adx >= ADX_TREND && down4h) return "trend_down";
  if (adx < ADX_CHOP) return "range";
  return "choppy";
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Produce a directional signal + 0-100 conviction for one symbol. */
export function buildSignal(snap: MarketSnapshot): Signal {
  const regime = detectRegime(snap);
  const h = snap.tf1h;
  const reasons: string[] = [`regime ${regime} (ADX4h ${snap.tf4h.adx14.toFixed(0)})`];

  if (regime === "choppy") {
    reasons.push("pasar choppy → tahan modal");
    return { symbol: snap.symbol, regime, bias: "flat", strength: 0, reasons };
  }

  if (regime === "trend_up") {
    // Trend-following long. Want: not yet overbought, momentum positive, price holding above 1H EMA20.
    const momentum = h.macdHist > 0 ? 1 : 0;
    const notOverbought = h.rsi14 < 72 ? 1 : 0;
    const pullbackOk = h.price >= h.ema20 ? 1 : 0.5; // entering on/after a pullback
    const align = snap.tf1h.ema20 > snap.tf1h.ema50 ? 1 : 0;
    let strength = 50 + snap.tf4h.adx14 * 0.6; // strong trend → higher base
    strength += momentum * 12 + notOverbought * 8 + align * 8;
    strength *= pullbackOk;
    if (h.rsi14 >= 72) reasons.push(`RSI1h ${h.rsi14.toFixed(0)} overbought → entry hati-hati`);
    if (momentum) reasons.push("MACD1h bullish");
    const bias = notOverbought && momentum ? "long" : "flat";
    return { symbol: snap.symbol, regime, bias, strength: clamp(strength), reasons };
  }

  if (regime === "trend_down") {
    reasons.push("tren turun → spot stay cash / keluar posisi");
    return { symbol: snap.symbol, regime, bias: "short", strength: clamp(40 + snap.tf4h.adx14 * 0.4), reasons };
  }

  // range → mean reversion
  const nearLow = h.price <= h.bbLower * 1.002;
  const nearHigh = h.price >= h.bbUpper * 0.998;
  if (nearLow && h.rsi14 <= 38) {
    reasons.push(`oversold di support (RSI ${h.rsi14.toFixed(0)}, BB bawah)`);
    return { symbol: snap.symbol, regime, bias: "long", strength: clamp(55 + (38 - h.rsi14) * 2), reasons };
  }
  if (nearHigh && h.rsi14 >= 62) {
    reasons.push(`overbought di resistance (RSI ${h.rsi14.toFixed(0)}, BB atas)`);
    return { symbol: snap.symbol, regime, bias: "short", strength: clamp(55 + (h.rsi14 - 62) * 2), reasons };
  }
  reasons.push("range tanpa edge jelas → tahan");
  return { symbol: snap.symbol, regime, bias: "flat", strength: 0, reasons };
}

/** Composite selection score for ranking long candidates (relative strength + liquidity aware). */
export function scoreCandidate(snap: MarketSnapshot, sig: Signal): number {
  if (sig.bias !== "long") return 0;
  const h = snap.tf1h;
  const relStrength = clamp(50 + snap.tf4h.changePct * 2); // outperformance proxy over the 4H window
  const liquidity = h.volumeSma20 > 0 ? 1 : 0.3; // crude liquidity gate
  // Weight conviction most, then relative strength, scaled by liquidity.
  return (sig.strength * 0.7 + relStrength * 0.3) * liquidity;
}

/** Rank all scanned symbols; best long candidates first. */
export function rankCandidates(snapshots: MarketSnapshot[]): Candidate[] {
  return snapshots
    .map((snapshot) => {
      const signal = buildSignal(snapshot);
      return { symbol: snapshot.symbol, snapshot, signal, score: scoreCandidate(snapshot, signal) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Convenience: a one-line read of an indicator block (for prompts/logs). */
export function describeIndicators(i: Indicators): string {
  return `RSI ${i.rsi14.toFixed(0)} ADX ${i.adx14.toFixed(0)} MACDh ${i.macdHist.toFixed(2)} ATR% ${i.atrPct.toFixed(2)} EMA20/50/200 ${i.ema20.toFixed(0)}/${i.ema50.toFixed(0)}/${i.ema200.toFixed(0)}`;
}
