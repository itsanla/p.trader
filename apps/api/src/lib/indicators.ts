import type { Candle, Indicators } from "./types";

// Pure technical-analysis math. Computed on the edge (cheap) so the LLM only ever
// reasons over finished numbers — never raw candles. All functions assume candles
// are oldest-first and already closed.

/** Simple moving average of the last `period` values. */
function sma(values: number[], period: number): number {
  if (values.length < period) period = values.length;
  if (period === 0) return 0;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** Exponential moving average (returns the final EMA value). */
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values, then roll forward.
  const seedLen = Math.min(period, values.length);
  let e = sma(values.slice(0, seedLen), seedLen);
  for (let i = seedLen; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Full EMA series (needed for MACD, which is an EMA of an EMA difference). */
function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = values[0];
  for (let i = 0; i < values.length; i++) {
    e = i === 0 ? values[0] : values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Wilder's RSI over `period` (default 14). Returns 0-100. */
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD(12,26,9): returns line, signal, and histogram. */
function macd(closes: number[]): { macd: number; signal: number; hist: number } {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLine: number[] = closes.map((_, i) => fast[i] - slow[i]);
  const signalSeries = emaSeries(macdLine.slice(25), 9); // start where slow EMA is meaningful
  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalSeries[signalSeries.length - 1] ?? 0;
  return { macd: macdVal, signal: signalVal, hist: macdVal - signalVal };
}

/** Wilder's ATR over `period` (default 14) — absolute, in price units. */
function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return sma(trs, Math.min(period, trs.length));
}

/** Bollinger Bands (period 20, 2σ): upper, mid, lower. */
function bollinger(closes: number[], period = 20, mult = 2): { upper: number; mid: number; lower: number } {
  const mid = sma(closes, period);
  const n = Math.min(period, closes.length);
  if (n === 0) return { upper: 0, mid: 0, lower: 0 };
  const slice = closes.slice(closes.length - n);
  const variance = slice.reduce((acc, v) => acc + (v - mid) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return { upper: mid + mult * sd, mid, lower: mid - mult * sd };
}

/** Compute the full indicator set for one timeframe's candles. */
export function computeIndicators(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const price = closes[closes.length - 1] ?? 0;
  const atr14 = atr(candles, 14);
  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  return {
    price,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.hist,
    atr14,
    atrPct: price > 0 ? (atr14 / price) * 100 : 0,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMid: bb.mid,
    volume: volumes[volumes.length - 1] ?? 0,
    volumeSma20: sma(volumes, 20),
  };
}
