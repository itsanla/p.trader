import { Redis } from "@upstash/redis/cloudflare";
import { logger } from "./logger";
import type { KeyState } from "./types";

const log = logger("cache");

// Upstash Redis is a CACHE only — D1 is the source of truth. Everything here is
// safe to lose: idempotency markers and the live Groq rate-limit state (which Worker
// isolates can't hold in memory across the separate cron invocations). All helpers
// fail open so a Redis outage (or no Redis configured) never breaks a run.

const DEDUP_TTL = 86400; // 24h idempotency window
const KEYSTATE_TTL = 7200; // 2h live rate-limit snapshot per key

export class Cache {
  private redis: Redis | null;

  constructor(env: { UPSTASH_REDIS_REST_URL?: string; UPSTASH_REDIS_REST_TOKEN?: string }) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    this.redis = url && token ? new Redis({ url, token }) : null;
  }

  get enabled(): boolean {
    return this.redis !== null;
  }

  // ── Idempotency ───────────────────────────────────────────────────────────────

  /** Claim a marker; true if first time seen (caller should proceed). Fail-open. */
  async claim(key: string, ttl = DEDUP_TTL): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const res = await this.redis.set(`claim:${key}`, "1", { nx: true, ex: ttl });
      return res === "OK";
    } catch (err) {
      log.warn("claim.failed", { key, err: err instanceof Error ? err : String(err) });
      return true;
    }
  }

  // ── Live Groq key state (per key index) ───────────────────────────────────────

  async getKeyState(index: number): Promise<Partial<KeyState> | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get<Partial<KeyState>>(`groq:state:${index}`);
    } catch {
      return null;
    }
  }

  async setKeyState(index: number, state: Partial<KeyState>): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(`groq:state:${index}`, state, { ex: KEYSTATE_TTL });
    } catch {
      /* ignore */
    }
  }
}
