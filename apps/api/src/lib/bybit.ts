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

/** Raw spot ticker row from /v5/market/tickers (all fields are strings). */
export interface RawTicker {
  symbol: string;
  lastPrice: string;
  bid1Price: string;
  ask1Price: string;
  turnover24h: string;
  price24hPcnt: string;
}

const STABLE_USD = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "BUSD", "USDD", "PYUSD"]);

/** Build a coin→USD-price map from live tickers (e.g. BTC→last of BTCUSDT). */
export function usdPriceMap(tickers: RawTicker[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tickers) {
    if (t.symbol.endsWith("USDT")) {
      const base = t.symbol.slice(0, -4);
      const px = Number(t.lastPrice);
      if (px > 0) m.set(base, px);
    }
  }
  return m;
}

/**
 * Re-value a wallet using LIVE market prices. Bybit's DEMO account reports a frozen
 * usdValue/totalEquity, so we compute portfolio value ourselves: balance × live price
 * (stablecoins = $1). This is the number that actually moves with the market.
 */
export function walletUsd(raw: Wallet, prices: Map<string, number>): Wallet {
  const coinsUsd: Record<string, number> = {};
  let total = 0;
  for (const [coin, bal] of Object.entries(raw.coins)) {
    const px = STABLE_USD.has(coin) ? 1 : prices.get(coin) ?? 0;
    const usd = bal * px;
    coinsUsd[coin] = usd;
    total += usd;
  }
  return { coins: raw.coins, coinsUsd, quote: raw.quote, totalEquityQuote: total };
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
  // Offset = Bybit server time − local clock. Cloudflare FREEZES Date.now() inside the
  // scheduled (cron) handler, so a signature built from Date.now() can land outside
  // Bybit's recv_window and be rejected — only in cron, which matched our symptom.
  // Signing against server time makes the timestamp correct in ANY execution context.
  private timeOffset: number | null = null;

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

  /** ALL spot tickers in ONE call — the cheap broad screen across hundreds of pairs. */
  async getAllTickers(): Promise<RawTicker[]> {
    const qs = new URLSearchParams({ category: this.category }).toString();
    const data = await this.publicGet<{ list: RawTicker[] }>("/v5/market/tickers", qs);
    return data.list ?? [];
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
      list: { totalEquity: string; coin: { coin: string; walletBalance: string; usdValue: string }[] }[];
    }>("/v5/account/wallet-balance", qs);
    const acct = data.list?.[0];
    const coins: Record<string, number> = {};
    const coinsUsd: Record<string, number> = {};
    for (const c of acct?.coin ?? []) {
      coins[c.coin] = Number(c.walletBalance);
      coinsUsd[c.coin] = Number(c.usdValue) || 0;
    }
    const quote = coins[this.quoteCoin] ?? 0;
    const totalEquityQuote = Number(acct?.totalEquity ?? "0") || quote;
    log.info("wallet", { quote, equity: totalEquityQuote, coins: Object.keys(coins).length });
    return { coins, coinsUsd, quote, totalEquityQuote };
  }

  /** Wallet valued at LIVE market prices (fixes Bybit demo's frozen usdValue). */
  async getPortfolio(): Promise<Wallet> {
    const [raw, tickers] = await Promise.all([this.getWalletBalance(), this.getAllTickers()]);
    return walletUsd(raw, usdPriceMap(tickers));
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
    return this.send<T>(path, () => fetch(url, { headers: { "Content-Type": "application/json" } }));
  }

  /** Sync to Bybit server time once per instance, so signing is clock-independent. */
  private async signTimestamp(): Promise<string> {
    if (this.timeOffset == null) {
      try {
        const serverMs = await this.getServerTime();
        this.timeOffset = serverMs - Date.now();
      } catch {
        this.timeOffset = 0; // fall back to local clock if /v5/market/time is unreachable
      }
    }
    return Math.round(Date.now() + this.timeOffset).toString();
  }

  private async signedGet<T>(path: string, qs: string): Promise<T> {
    return this.send<T>(path, async () => {
      const ts = await this.signTimestamp();
      const sign = await hmacSha256Hex(this.apiSecret, ts + this.apiKey + RECV_WINDOW + qs);
      return fetch(`${this.baseUrl}${path}?${qs}`, { headers: this.authHeaders(ts, sign) });
    });
  }

  private async signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.send<T>(path, async () => {
      const ts = await this.signTimestamp();
      const json = JSON.stringify(body);
      const sign = await hmacSha256Hex(this.apiSecret, ts + this.apiKey + RECV_WINDOW + json);
      return fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { ...this.authHeaders(ts, sign), "Content-Type": "application/json" }, body: json });
    });
  }

  private authHeaders(ts: string, sign: string): Record<string, string> {
    return { "X-BAPI-API-KEY": this.apiKey, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": RECV_WINDOW, "X-BAPI-SIGN": sign };
  }

  /**
   * Execute a request factory with ONE retry, parsing defensively. Bybit (esp. the demo
   * gateway under load) occasionally returns a non-JSON body — read text first and surface
   * a clear error with status + snippet instead of a cryptic "Unexpected token" crash.
   */
  private async send<T>(path: string, make: () => Promise<Response>): Promise<T> {
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await make();
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`non-JSON HTTP ${res.status}: ${text.slice(0, 100).replace(/\s+/g, " ").trim()}`);
        }
        const r = json as BybitResponse<T>;
        if (r.retCode !== 0) throw new Error(`retCode=${r.retCode} ${r.retMsg}`);
        return r.result;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`Bybit ${path}: ${lastErr}`);
  }
}
