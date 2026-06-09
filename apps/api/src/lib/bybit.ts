import type { TradingConfig } from "./config";
import { logger } from "./logger";
import type { Candle, TraderEnv, Wallet } from "./types";

const log = logger("bybit");

// Bybit V5 client. Public market data is unauthenticated; account + trading calls
// are signed with HMAC-SHA256 over (timestamp + apiKey + recvWindow + payload),
// per https://bybit-exchange.github.io/docs/v5/guide. Demo trading uses the exact
// same scheme against https://api-demo.bybit.com. All market methods take an explicit
// symbol so the watcher can scan a whole universe.

const RECV_WINDOW = "5000";

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

export type Timeframe = "1h" | "4h" | "1d";
const INTERVAL: Record<Timeframe, string> = { "1h": "60", "4h": "240", "1d": "D" };
const TF_MS: Record<Timeframe, number> = { "1h": 3600_000, "4h": 4 * 3600_000, "1d": 24 * 3600_000 };

export interface InstrumentRules {
  basePrecision: number;
  minOrderQty: number;
  minOrderAmt: number;
  tickSize: number;
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

/** Round `value` DOWN to the instrument's step (never over-order). */
export function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const d = decimalsFromStep(step);
  return Number((Math.floor(value / step) * step).toFixed(d));
}

export class Bybit {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly category = "spot" as const;
  readonly quoteCoin: string;

  constructor(env: TraderEnv, cfg: TradingConfig) {
    this.baseUrl = cfg.bybitBaseUrl.replace(/\/$/, "");
    this.apiKey = env.BYBIT_API_KEY ?? "";
    this.apiSecret = env.BYBIT_API_SECRET ?? "";
    this.quoteCoin = cfg.quoteCoin;
  }

  get configured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /** Base coin of a symbol given the quote (e.g. baseOf("BTCUSDC") → "BTC"). */
  baseOf(symbol: string): string {
    return symbol.endsWith(this.quoteCoin) ? symbol.slice(0, -this.quoteCoin.length) : symbol;
  }

  // ── Public market data (unsigned) ──────────────────────────────────────────

  async getServerTime(): Promise<number> {
    const data = await this.publicGet<{ timeNano: string; timeSecond: string }>("/v5/market/time", "");
    return Number(data.timeSecond) * 1000 || Math.round(Number(data.timeNano) / 1e6);
  }

  /** Closed candles for a symbol+timeframe, oldest-first; drops the still-open last candle. */
  async getKline(symbol: string, tf: Timeframe, limit = 200): Promise<Candle[]> {
    const qs = new URLSearchParams({ category: this.category, symbol, interval: INTERVAL[tf], limit: String(limit) }).toString();
    const data = await this.publicGet<{ list: string[][] }>("/v5/market/kline", qs);
    const rows = (data.list ?? [])
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
    if (rows.length && rows[rows.length - 1].ts + TF_MS[tf] > Date.now()) rows.pop();
    return rows;
  }

  async getLastPrice(symbol: string): Promise<number> {
    return (await this.getTicker(symbol)).last;
  }

  /** Live ticker: last price + best bid/ask + measured spread % (the real cost of crossing). */
  async getTicker(symbol: string): Promise<{ last: number; bid: number; ask: number; spreadPct: number }> {
    const qs = new URLSearchParams({ category: this.category, symbol }).toString();
    const data = await this.publicGet<{ list: { lastPrice: string; bid1Price: string; ask1Price: string }[] }>("/v5/market/tickers", qs);
    const t = data.list?.[0];
    const last = Number(t?.lastPrice ?? 0);
    const bid = Number(t?.bid1Price ?? 0);
    const ask = Number(t?.ask1Price ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    const spreadPct = mid > 0 && ask > bid ? ((ask - bid) / mid) * 100 : 0;
    return { last: last || mid, bid, ask, spreadPct };
  }

  async getInstrumentRules(symbol: string): Promise<InstrumentRules> {
    const qs = new URLSearchParams({ category: this.category, symbol }).toString();
    const data = await this.publicGet<{
      list: { lotSizeFilter: { basePrecision: string; minOrderQty: string; minOrderAmt: string }; priceFilter: { tickSize: string } }[];
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

  /** Unified-account wallet: every coin balance + total equity in quote currency. */
  async getWalletBalance(): Promise<Wallet> {
    const qs = new URLSearchParams({ accountType: "UNIFIED" }).toString();
    const data = await this.signedGet<{
      list: { totalEquity: string; coin: { coin: string; walletBalance: string }[] }[];
    }>("/v5/account/wallet-balance", qs);
    const acct = data.list?.[0];
    const coins: Record<string, number> = {};
    for (const c of acct?.coin ?? []) coins[c.coin] = Number(c.walletBalance);
    const quote = coins[this.quoteCoin] ?? 0;
    const totalEquityQuote = Number(acct?.totalEquity ?? "0") || quote;
    log.info("wallet", { quote, equity: totalEquityQuote, coins: Object.keys(coins).length });
    return { coins, quote, totalEquityQuote };
  }

  // ── Trading (signed) ──────────────────────────────────────────────────────────

  /** Place a spot MARKET order. qty is in BASE coin (marketUnit=baseCoin). Idempotent via orderLinkId. */
  async placeMarketOrder(args: {
    symbol: string;
    side: "Buy" | "Sell";
    qtyBase: number;
    orderLinkId: string;
  }): Promise<OrderResult> {
    const body: Record<string, string> = {
      category: this.category,
      symbol: args.symbol,
      side: args.side,
      orderType: "Market",
      qty: String(args.qtyBase),
      marketUnit: "baseCoin",
      orderLinkId: args.orderLinkId,
    };
    try {
      const res = await this.signedPost<{ orderId: string }>("/v5/order/create", body);
      log.info("order.ok", { symbol: args.symbol, side: args.side, qty: args.qtyBase, orderId: res.orderId });
      return { ok: true, orderId: res.orderId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("order.failed", { symbol: args.symbol, side: args.side, qty: args.qtyBase, err: msg });
      return { ok: false, error: msg };
    }
  }

  // ── HTTP plumbing ─────────────────────────────────────────────────────────────

  private async publicGet<T>(path: string, qs: string): Promise<T> {
    const url = qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
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
