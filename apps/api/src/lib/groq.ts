import { createGroq } from "@ai-sdk/groq";
import { APICallError, generateObject, generateText } from "ai";
import type { z } from "zod";
import type { Cache } from "./cache";
import { addUsage, type DB } from "./db";
import { logger } from "./logger";
import type { KeyState } from "./types";

const log = logger("groq");

const MAX_OUTPUT_TOKENS = 2048;
const MAX_ATTEMPTS_CAP = 15; // try every configured key before giving up

export interface GenerateOptions {
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  keyUsed: string; // e.g. "key2"
  modelUsed: string;
  tokensUsed: number;
}

export interface StructuredResult<T> {
  object: T;
  keyUsed: string;
  modelUsed: string;
  tokensUsed: number;
}

interface KeyEntry {
  apiKey: string;
  state: KeyState;
}

/** Parse a Groq reset-time string into milliseconds. "2m30.5s"→150500, "45s"→45000. */
export function parseGroqResetTime(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);

  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g; // match ms before s
  let match: RegExpExecArray | null;
  let matched = false;
  while ((match = re.exec(trimmed)) !== null) {
    matched = true;
    const amount = parseFloat(match[1]);
    if (match[2] === "h") total += amount * 3600_000;
    else if (match[2] === "m") total += amount * 60_000;
    else if (match[2] === "s") total += amount * 1000;
    else total += amount; // ms
  }
  return matched ? Math.round(total) : 0;
}

