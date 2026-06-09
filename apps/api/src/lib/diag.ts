import type { Ctx } from "./context";
import { computeIndicators } from "./indicators";
import { logger } from "./logger";

const log = logger("diag");

// Read-only Bybit connectivity probe. Runs each call independently so a partial
// failure is visible step-by-step. Used to prove the deployed Worker can reach Bybit.

interface Step {
  step: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function run(step: string, fn: () => Promise<unknown>): Promise<Step> {
  try {
    return { step, ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("step.failed", { step, error });
    return { step, ok: false, error };
  }
}

export async function diagnoseBybit(ctx: Ctx): Promise<{ ok: boolean; baseUrl: string; symbol: string; steps: Step[] }> {
  const { bybit, cfg } = ctx;
  const symbol = cfg.symbol;
  const steps: Step[] = [];

  steps.push(
    await run("server-time", async () => {
      const t = await bybit.getServerTime();
      return { serverTimeIso: new Date(t).toISOString(), skewMsVsWorker: t - Date.now() };
    }),
  );
  steps.push(await run("instruments-info", () => bybit.getInstrumentRules(symbol)));
  steps.push(await run("ticker-last-price", async () => ({ lastPrice: await bybit.getLastPrice(symbol) })));
  steps.push(
    await run("kline-1h+indicators", async () => {
      const candles = await bybit.getKline(symbol, "1h", 200);
      const ind = computeIndicators(candles);
      return { candles: candles.length, lastClose: candles[candles.length - 1]?.close, rsi14: +ind.rsi14.toFixed(2), adx14: +ind.adx14.toFixed(2), atrPct: +ind.atrPct.toFixed(3) };
    }),
  );
  steps.push(await run("wallet-balance (signed)", () => bybit.getWalletBalance()));

  return { ok: steps.every((s) => s.ok), baseUrl: cfg.bybitBaseUrl.replace(/\/$/, ""), symbol, steps };
}

/** Place ONE minimal market order so a real transaction shows up on the demo account. */
export async function placeTestOrder(ctx: Ctx, side: "Buy" | "Sell"): Promise<unknown> {
  const { bybit, cfg } = ctx;
  const symbol = cfg.symbol;
  const rules = await bybit.getInstrumentRules(symbol);
  const price = await bybit.getLastPrice(symbol);
  if (price <= 0) throw new Error("no price");

  const minByAmt = rules.minOrderAmt > 0 ? (rules.minOrderAmt * 1.1) / price : 0;
  const decimals = (rules.basePrecision.toString().split(".")[1] ?? "").length || 6;
  const qty = Number((Math.ceil(Math.max(rules.minOrderQty, minByAmt) / rules.basePrecision) * rules.basePrecision).toFixed(decimals));

  log.info("test-order", { symbol, side, qty, price });
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const result = await bybit.placeMarketOrder({ symbol, side, qtyBase: qty, orderLinkId: id });
  return { symbol, side, qty, refPrice: price, notional: +(qty * price).toFixed(2), orderLinkId: id, result };
}
