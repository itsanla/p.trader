import type { Ctx } from "./context";
import { computeIndicators } from "./indicators";
import { logger } from "./logger";

const log = logger("diag");

// Read-only Bybit connectivity probe. Runs each call independently so a partial
// failure (e.g. signed endpoints rejecting bad keys, public endpoints still OK) is
// visible step-by-step. Used to prove the deployed Worker can reach Bybit — the
// thing a Telkomsel-blocked local machine cannot do.

interface Step {
  step: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function run(step: string, fn: () => Promise<unknown>): Promise<Step> {
  try {
    const data = await fn();
    return { step, ok: true, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("step.failed", { step, error });
    return { step, ok: false, error };
  }
}

export async function diagnoseBybit(ctx: Ctx): Promise<{ ok: boolean; baseUrl: string; symbol: string; steps: Step[] }> {
  const { bybit, cfg } = ctx;
  const steps: Step[] = [];

  steps.push(
    await run("server-time", async () => {
      const t = await bybit.getServerTime();
      return { serverTimeIso: new Date(t).toISOString(), skewMsVsWorker: t - Date.now() };
    }),
  );

  steps.push(await run("instruments-info", () => bybit.getInstrumentRules()));
  steps.push(await run("ticker-last-price", async () => ({ lastPrice: await bybit.getLastPrice() })));

  steps.push(
    await run("kline-1h+indicators", async () => {
      const candles = await bybit.getKline("1h", 200);
      const ind = computeIndicators(candles);
      return {
        candles: candles.length,
        lastClose: candles[candles.length - 1]?.close,
        rsi14: Number(ind.rsi14.toFixed(2)),
        ema50: Number(ind.ema50.toFixed(2)),
        atrPct: Number(ind.atrPct.toFixed(3)),
      };
    }),
  );

  // Signed endpoint — this is the real test of API key + HMAC signature.
  steps.push(await run("wallet-balance (signed)", () => bybit.getWalletBalance()));

  const ok = steps.every((s) => s.ok);
  return { ok, baseUrl: (cfg.bybitBaseUrl || "").replace(/\/$/, ""), symbol: cfg.symbol, steps };
}

/**
 * Place ONE minimal market order so a real transaction shows up on the demo account.
 * Sized to the instrument's minimum (qty and notional). Explicit test tool — guarded
 * by the admin secret at the route layer.
 */
export async function placeTestOrder(ctx: Ctx, side: "Buy" | "Sell"): Promise<unknown> {
  const { bybit } = ctx;
  const rules = await bybit.getInstrumentRules();
  const price = await bybit.getLastPrice();
  if (price <= 0) throw new Error("no price");

  // Smallest qty that satisfies BOTH minOrderQty and minOrderAmt (+10% buffer over notional).
  const minByAmt = rules.minOrderAmt > 0 ? (rules.minOrderAmt * 1.1) / price : 0;
  let qty = Math.max(rules.minOrderQty, minByAmt);
  // Round UP to base precision so we never fall below the minimum.
  const decimals = (rules.basePrecision.toString().split(".")[1] ?? "").length || 6;
  qty = Number((Math.ceil(qty / rules.basePrecision) * rules.basePrecision).toFixed(decimals));

  log.info("test-order", { side, qty, price, notional: (qty * price).toFixed(2) });
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const res = await bybit.placeMarketOrder({ side, qtyBase: qty, orderLinkId: id, stopLoss: null, takeProfit: null, tickSize: rules.tickSize });
  return { side, qty, refPrice: price, notional: Number((qty * price).toFixed(2)), orderLinkId: id, result: res };
}
