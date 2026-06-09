// Shared domain types for the trading Worker.

// ── Worker environment (bindings + vars) ──────────────────────────────────────
// Self-contained so we don't depend on the (stale) generated worker-configuration.d.ts.
export interface TraderEnv {
  // Cloudflare bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  TICKER: DurableObjectNamespace; // autonomous loop, pinned to APAC (see ticker.ts)

  // App config
  APP_TIMEZONE?: string;
  LOGS_INGEST_URL?: string;
  ADMIN_SECRET?: string; // if set, guards manual trigger endpoints

  // Trading config (all optional → sensible defaults in config.ts)
  TRADING_SYMBOL?: string; // primary symbol (kept for single-symbol endpoints), e.g. "BTCUSDC"
  UNIVERSE?: string; // optional forced symbols; the screener is the primary universe now
  QUOTE_COIN?: string; // e.g. "USDT"
  MIN_TURNOVER?: string; // screener: min 24h quote turnover (liquidity)
  MAX_CHG24H?: string; // screener: drop coins moving more than this % in 24h (anomalies)
  MAX_SPREAD_PCT?: string; // screener: drop coins with a wider bid/ask spread than this
  SCREEN_TOP_N?: string; // screener: how many momentum leaders to deep-scan
  EXECUTE_TRADES?: string; // "true" | "false" — false = paper mode (decide + record, no order)
  MIN_CONFIDENCE?: string; // skip BUY/SELL below this (0-100)
  RISK_PCT?: string; // (legacy) % of quote equity to risk per trade
  MAX_RISK_PCT?: string; // ceiling: max % of equity lost if a position's stop is hit
  MAX_POSITION_PCT?: string; // target/cap: % of equity deployed per position
  CASH_RESERVE_PCT?: string; // never spend the last N% of available quote (avoids "insufficient balance")
  COOLDOWN_MINUTES?: string; // don't re-attempt the same symbol within this window
  PORTFOLIO_HEAT_PCT?: string; // max total open risk across positions
  MIN_RR?: string; // minimum reward:risk to take a trade
  ATR_STOP_MULT?: string; // stop = entry ∓ mult × ATR
  FEE_PCT?: string; // taker fee per side, % (Bybit spot ≈ 0.1)
  SLIPPAGE_PCT?: string; // assumed spread/slippage per side, %
  KILL_SWITCH_PCT?: string; // halt for the day if realized loss exceeds this % of equity
  MAX_OPEN_POSITIONS?: string; // cap concurrent positions
  SELF_CONSISTENCY?: string; // number of LLM samples to vote on normal decisions (1 = off)
  DEBATE_ENABLED?: string; // "true" to allow multi-agent debate on abnormal events

  // Groq (3 separate orgs)
  GROQ_API_KEY_1?: string;
  GROQ_API_KEY_2?: string;
  GROQ_API_KEY_3?: string;
  GROQ_CHAT_MODEL?: string; // decision model (default gpt-oss-120b)
  GROQ_UTILITY_MODEL?: string; // cheap model for summaries/embeddings prep

  // Bybit (demo)
  BYBIT_API_KEY?: string;
  BYBIT_API_SECRET?: string;
  BYBIT_BASE_URL?: string; // default https://api-demo.bybit.com

  // Upstash Redis (optional cache — fail-open)
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

// ── Groq key rotation ─────────────────────────────────────────────────────────

/** Live rate-limit state for a single Groq API key (cached in Redis). */
export interface KeyState {
  index: number;
  maskedKey: string;
  /** True when the key's org is restricted (403) — disabled for the session. */
  restricted: boolean;
  limitRequests: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null; // epoch ms
  resetTokensAt: number | null; // epoch ms
  isLimited: boolean;
  limitedUntil: number | null; // epoch ms
  lastUsed: number | null; // epoch ms
}

// ── Market data & indicators ──────────────────────────────────────────────────

/** One OHLCV candle (closed). All numbers in native units; ts is candle open (ms). */
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Computed technical indicators for a single timeframe. */
export interface Indicators {
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  atr14: number;
  atrPct: number; // atr14 / price * 100
  adx14: number; // trend strength (≥25 trending, <20 choppy)
  bbUpper: number;
  bbLower: number;
  bbMid: number;
  volume: number;
  volumeSma20: number;
  changePct: number; // % change over the loaded window (relative-strength proxy)
}

/** Market regime classification driving which strategy applies. */
export type Regime = "trend_up" | "trend_down" | "range" | "choppy";

/** Rule-based (pre-LLM) read of one symbol — produced by the free watcher. */
export interface Signal {
  symbol: string;
  regime: Regime;
  bias: "long" | "short" | "flat"; // suggested direction (spot: short ⇒ stay in cash)
  strength: number; // 0-100 composite conviction
  reasons: string[];
}

/** A ranked candidate the agent may act on. */
export interface Candidate {
  symbol: string;
  snapshot: MarketSnapshot;
  signal: Signal;
  score: number; // composite selection score
}

/** How a fired event should be handled. */
export type RouteKind = "none" | "normal" | "debate";

/** A multi-timeframe snapshot of the market at one instant. */
export interface MarketSnapshot {
  symbol: string;
  price: number;
  spreadPct: number; // live bid/ask spread % (real crossing cost)
  tf1h: Indicators;
  tf4h: Indicators;
  tf1d: Indicators;
}

// ── LLM decision ──────────────────────────────────────────────────────────────

export type Action = "BUY" | "SELL" | "HOLD";

/** Structured trading decision returned by the LLM (validated with Zod). */
export interface Decision {
  action: Action;
  confidence: number; // 0-100
  timeframeBias: "bullish" | "bearish" | "neutral";
  entryZone: [number, number] | null;
  stopLoss: number | null;
  takeProfit: number[] | null;
  reasoning: string;
  keyFactors: string[];
  invalidation: string;
}

// ── Wallet & position ─────────────────────────────────────────────────────────

export interface Wallet {
  coins: Record<string, number>; // coin symbol → wallet balance (units of the coin)
  coinsUsd: Record<string, number>; // coin symbol → value in USD
  quote: number; // balance of the quote coin (e.g. USDT)
  totalEquityQuote: number; // total account equity in quote/USD terms
}