function maskKey(key: string): string {
  return `...${key.slice(-4)}`;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function freshState(index: number, apiKey: string): KeyState {
  return {
    index,
    maskedKey: maskKey(apiKey),
    restricted: false,
    limitRequests: null,
    limitTokens: null,
    remainingRequests: null,
    remainingTokens: null,
    resetRequestsAt: null,
    resetTokensAt: null,
    isLimited: false,
    limitedUntil: null,
    lastUsed: null,
  };
}

/** Detect all GROQ_API_KEY_* in env, ordered by numeric suffix. */
function detectKeys(env: Record<string, unknown>): { index: number; apiKey: string }[] {
  const found: { index: number; apiKey: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = /^GROQ_API_KEY_(\d+)$/.exec(name);
    if (m && typeof value === "string" && value.trim() !== "") {
      found.push({ index: Number(m[1]), apiKey: value.trim() });
    }
  }
  if (found.length === 0 && typeof env.GROQ_API_KEY === "string" && env.GROQ_API_KEY.trim()) {
    found.push({ index: 1, apiKey: env.GROQ_API_KEY.trim() });
  }
  return found.sort((a, b) => a.index - b.index);
}

function isRestrictedError(err: APICallError): boolean {
  // Only a genuine org restriction permanently disables a key. Match narrowly —
  // Groq's TPM error also contains "organization" and must NOT disable a key.
  if (err.statusCode === 403) return true;
  return /organization has been restricted|account has been deactivated/i.test(err.message ?? "");
}

/** A per-request size error (model TPM too small) — failover across keys won't help. */
function isRequestTooLarge(err: APICallError): boolean {
  return err.statusCode === 413 || /request too large|reduce your message size/i.test(err.message ?? "");
}

export class GroqManager {
  private keys: KeyEntry[];
  private hydrated = false;
  readonly chatModel: string;
  readonly utilityModel: string;

  constructor(
    env: Record<string, unknown>,
    private db: DB,
    private cache: Cache,
  ) {
    this.keys = detectKeys(env).map(({ index, apiKey }) => ({ apiKey, state: freshState(index, apiKey) }));
    this.chatModel = (env.GROQ_CHAT_MODEL as string) || "openai/gpt-oss-120b";
    this.utilityModel = (env.GROQ_UTILITY_MODEL as string) || "llama-3.1-8b-instant";
  }

  get keyCount(): number {
    return this.keys.length;
  }

  /** Prepare key state. We deliberately SKIP reading per-key state from Redis: with a
   * ~1-call/minute bot we never approach rate limits, and with 15 keys those reads would
   * cost 15 subrequests every cycle (blowing the Worker subrequest budget). In-memory
   * failover within the invocation is sufficient. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    this.refreshLimits();
  }

  async getStates(): Promise<KeyState[]> {
    await this.hydrate();
    this.refreshLimits();
    return this.keys.map((e) => ({ ...e.state }));
  }

  private refreshLimits(): void {
    const now = Date.now();
    for (const { state } of this.keys) {
      if (state.isLimited && state.limitedUntil != null && now >= state.limitedUntil) {
        state.isLimited = false;
        state.limitedUntil = null;
      }
    }
  }

  /** Pick the best usable key: not restricted, not rate-limited, most remaining tokens. */
  private selectKey(tried: Set<number>): KeyEntry | null {
    this.refreshLimits();
    const now = Date.now();
    const usable = this.keys.filter(
      (e) =>
        !e.state.restricted &&
        !tried.has(e.state.index) &&
        !(e.state.isLimited && e.state.limitedUntil != null && now < e.state.limitedUntil),
    );
    if (usable.length === 0) return null;
    return usable.reduce((best, cur) => {
      const b = best.state.remainingTokens ?? Number.POSITIVE_INFINITY;
      const c = cur.state.remainingTokens ?? Number.POSITIVE_INFINITY;
      return c > b ? cur : best;
    });
  }

  private applyHeaders(state: KeyState, headers: Record<string, string | undefined>): void {
    const get = (n: string) => headers[n] ?? headers[n.toLowerCase()];
    const num = (v: string | undefined) => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const lr = num(get("x-ratelimit-limit-requests"));
    const lt = num(get("x-ratelimit-limit-tokens"));
    const rr = num(get("x-ratelimit-remaining-requests"));
    const rt = num(get("x-ratelimit-remaining-tokens"));
    if (lr != null) state.limitRequests = lr;
    if (lt != null) state.limitTokens = lt;
    if (rr != null) state.remainingRequests = rr;
    if (rt != null) state.remainingTokens = rt;
    const resetReq = get("x-ratelimit-reset-requests");
    const resetTok = get("x-ratelimit-reset-tokens");
    if (resetReq) state.resetRequestsAt = Date.now() + parseGroqResetTime(resetReq);
    if (resetTok) state.resetTokensAt = Date.now() + parseGroqResetTime(resetTok);
  }

  private handle429(state: KeyState, headers: Record<string, string> | undefined, errorText?: string): void {
    const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
    const resetTokens = headers?.["x-ratelimit-reset-tokens"];
    let waitMs = 0;
    if (retryAfter) waitMs = parseGroqResetTime(retryAfter);
    if (waitMs === 0 && resetTokens) waitMs = parseGroqResetTime(resetTokens);
    if (waitMs === 0 && errorText) {
      const tryIn = errorText.match(/try again in ([0-9hms.]+)/i);
      if (tryIn) waitMs = parseGroqResetTime(tryIn[1]);
    }
    if (waitMs === 0) waitMs = 60_000;
    state.isLimited = true;
    state.limitedUntil = Date.now() + waitMs;
    state.remainingTokens = 0;
    log.warn("ratelimit", { key: state.index, backoffS: Math.round(waitMs / 1000) });
  }

  private async persistUsage(state: KeyState, model: string, tokens: number): Promise<void> {
    state.lastUsed = Date.now();
    try {
      await addUsage(this.db, todayStamp(), state.index, model, tokens);
    } catch (err) {
      log.error("usage.persist.failed", { key: state.index, err: err instanceof Error ? err : String(err) });
    }
    await this.cache.setKeyState(state.index, state);
  }

  /** Shared failover loop. `run` does the actual call on a chosen key. */
  private async withFailover<R>(
    label: string,
    run: (entry: KeyEntry) => Promise<R>,
  ): Promise<R> {
    if (this.keys.length === 0) throw new Error("No Groq API keys configured (set GROQ_API_KEY_1, ...).");
    await this.hydrate();
    const tried = new Set<number>();
    let lastError: unknown = null;
    const maxAttempts = Math.min(this.keys.length, MAX_ATTEMPTS_CAP);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entry = this.selectKey(tried);
      if (!entry) break;
      tried.add(entry.state.index);
      try {
        const r = await run(entry);
        return r;
      } catch (err) {
        lastError = err;
        if (err instanceof APICallError) {
          if (err.responseHeaders) this.applyHeaders(entry.state, err.responseHeaders as Record<string, string | undefined>);
          if (isRestrictedError(err)) {
            entry.state.restricted = true;
            await this.cache.setKeyState(entry.state.index, entry.state);
            log.warn(`${label}.key.restricted`, { key: entry.state.index });
            continue;
          }
          if (err.statusCode === 429) {
            this.handle429(entry.state, err.responseHeaders, err.message);
            await this.cache.setKeyState(entry.state.index, entry.state);
            continue;
          }
          if (isRequestTooLarge(err)) throw err; // same on every key
        }
        if (attempt >= 1) throw err; // non-rate-limit: one retry then give up
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("All Groq API keys are restricted, rate limited, or unavailable.");
  }

  /** Plain text generation with key failover. */
  async generate(
    messages: { role: "user" | "assistant"; content: string }[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const model = opts.model ?? this.chatModel;
    return this.withFailover("generate", async (entry) => {
      const groq = createGroq({ apiKey: entry.apiKey });
      const result = await generateText({
        model: groq(model),
        system: opts.systemPrompt,
        messages,
        maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        temperature: opts.temperature,
      });
      this.applyHeaders(entry.state, (result.response?.headers ?? {}) as Record<string, string | undefined>);
      const tokensUsed = result.totalUsage?.totalTokens ?? result.usage?.totalTokens ?? 0;
      await this.persistUsage(entry.state, model, tokensUsed);
      log.info("generate.ok", { key: entry.state.index, model, tokens: tokensUsed });
      return { text: result.text, keyUsed: `key${entry.state.index}`, modelUsed: model, tokensUsed };
    });
  }

  /** Structured (schema-typed) generation with key failover — used for trade decisions. */
  async generateStructured<T>(
    schema: z.ZodSchema<T>,
    messages: { role: "user" | "assistant"; content: string }[],
    opts: GenerateOptions = {},
  ): Promise<StructuredResult<T>> {
    const model = opts.model ?? this.chatModel;
    return this.withFailover("generateStructured", async (entry) => {
      const groq = createGroq({ apiKey: entry.apiKey });
      const result = await generateObject({
        model: groq(model),
        schema,
        system: opts.systemPrompt,
        messages,
        maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        temperature: opts.temperature,
      });
      this.applyHeaders(entry.state, (result.response?.headers ?? {}) as Record<string, string | undefined>);
      const tokensUsed = result.usage?.totalTokens ?? 0;
      await this.persistUsage(entry.state, model, tokensUsed);
      log.info("structured.ok", { key: entry.state.index, model, tokens: tokensUsed });
      return { object: result.object, keyUsed: `key${entry.state.index}`, modelUsed: model, tokensUsed };
    });
  }
}
