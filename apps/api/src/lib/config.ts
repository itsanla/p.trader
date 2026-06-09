import type { TraderEnv } from "./types";

// Central place for all tunables. Everything has a safe default so the bot runs
// out-of-the-box on the demo account, and every knob is overridable via wrangler vars.

export interface TradingConfig {
  symbol: string; // primary symbol (single-symbol endpoints/diag)
  universe: string[]; // symbols the watcher scans every minute
  quoteCoin: string;
  bybitBaseUrl: string;
  executeTrades: boolean; // false = paper mode (decide + record, never send an order)
  minConfidence: number; // skip BUY/SELL below this
  riskPct: number; // % of quote equity risked per trade (entry→stop distance)
  maxPositionPct: number; // hard cap: max % of equity in one position
  portfolioHeatPct: number; // max total open risk across all positions
  minRR: number; // minimum reward:risk to accept a trade
  atrStopMult: number; // stop distance = mult × ATR
  feePct: number; // taker fee per side (%)
  slippagePct: number; // assumed spread/slippage per side (%)
  killSwitchPct: number; // halt for the day if realized loss exceeds this % of equity
  maxOpenPositions: number; // cap concurrent open positions
  selfConsistency: number; // LLM samples to majority-vote on normal decisions
  debateEnabled: boolean; // allow multi-agent debate on abnormal events
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
  const quoteCoin = env.QUOTE_COIN?.trim() || "USDC";
  const symbol = env.TRADING_SYMBOL?.trim() || "BTCUSDC";
  const universe = (env.UNIVERSE?.trim() || `${symbol},ETHUSDC,SOLUSDC,XRPUSDC`)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    symbol,
    universe: [...new Set(universe)],
    quoteCoin,
    bybitBaseUrl: env.BYBIT_BASE_URL?.trim() || "https://api-demo.bybit.com",
    executeTrades: bool(env.EXECUTE_TRADES, true),
    minConfidence: num(env.MIN_CONFIDENCE, 65),
    riskPct: num(env.RISK_PCT, 1),
    maxPositionPct: num(env.MAX_POSITION_PCT, 20),
    portfolioHeatPct: num(env.PORTFOLIO_HEAT_PCT, 6),
    minRR: num(env.MIN_RR, 2),
    atrStopMult: num(env.ATR_STOP_MULT, 2),
    feePct: num(env.FEE_PCT, 0.1), // Bybit spot taker ≈ 0.1% per side
    slippagePct: num(env.SLIPPAGE_PCT, 0.05),
    killSwitchPct: num(env.KILL_SWITCH_PCT, 5),
    maxOpenPositions: Math.max(1, num(env.MAX_OPEN_POSITIONS, 3)),
    selfConsistency: Math.max(1, Math.min(5, num(env.SELF_CONSISTENCY, 3))),
    debateEnabled: bool(env.DEBATE_ENABLED, true),
  };
}
