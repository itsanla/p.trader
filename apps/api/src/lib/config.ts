import type { TraderEnv } from "./types";

// Central place for all tunables. Everything has a safe default so the bot runs
// out-of-the-box on the demo account, and every knob is overridable via wrangler vars.

export interface TradingConfig {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  bybitBaseUrl: string;
  executeTrades: boolean; // false = paper mode (decide + record, never send an order)
  minConfidence: number; // skip BUY/SELL below this
  riskPct: number; // % of quote equity risked per trade (entry→stop distance)
  maxPositionPct: number; // hard cap: max % of equity in one position
  selfConsistency: number; // LLM samples to majority-vote (1 = single shot)
}

function num(v: string | undefined, def: number): number {
  if (v == null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v == null || v.trim() === "") return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export function loadConfig(env: TraderEnv): TradingConfig {
  return {
    symbol: env.TRADING_SYMBOL?.trim() || "BTCUSDC",
    baseCoin: env.BASE_COIN?.trim() || "BTC",
    quoteCoin: env.QUOTE_COIN?.trim() || "USDC",
    bybitBaseUrl: env.BYBIT_BASE_URL?.trim() || "https://api-demo.bybit.com",
    executeTrades: bool(env.EXECUTE_TRADES, true), // demo account → safe to execute by default
    minConfidence: num(env.MIN_CONFIDENCE, 65),
    riskPct: num(env.RISK_PCT, 1), // risk 1% of equity per trade
    maxPositionPct: num(env.MAX_POSITION_PCT, 20), // never put >20% equity in one position
    selfConsistency: Math.max(1, Math.min(5, num(env.SELF_CONSISTENCY, 1))),
  };
}
