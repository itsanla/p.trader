import type { Ctx } from "./context";
import { memoryExists, recordMemory } from "./db";
import { logger } from "./logger";
import type { Indicators, MarketSnapshot, TraderEnv } from "./types";

// Long-term semantic memory backed by Cloudflare Vectorize. Each entry is a textual
// "market fingerprint" (condition + decision + how it turned out), embedded on the
// edge with Workers AI (@cf/baai/bge-m3 → 1024-dim). Namespaced per symbol and
// mirrored in D1 (market_memory) as the strongly-consistent source of truth.

const log = logger("vector");

const EMBED_MODEL = "@cf/baai/bge-m3";
const TOP_K = 6;
const MIN_RELEVANCE = 0.55; // calibrated for bge-m3 cosine on Workers AI
const DEDUP_THRESHOLD = 0.92; // skip storing a fingerprint this similar to an existing one

interface MemoryMeta {
  symbol: string;
  text: string;
  createdAt: number;
  kind: "market";
  [key: string]: VectorizeVectorMetadataValue;
}

/** Embed one or more texts to 1024-dim vectors via Workers AI bge-m3. */
export async function embed(env: TraderEnv, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = (await env.AI.run(EMBED_MODEL as keyof AiModels, { text: texts })) as {
    data?: number[][];
    response?: { data?: number[][] } | number[][];
  };
  const data = res.data ?? (Array.isArray(res.response) ? res.response : res.response?.data) ?? [];
  log.info("embed", { texts: texts.length, vectors: data.length, dims: data[0]?.length ?? 0 });
  return data;
}

/** Compact one timeframe into a human/embedding-friendly phrase. */
function describeTf(label: string, i: Indicators): string {
  const trend =
    i.ema20 > i.ema50 && i.ema50 > i.ema200
      ? "tren naik kuat"
      : i.ema20 < i.ema50 && i.ema50 < i.ema200
        ? "tren turun kuat"
        : i.ema20 > i.ema50
          ? "tren naik lemah"
          : "tren turun lemah";
  const macd = i.macdHist > 0 ? "MACD bullish" : "MACD bearish";
  const vol = i.atrPct >= 1.5 ? "volatil" : "tenang";
  return `${label}: ${trend}, RSI ${i.rsi14.toFixed(0)}, ${macd}, ${vol} (ATR ${i.atrPct.toFixed(2)}%)`;
}

/** Turn a market snapshot (optionally + decision/outcome) into a fingerprint string. */
export function buildFingerprint(
  snap: MarketSnapshot,
  extra?: { action?: string; confidence?: number; outcome?: string },
): string {
  const parts = [
    `${snap.symbol} @ ${snap.price}`,
    describeTf("1H", snap.tf1h),
    describeTf("4H", snap.tf4h),
    describeTf("1D", snap.tf1d),
  ];
  if (extra?.action) parts.push(`KEPUTUSAN: ${extra.action}${extra.confidence != null ? ` conf ${extra.confidence}` : ""}`);
  if (extra?.outcome) parts.push(`HASIL: ${extra.outcome}`);
  return parts.join(" | ");
}

/** Return up to TOP_K relevant past market situations for the current snapshot. */
export async function searchSimilar(ctx: Ctx, symbol: string, queryText: string): Promise<string[]> {
  if (!queryText.trim()) return [];
  try {
    const [vector] = await embed(ctx.env, [queryText]);
    if (!vector) return [];
    const result = await ctx.env.VECTORIZE.query(vector, {
      topK: TOP_K,
      namespace: symbol,
      returnMetadata: "all",
      returnValues: false,
    });
    const memories = (result.matches ?? [])
      .filter((m) => (m.score ?? 0) >= MIN_RELEVANCE)
      .map((m) => (m.metadata as MemoryMeta | undefined)?.text)
      .filter((t): t is string => Boolean(t));
    log.info("search", { symbol, hits: memories.length, scanned: result.matches?.length ?? 0 });
    return memories;
  } catch (err) {
    log.error("search.failed", { symbol, err: err instanceof Error ? err : String(err) });
    return [];
  }
}

/** Embed, dedup, and upsert one market-memory fingerprint (per-symbol namespace) + D1 mirror. */
export async function storeMemory(ctx: Ctx, symbol: string, text: string): Promise<boolean> {
  if (!text.trim()) return false;
  try {
    const [values] = await embed(ctx.env, [text]);
    if (!values) return false;
    // Exact-text dedup via D1 first (strongly consistent).
    if (await memoryExists(ctx.db, symbol, text)) return false;
    // Semantic dedup: skip if a near-identical memory already exists.
    const existing = await ctx.env.VECTORIZE.query(values, {
      topK: 1,
      namespace: symbol,
      returnValues: false,
      returnMetadata: "none",
    });
    if ((existing.matches?.[0]?.score ?? 0) >= DEDUP_THRESHOLD) return false;

    const id = `mem:${symbol}:${crypto.randomUUID()}`;
    const metadata: MemoryMeta = { symbol, text, createdAt: Date.now(), kind: "market" };
    await ctx.env.VECTORIZE.upsert([{ id, values, namespace: symbol, metadata }]);
    await recordMemory(ctx.db, id, symbol, text);
    log.info("store.ok", { symbol, chars: text.length });
    return true;
  } catch (err) {
    log.error("store.failed", { symbol, err: err instanceof Error ? err : String(err) });
    return false;
  }
}
