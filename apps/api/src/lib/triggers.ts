import type { OpenTrade } from "./db";
import type { MarketSnapshot } from "./types";

// The 5-minute cron always runs this cheap, deterministic gate. The (token-costly,
// non-deterministic) LLM only wakes when something here fires — this decouples how
// often we MONITOR (every 5m) from how often we DECIDE (only on a real event),
// which both saves quota and prevents 5-minute whipsaw over-trading.

export interface TriggerResult {
  fire: boolean;
  reasons: string[];
}

// Force a periodic "heartbeat" decision even on a quiet market, so the agent keeps
// a fresh view and the learning loop gets regular data points.
const HEARTBEAT_MINUTES = 60;
const VOLUME_SPIKE_MULT = 1.5;
const ATR_SPIKE_PCT = 1.5;
const NEAR_LEVEL_PCT = 1.5; // open trade within this % of SL/TP

export function evaluateTriggers(
  snap: MarketSnapshot,
  openTrades: OpenTrade[],
  minutesSinceLastDecision: number,
): TriggerResult {
  const reasons: string[] = [];
  const h = snap.tf1h;
  const price = snap.price;

  // Momentum extremes on the 1H.
  if (h.rsi14 <= 30) reasons.push(`RSI 1H oversold (${h.rsi14.toFixed(1)})`);
  if (h.rsi14 >= 70) reasons.push(`RSI 1H overbought (${h.rsi14.toFixed(1)})`);

  // Bollinger breakouts / band touches on the 1H.
  if (price >= h.bbUpper) reasons.push("harga menembus Bollinger atas (1H)");
  if (price <= h.bbLower) reasons.push("harga menembus Bollinger bawah (1H)");

  // Volatility & participation spikes.
  if (h.atrPct >= ATR_SPIKE_PCT) reasons.push(`volatilitas tinggi (ATR ${h.atrPct.toFixed(2)}%)`);
  if (h.volumeSma20 > 0 && h.volume >= VOLUME_SPIKE_MULT * h.volumeSma20) reasons.push("lonjakan volume (1H)");

  // MACD histogram very close to a zero-cross (momentum flip imminent).
  if (h.atr14 > 0 && Math.abs(h.macdHist) < h.atr14 * 0.05) reasons.push("MACD mendekati persilangan (1H)");

  // Risk management on open positions: price approaching SL or TP.
  for (const t of openTrades) {
    if (t.stopLoss && Math.abs(price - t.stopLoss) / price <= NEAR_LEVEL_PCT / 100) {
      reasons.push(`posisi ${t.side} dekat stop-loss`);
    }
    if (t.takeProfit && Math.abs(price - t.takeProfit) / price <= NEAR_LEVEL_PCT / 100) {
      reasons.push(`posisi ${t.side} dekat take-profit`);
    }
  }

  // Heartbeat — keep a regular cadence even when nothing fired.
  if (reasons.length === 0 && minutesSinceLastDecision >= HEARTBEAT_MINUTES) {
    reasons.push("heartbeat berkala");
  }

  return { fire: reasons.length > 0, reasons };
}
