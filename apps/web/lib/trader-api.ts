// Client for the trader Worker. Read endpoints (/wallet, /status, /bot) are open;
// toggling the bot (POST /bot) needs the admin secret, sent as x-admin-secret and
// kept in localStorage.

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8787";
const SECRET_KEY = "trader_admin_secret";

export function getAdminSecret(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(SECRET_KEY) ?? "";
}
export function setAdminSecret(s: string): void {
  window.localStorage.setItem(SECRET_KEY, s);
}

export interface Wallet {
  quoteCoin: string;
  coins: Record<string, number>;
  quote: number;
  totalEquityQuote: number;
}

export interface BotInfo {
  enabled: boolean;
  haltedDate: string | null;
  realizedPnlToday: number;
  config: { universe: string[]; executeTrades: boolean; riskPct: number; minRR: number; killSwitchPct: number; debateEnabled: boolean };
}

export interface OpenTrade {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  createdAt: number;
}

export interface Analysis {
  id: string;
  symbol: string;
  ts: number;
  price: number;
  trigger: string;
  action: string;
  confidence: number;
  reasoning: string;
  executed: number;
  outcomePnlPct: number | null;
  outcomeCorrect: number | null;
}

export interface Status {
  enabled: boolean;
  haltedDate: string | null;
  universe: string[];
  openTrades: OpenTrade[];
  recentAnalyses: Analysis[];
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

export interface EquityData {
  current: { totalUsd: number; coins: { coin: string; usd: number; balance: number }[] } | null;
  history: EquityPoint[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const fetchWallet = () => get<Wallet>("/wallet");
export const fetchBot = () => get<BotInfo>("/bot");
export const fetchStatus = () => get<Status>("/status");
export const fetchEquity = () => get<EquityData>("/equity");

export async function toggleBot(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/bot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-secret": getAdminSecret() },
    body: JSON.stringify({ enabled }),
  });
  if (res.status === 403) return { ok: false, error: "Secret admin salah." };
  if (!res.ok) return { ok: false, error: `Gagal (${res.status})` };
  return { ok: true };
}

export interface WithdrawResult {
  ok: boolean;
  error?: string;
  note?: string;
  sold?: { symbol: string; qty: number; ok: boolean; error?: string }[];
}

export async function withdrawAll(): Promise<WithdrawResult> {
  const res = await fetch(`${API_BASE}/withdraw`, { method: "POST", headers: { "x-admin-secret": getAdminSecret() } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (body as { error?: string }).error ?? `Gagal (${res.status})` };
  return { ok: true, ...(body as object) };
}

// ── AI / Groq usage ───────────────────────────────────────────────────────────

export interface KeyUsage {
  index: number;
  maskedKey: string;
  restricted: boolean;
  isLimited: boolean;
  totalTokens: number;
  totalRequests: number;
  combinedTokenLimit: number;
  lastUsed: string | null;
}

export interface UsageData {
  keys: KeyUsage[];
  combined: { totalKeys: number; combinedDailyTokenLimit: number; totalTokensToday: number; totalRequestsToday: number };
}

export interface ModelUsage {
  model: string;
  name: string;
  totalTokens: number;
  totalRequests: number;
  tokenLimit: number;
  requestLimit: number;
}

export const fetchUsage = () => get<UsageData>("/usage");
export const fetchKeyDetail = (index: number) => get<{ keyIndex: number; models: ModelUsage[] }>(`/usage/${index}`);
