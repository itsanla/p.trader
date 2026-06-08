import type { TradingConfig } from "./config";
import { logger } from "./logger";
import type { Candle, TraderEnv, WalletBalance } from "./types";

const log = logger("bybit");

// Bybit V5 client. Public market data is unauthenticated; account + trading calls
// are signed with HMAC-SHA256 over (timestamp + apiKey + recvWindow + payload),
// per https://bybit-exchange.github.io/docs/v5/guide. Demo trading uses the exact
// same scheme against https://api-demo.bybit.com.

const RECV_WINDOW = "5000";

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

/** Map our timeframe label to a Bybit kline interval string. */
export type Timeframe = "1h" | "4h" | "1d";
const INTERVAL: Record<Timeframe, string> = { "1h": "60", "4h": "240", "1d": "D" };

export interface InstrumentRules {
  basePrecision: number; // qty step for the base coin (e.g. 0.000001)
  minOrderQty: number; // min base-coin qty
  minOrderAmt: number; // min quote-coin notional
  tickSize: number; // price step
}

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  error?: string;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decimalsFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 6;
  const s = step.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Round `qty` DOWN to the instrument's base precision (never over-order). */
export function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const d = decimalsFromStep(step);
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(d));
}

export class Bybit {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly category = "spot" as const;

  constructor(env: TraderEnv, private cfg: TradingConfig) {
    this.baseUrl = cfg.bybitBaseUrl.replace(/\/$/, "");
    this.apiKey = env.BYBIT_API_KEY ?? "";
    this.apiSecret = env.BYBIT_API_SECRET ?? "";
  }

  get configured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // ── Public market data (unsigned) ──────────────────────────────────────────

  /** Fetch closed candles for a timeframe, oldest-first. Drops the still-open last candle. */
  async getKline(tf: Timeframe, limit = 200): Promise<Candle[]> {
    const qs = new URLSearchParams({
      category: this.category,
      symbol: this.cfg.symbol,
      interval: INTERVAL[tf],
      limit: String(limit),
    }).toString();
    const data = await this.publicGet<{ list: string[][] }>("/v5/market/kline", qs);
    // Bybit returns newest-first: [start, open, high, low, close, volume, turnover].
    const rows = (data.list ?? [])
      .map((r) => ({
        ts: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }))
      .sort((a, b) => a.ts - b.ts);
    // Drop the last candle if it is still forming (its open time is the current period).
    const tfMs = tf === "1h" ? 3600_000 : tf === "4h" ? 4 * 3600_000 : 24 * 3600_000;
    const now = Date.now();
    if (rows.length && rows[rows.length - 1].ts + tfMs > now) rows.pop();
    log.info("kline", { tf, symbol: this.cfg.symbol, candles: rows.length });
    return rows;
  }

  /** Bybit server time (ms). Public — used by diagnostics to confirm reachability. */
  async getServerTime(): Promise<number> {
    const data = await this.publicGet<{ timeNano: string; timeSecond: string }>("/v5/market/time", "");
    return Number(data.timeSecond) * 1000 || Math.round(Number(data.timeNano) / 1e6);
  }

  /** Latest traded price for the configured symbol. */
  async getLastPrice(): Promise<number> {
    const qs = new URLSearchParams({ category: this.category, symbol: this.cfg.symbol }).toString();
    const data = await this.publicGet<{ list: { lastPrice: string }[] }>("/v5/market/tickers", qs);
    return Number(data.list?.[0]?.lastPrice ?? 0);
  }

  /** Lot/price filters for the symbol — needed to size orders correctly. */
  async getInstrumentRules(): Promise<InstrumentRules> {
    const qs = new URLSearchParams({ category: this.category, symbol: this.cfg.symbol }).toString();
    const data = await this.publicGet<{
      list: {
        lotSizeFilter: { basePrecision: string; minOrderQty: string; minOrderAmt: string };
        priceFilter: { tickSize: string };
      }[];
    }>("/v5/market/instruments-info", qs);
    const it = data.list?.[0];
    return {
      basePrecision: Number(it?.lotSizeFilter?.basePrecision ?? "0.000001"),
      minOrderQty: Number(it?.lotSizeFilter?.minOrderQty ?? "0"),
      minOrderAmt: Number(it?.lotSizeFilter?.minOrderAmt ?? "0"),
      tickSize: Number(it?.priceFilter?.tickSize ?? "0.01"),
    };
  }

