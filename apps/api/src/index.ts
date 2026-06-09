import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildCtx } from "./lib/context";
import { getAllOpenTrades, getBotState, getEquityHistory, getRealizedPnlToday, getRecentAnalysesAll, setBotEnabled, setHaltedDate } from "./lib/db";
import { diagnoseBybit, placeTestOrder } from "./lib/diag";
import { logger } from "./lib/logger";
import { flushLogs, flushLogsAsync } from "./lib/logsink";
import { evaluateOutcomes, runCycle, sellAllToUsdt } from "./lib/trader";
import type { TraderEnv } from "./lib/types";
import { buildKeyDetail, buildUsage } from "./lib/usage";

export { TraderTicker } from "./ticker";

const log = logger("http");

const app = new Hono<{ Bindings: TraderEnv }>();

// RPC surface of the ticker DO. The stub is created in the APAC region so its Bybit
// fetches egress from a non-geo-blocked location.
interface TickerRpc {
  ensureRunning(): Promise<{ alarmAt: number | null; colo: string }>;
  stop(): Promise<void>;
}
function ticker(env: TraderEnv): TickerRpc {
  const id = env.TICKER.idFromName("singleton");
  return env.TICKER.get(id, { locationHint: "apac" }) as unknown as TickerRpc;
}

app.use("*", cors({ origin: (o) => o ?? "*", allowHeaders: ["Content-Type", "x-admin-secret"], allowMethods: ["GET", "POST", "OPTIONS"] }));

app.use("*", async (c, next) => {
  const start = Date.now();
  const path = new URL(c.req.url).pathname;
  try {
    await next();
  } finally {
    log.info("req", { method: c.req.method, path, status: c.res.status, ms: Date.now() - start });
    flushLogs(c.env, c.executionCtx);
  }
});

// Guard: secret from x-admin-secret header OR ?key= query (so a GET WebFetch can authenticate).
function requireAdmin(c: { env: TraderEnv; req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined } }): boolean {
  const secret = c.env.ADMIN_SECRET;
  if (!secret) return true;
  return c.req.header("x-admin-secret") === secret || c.req.query("key") === secret;
}

app.get("/", (c) => c.json({ ok: true, service: "trader-api" }));

// ── Wallet summary (for the dashboard) ────────────────────────────────────────
app.get("/wallet", async (c) => {
  const ctx = buildCtx(c.env);
  try {
    const wallet = await ctx.bybit.getPortfolio();
    return c.json({ quoteCoin: ctx.cfg.quoteCoin, ...wallet });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("wallet.failed", { err: msg });
    return c.json({ error: msg }, 502);
  } finally {
    flushLogs(c.env, c.executionCtx);
  }
});

// ── Portfolio value (USD) + hourly history for the chart ──────────────────────
app.get("/equity", async (c) => {
  const ctx = buildCtx(c.env);
  const history = await getEquityHistory(ctx.db, 720);
  let current: { totalUsd: number; coins: { coin: string; usd: number; balance: number }[] } | null = null;
  try {
    const w = await ctx.bybit.getPortfolio();
    current = {
      totalUsd: w.totalEquityQuote,
      coins: Object.entries(w.coinsUsd)
        .filter(([, usd]) => usd > 0.01)
        .map(([coin, usd]) => ({ coin, usd, balance: w.coins[coin] ?? 0 }))
        .sort((a, b) => b.usd - a.usd),
    };
  } catch {
    /* still return history if wallet is briefly unavailable */
  }
  return c.json({ current, history });
});

// ── Bot status + on/off toggle ────────────────────────────────────────────────
app.get("/bot", async (c) => {
  const ctx = buildCtx(c.env);
  const [state, realized] = await Promise.all([getBotState(ctx.db), getRealizedPnlToday(ctx.db)]);
  return c.json({
    ...state,
    realizedPnlToday: realized,
    config: { universe: ctx.cfg.universe, executeTrades: ctx.cfg.executeTrades, riskPct: ctx.cfg.riskPct, minRR: ctx.cfg.minRR, killSwitchPct: ctx.cfg.killSwitchPct, debateEnabled: ctx.cfg.debateEnabled },
  });
});

