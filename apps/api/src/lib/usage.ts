import type { Ctx } from "./context";
import { getUsageForDay } from "./db";
import { COMBINED_TPD_PER_KEY } from "./models";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Per-key Groq usage for today (tokens summed across models) + rotation state. */
export async function buildUsage(ctx: Ctx) {
  const [states, rows] = await Promise.all([ctx.groq.getStates(), getUsageForDay(ctx.db, today())]);

  const byKey = new Map<number, { tokens: number; requests: number }>();
  for (const r of rows) {
    const agg = byKey.get(r.keyIndex) ?? { tokens: 0, requests: 0 };
    agg.tokens += r.totalTokens;
    agg.requests += r.totalRequests;
    byKey.set(r.keyIndex, agg);
  }

  const keys = states.map((s) => {
    const agg = byKey.get(s.index);
    return {
      index: s.index,
      maskedKey: s.maskedKey,
      restricted: s.restricted,
      isLimited: s.isLimited,
      limitedUntil: s.limitedUntil ? new Date(s.limitedUntil).toISOString() : null,
      totalTokens: agg?.tokens ?? 0,
      totalRequests: agg?.requests ?? 0,
      combinedTokenLimit: COMBINED_TPD_PER_KEY,
      lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : null,
    };
  });

  return {
    keys,
    combined: {
      totalKeys: keys.length,
      // Each key is a separate Groq org → daily budgets add up across keys.
      combinedDailyTokenLimit: keys.reduce((a, k) => a + (k.restricted ? 0 : k.combinedTokenLimit), 0),
      totalTokensToday: keys.reduce((a, k) => a + k.totalTokens, 0),
      totalRequestsToday: keys.reduce((a, k) => a + k.totalRequests, 0),
    },
    updatedAt: new Date().toISOString(),
  };
}
