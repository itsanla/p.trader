import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildCtx } from "./lib/context";
import { getOpenTrades, getRecentAnalyses } from "./lib/db";
import { diagnoseBybit, placeTestOrder } from "./lib/diag";
import { logger } from "./lib/logger";
import { flushLogs, flushLogsAsync } from "./lib/logsink";
import { evaluateOutcomes, runCycle } from "./lib/trader";
import type { TraderEnv } from "./lib/types";
import { buildUsage } from "./lib/usage";

const log = logger("http");

const app = new Hono<{ Bindings: TraderEnv }>();

app.use("*", cors({ origin: (o) => o ?? "*", allowHeaders: ["Content-Type", "x-admin-secret"], allowMethods: ["GET", "POST", "OPTIONS"] }));

// Log every request and ship logs once it completes.
app.use("*", async (c, next) => {
  const start = Date.now();
  const path = new URL(c.req.url).pathname;
  log.info("req.start", { method: c.req.method, path });
  try {
    await next();
  } finally {
    log.info("req.done", { method: c.req.method, path, status: c.res.status, ms: Date.now() - start });
    flushLogs(c.env, c.executionCtx);
  }
});

// Guard manual/trading endpoints when ADMIN_SECRET is configured. Accepts the secret
// from the x-admin-secret header OR a ?key= query param (the latter lets a plain GET
// — e.g. a WebFetch probe — authenticate after deploy).
function requireAdmin(c: { env: TraderEnv; req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined } }): boolean {
  const secret = c.env.ADMIN_SECRET;
  if (!secret) return true; // unguarded if no secret set
  return c.req.header("x-admin-secret") === secret || c.req.query("key") === secret;
}

app.get("/", (c) => c.json({ ok: true, service: "trader-api", symbol: buildCtx(c.env).cfg.symbol }));

// Current state: recent decisions + open trades.
app.get("/status", async (c) => {
  const ctx = buildCtx(c.env);
  const [analyses, open] = await Promise.all([getRecentAnalyses(ctx.db, ctx.cfg.symbol, 10), getOpenTrades(ctx.db, ctx.cfg.symbol)]);
  return c.json({
    symbol: ctx.cfg.symbol,
    config: { executeTrades: ctx.cfg.executeTrades, minConfidence: ctx.cfg.minConfidence, riskPct: ctx.cfg.riskPct, selfConsistency: ctx.cfg.selfConsistency },
    openTrades: open,
    recentAnalyses: analyses,
  });
});

// Groq key rotation + usage.
app.get("/usage", async (c) => c.json(await buildUsage(buildCtx(c.env))));

// ── Diagnostics: prove the deployed Worker can reach Bybit (GET so a WebFetch can hit it) ──

// Read-only probe: server time, instrument rules, price, kline+indicators, signed wallet.
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

// Place ONE minimal market order so a real transaction appears on the demo account.
// e.g. GET /diag/test-order?key=SECRET&side=Buy
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

// Manually trigger one monitoring cycle (handy for testing the demo loop).
app.post("/run", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const ctx = buildCtx(c.env);
  try {
    const result = await runCycle(ctx);
    return c.json(result);
  } catch (err) {
    log.error("run.failed", { err: err instanceof Error ? err : String(err) });
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    flushLogs(c.env, c.executionCtx);
  }
});

// Manually run the outcome evaluator (learning loop).
app.post("/evaluate", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const ctx = buildCtx(c.env);
  const scored = await evaluateOutcomes(ctx);
  return c.json({ scored });
});

// ── Scheduled handler (cron: every 5 minutes, UTC) ────────────────────────────
async function runScheduled(env: TraderEnv): Promise<void> {
  const ctx = buildCtx(env);
  try {
    const result = await runCycle(ctx);
    log.info("cron.cycle", { fired: result.fired, action: result.action, executed: result.executed, note: result.note });
  } catch (err) {
    log.error("cron.cycle.failed", { err: err instanceof Error ? err : String(err) });
  }
  // Score matured decisions so the agent learns over time.
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