app.post("/bot", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  let body: { enabled?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled (boolean) required" }, 400);
  const ctx = buildCtx(c.env);
  await setBotEnabled(ctx.db, body.enabled);
  if (body.enabled) await setHaltedDate(ctx.db, null); // turning on clears a prior kill-switch halt
  log.info("bot.toggle", { enabled: body.enabled });
  return c.json(await getBotState(ctx.db));
});

// ── Dashboard state: open trades + recent decisions ───────────────────────────
app.get("/status", async (c) => {
  const ctx = buildCtx(c.env);
  const [open, analyses, state] = await Promise.all([getAllOpenTrades(ctx.db), getRecentAnalysesAll(ctx.db, 15), getBotState(ctx.db)]);
  return c.json({ enabled: state.enabled, haltedDate: state.haltedDate, universe: ctx.cfg.universe, openTrades: open, recentAnalyses: analyses });
});

app.get("/usage", async (c) => c.json(await buildUsage(buildCtx(c.env))));

app.get("/usage/:keyIndex", async (c) => {
  const keyIndex = Number(c.req.param("keyIndex"));
  if (!Number.isInteger(keyIndex)) return c.json({ error: "Invalid key index" }, 400);
  return c.json({ keyIndex, models: await buildKeyDetail(buildCtx(c.env), keyIndex) });
});

// Withdraw: liquidate ALL coins to USDT. Only allowed while the bot is OFF.
app.post("/withdraw", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const ctx = buildCtx(c.env);
  const state = await getBotState(ctx.db);
  if (state.enabled) return c.json({ error: "Matikan bot dulu sebelum withdraw." }, 400);
  try {
    return c.json(await sellAllToUsdt(ctx));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    flushLogs(c.env, c.executionCtx);
  }
});

// ── Diagnostics (GET so a WebFetch can hit them) ──────────────────────────────
app.get("/diag", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const ctx = buildCtx(c.env);
  try {
    return c.json(await diagnoseBybit(ctx));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    flushLogs(c.env, c.executionCtx);
  }
});

app.get("/diag/test-order", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const side = (c.req.query("side") ?? "Buy").toLowerCase() === "sell" ? "Sell" : "Buy";
  const ctx = buildCtx(c.env);
  try {
    return c.json(await placeTestOrder(ctx, side));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    flushLogs(c.env, c.executionCtx);
  }
});

// Manually trigger one cycle / the evaluator.
app.post("/run", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const ctx = buildCtx(c.env);
  try {
    return c.json(await runCycle(ctx));
  } catch (err) {
    log.error("run.failed", { err: err instanceof Error ? err : String(err) });
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    flushLogs(c.env, c.executionCtx);
  }
});

app.post("/evaluate", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const ctx = buildCtx(c.env);
  return c.json({ scored: await evaluateOutcomes(ctx) });
});

// ── Autonomous ticker (Durable Object pinned to APAC) ─────────────────────────
app.get("/tick/status", async (c) => c.json(await ticker(c.env).ensureRunning()));

app.post("/tick/start", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  return c.json(await ticker(c.env).ensureRunning());
});

app.post("/tick/stop", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  await ticker(c.env).stop();
  return c.json({ stopped: true });
});

// ── Scheduled handler (cron: keepalive only) ──────────────────────────────────
// The cron runs in an arbitrary (often geo-blocked) colo, so it must NOT touch Bybit.
// It only pokes the APAC-pinned ticker DO to make sure its self-rescheduling alarm is
// alive; all real work (and Bybit egress) happens inside the DO, in APAC.
export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: TraderEnv, ctx: ExecutionContext) => {
    ctx.waitUntil(
      ticker(env)
        .ensureRunning()
        .then((s) => log.info("cron.keepalive", { alarmAt: s.alarmAt }))
        .catch((err) => log.error("cron.keepalive.failed", { err: err instanceof Error ? err.message : String(err) }))
        .finally(() => flushLogsAsync(env)),
    );
  },
};
