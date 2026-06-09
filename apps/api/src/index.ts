import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildCtx } from "./lib/context";
import { getAllOpenTrades, getBotState, getRealizedPnlToday, getRecentAnalysesAll, setBotEnabled, setHaltedDate } from "./lib/db";
import { diagnoseBybit, placeTestOrder } from "./lib/diag";
import { logger } from "./lib/logger";
import { flushLogs, flushLogsAsync } from "./lib/logsink";
import { evaluateOutcomes, runCycle } from "./lib/trader";
import type { TraderEnv } from "./lib/types";
import { buildUsage } from "./lib/usage";

const log = logger("http");

const app = new Hono<{ Bindings: TraderEnv }>();

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
    const wallet = await ctx.bybit.getWalletBalance();
    return c.json({ quoteCoin: ctx.cfg.quoteCoin, ...wallet });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
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

// ── Scheduled handler (cron: every minute, UTC) ───────────────────────────────
async function runScheduled(env: TraderEnv): Promise<void> {
  const ctx = buildCtx(env);
  // Cron can double-fire during propagation; claim the minute bucket so a duplicate
  // invocation doesn't run a second cycle (and risk a duplicate order). Fail-open.
  const minute = Math.floor(Date.now() / 60_000);
  if (!(await ctx.cache.claim(`cron:${minute}`, 120))) {
    log.info("cron.duplicate", { minute });
    return;
  }
  try {
    const result = await runCycle(ctx);
    log.info("cron.cycle", { ran: result.ran, exits: result.exits, action: result.action, executed: result.executed, note: result.note });
  } catch (err) {
    log.error("cron.cycle.failed", { err: err instanceof Error ? err : String(err) });
  }
  try {
    await evaluateOutcomes(ctx);
  } catch (err) {
    log.error("cron.evaluate.failed", { err: err instanceof Error ? err : String(err) });
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: TraderEnv, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env).finally(() => flushLogsAsync(env)));
  },
};
