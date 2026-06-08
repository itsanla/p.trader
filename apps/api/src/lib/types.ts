// Shared domain types for the trading Worker.

// ── Worker environment (bindings + vars) ──────────────────────────────────────
// Self-contained so we don't depend on the (stale) generated worker-configuration.d.ts.
export interface TraderEnv {
  // Cloudflare bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  // App config
  APP_TIMEZONE?: string;
  LOGS_INGEST_URL?: string;
  ADMIN_SECRET?: string; // if set, guards manual trigger endpoints

  // Trading config (all optional → sensible defaults in config.ts)
  TRADING_SYMBOL?: string; // e.g. "BTCUSDC"
  BASE_COIN?: string; // e.g. "BTC"
  QUOTE_COIN?: string; // e.g. "USDC"
  EXECUTE_TRADES?: string; // "true" | "false" — false = paper mode (decide + record, no order)
  MIN_CONFIDENCE?: string; // skip BUY/SELL below this (0-100)
  RISK_PCT?: string; // % of quote equity to risk per trade
  MAX_POSITION_PCT?: string; // hard cap: max % of equity in one position
  SELF_CONSISTENCY?: string; // number of LLM samples to vote (1 = off)

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
  bbUpper: number;
  bbLower: number;
  bbMid: number;
  volume: number;
  volumeSma20: number;
}

/** A multi-timeframe snapshot of the market at one instant. */
export interface MarketSnapshot {
  symbol: string;
  price: number;
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

export interface WalletBalance {
  baseCoin: number; // e.g. BTC held
  quoteCoin: number; // e.g. USDC held
  totalEquityQuote: number; // approx equity in quote currency
}
