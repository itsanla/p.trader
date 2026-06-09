import type { Bybit } from "./bybit";
import type { TradingConfig } from "./config";
import { logger } from "./logger";

const log = logger("screener");

// The cheap broad screen: ONE /v5/market/tickers call covers EVERY spot pair (hundreds).
// We filter for liquidity + sanity, then rank cross-sectionally by 24h momentum and keep
// the top N. Deep kline analysis (time-series momentum) only happens on this shortlist —
// so we "scan hundreds" while staying far under the Worker subrequest budget.

export interface ScreenedCoin {
  symbol: string;
  price: number;
  spreadPct: number; // live bid/ask spread (real crossing cost)
  turnover: number; // 24h quote turnover (liquidity)
  chg24h: number; // 24h % change (momentum)
}

const LEVERAGED = /(\d+L|\d+S|UP|DOWN)$/; // BTC3L, ETH5S, FOOUP, FOODOWN …
const STABLES = new Set(["USDC", "DAI", "FDUSD", "TUSD", "EUR", "USDE", "BUSD", "USDD", "PYUSD"]);

/** Screen the whole spot market down to the top-N most liquid momentum leaders. */
export async function screenMarket(bybit: Bybit, cfg: TradingConfig): Promise<ScreenedCoin[]> {
  const tickers = await bybit.getAllTickers();
  const quote = cfg.quoteCoin;
  const coins: ScreenedCoin[] = [];
  let scanned = 0;

  for (const t of tickers) {
    if (!t.symbol.endsWith(quote)) continue;
    scanned++;
    const base = t.symbol.slice(0, -quote.length);
    if (LEVERAGED.test(base) || STABLES.has(base)) continue;

    const turnover = Number(t.turnover24h) || 0;
    if (turnover < cfg.minTurnover) continue; // liquidity gate

    const chg24h = (Number(t.price24hPcnt) || 0) * 100;
    if (Math.abs(chg24h) > cfg.maxChg24h) continue; // exclude rug/halt/listing anomalies

    const last = Number(t.lastPrice) || 0;
    if (last <= 0) continue;
    const bid = Number(t.bid1Price) || 0;
    const ask = Number(t.ask1Price) || 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    const spreadPct = mid > 0 && ask > bid ? ((ask - bid) / mid) * 100 : 0;
    if (spreadPct > cfg.maxSpreadPct) continue; // skip illiquid wide-spread books

    coins.push({ symbol: t.symbol, price: last, spreadPct, turnover, chg24h });
  }

  // Cross-sectional momentum: strongest 24h movers first.
  coins.sort((a, b) => b.chg24h - a.chg24h);
  const top = coins.slice(0, cfg.screenTopN);
  log.info("screen", { scanned, eligible: coins.length, top: top.length, lead: top[0]?.symbol, leadChg: top[0]?.chg24h?.toFixed(1) });
  return top;
}