  // ── Account (signed) ────────────────────────────────────────────────────────

  /** Unified-account wallet balance, reduced to our base/quote coins + total equity. */
  async getWalletBalance(): Promise<WalletBalance> {
    const qs = new URLSearchParams({ accountType: "UNIFIED" }).toString();
    const data = await this.signedGet<{
      list: { totalEquity: string; coin: { coin: string; walletBalance: string; usdValue: string }[] }[];
    }>("/v5/account/wallet-balance", qs);
    const acct = data.list?.[0];
    let baseCoin = 0;
    let quoteCoin = 0;
    for (const c of acct?.coin ?? []) {
      if (c.coin === this.cfg.baseCoin) baseCoin = Number(c.walletBalance);
      if (c.coin === this.cfg.quoteCoin) quoteCoin = Number(c.walletBalance);
    }
    const totalEquityQuote = Number(acct?.totalEquity ?? "0") || quoteCoin;
    log.info("wallet", { base: baseCoin, quote: quoteCoin, equity: totalEquityQuote });
    return { baseCoin, quoteCoin, totalEquityQuote };
  }

  // ── Trading (signed) ──────────────────────────────────────────────────────────

  /**
   * Place a spot MARKET order. qty is always in BASE coin (we pass marketUnit=baseCoin).
   * orderLinkId makes the call idempotent — a retry with the same id won't double-fill.
   */
  async placeMarketOrder(args: {
    side: "Buy" | "Sell";
    qtyBase: number;
    orderLinkId: string;
    stopLoss?: number | null;
    takeProfit?: number | null;
    tickSize: number;
  }): Promise<OrderResult> {
    const body: Record<string, string> = {
      category: this.category,
      symbol: this.cfg.symbol,
      side: args.side,
      orderType: "Market",
      qty: String(args.qtyBase),
      marketUnit: "baseCoin",
      orderLinkId: args.orderLinkId,
    };
    // Spot TP/SL ride along on the order when supported.
    if (args.takeProfit) body.takeProfit = roundToTick(args.takeProfit, args.tickSize);
    if (args.stopLoss) body.stopLoss = roundToTick(args.stopLoss, args.tickSize);

    try {
      const res = await this.signedPost<{ orderId: string; orderLinkId: string }>("/v5/order/create", body);
      log.info("order.ok", { side: args.side, qty: args.qtyBase, orderId: res.orderId });
      return { ok: true, orderId: res.orderId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("order.failed", { side: args.side, qty: args.qtyBase, err: msg });
      return { ok: false, error: msg };
    }
  }

  // ── HTTP plumbing ─────────────────────────────────────────────────────────────

  private async publicGet<T>(path: string, qs: string): Promise<T> {
    const url = `${this.baseUrl}${path}?${qs}`;
    const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
    return this.unwrap<T>(await res.json(), path);
  }

  private async signedGet<T>(path: string, qs: string): Promise<T> {
    const ts = Date.now().toString();
    const sign = await hmacSha256Hex(this.apiSecret, ts + this.apiKey + RECV_WINDOW + qs);
    const res = await fetch(`${this.baseUrl}${path}?${qs}`, { headers: this.authHeaders(ts, sign) });
    return this.unwrap<T>(await res.json(), path);
  }

  private async signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const ts = Date.now().toString();
    const json = JSON.stringify(body);
    const sign = await hmacSha256Hex(this.apiSecret, ts + this.apiKey + RECV_WINDOW + json);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.authHeaders(ts, sign), "Content-Type": "application/json" },
      body: json,
    });
    return this.unwrap<T>(await res.json(), path);
  }

  private authHeaders(ts: string, sign: string): Record<string, string> {
    return {
      "X-BAPI-API-KEY": this.apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": sign,
    };
  }

  private unwrap<T>(json: unknown, path: string): T {
    const r = json as BybitResponse<T>;
    if (r.retCode !== 0) throw new Error(`Bybit ${path} retCode=${r.retCode} ${r.retMsg}`);
    return r.result;
  }
}

function roundToTick(price: number, tick: number): string {
  if (tick <= 0) return String(price);
  const d = decimalsFromStep(tick);
  return (Math.round(price / tick) * tick).toFixed(d);
}
