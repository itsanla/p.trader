import { Bybit } from "./bybit";
import { Cache } from "./cache";
import { loadConfig, type TradingConfig } from "./config";
import { getDb, type DB } from "./db";
import { GroqManager } from "./groq";
import type { TraderEnv } from "./types";

// Per-invocation context: wires up D1, the Redis cache, the Groq manager (key
// rotation), the Bybit client, and the resolved config. Built once per cron run
// or HTTP request and threaded through the trading pipeline.
export interface Ctx {
  env: TraderEnv;
  db: DB;
  cache: Cache;
  groq: GroqManager;
  bybit: Bybit;
  cfg: TradingConfig;
}

export function buildCtx(env: TraderEnv): Ctx {
  const db = getDb(env.DB);
  const cache = new Cache(env);
  const cfg = loadConfig(env);
  const groq = new GroqManager(env as unknown as Record<string, unknown>, db, cache);
  const bybit = new Bybit(env, cfg);
  return { env, db, cache, groq, bybit, cfg };
}
