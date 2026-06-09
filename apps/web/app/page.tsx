"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchBot,
  fetchStatus,
  fetchWallet,
  getAdminSecret,
  setAdminSecret,
  toggleBot,
  type BotInfo,
  type Status,
  type Wallet,
} from "@/lib/trader-api";

const POLL_MS = 15_000;

function fmt(n: number, d = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}d lalu`;
  if (s < 3600) return `${Math.round(s / 60)}m lalu`;
  if (s < 86400) return `${Math.round(s / 3600)}j lalu`;
  return `${Math.round(s / 86400)}h lalu`;
}

export default function Dashboard() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    try {
      const [w, b, s] = await Promise.all([fetchWallet().catch(() => null), fetchBot(), fetchStatus()]);
      if (w) setWallet(w);
      setBot(b);
      setStatus(s);
      setError(null);
    } catch {
      setError("Gagal memuat data dari API. Cek NEXT_PUBLIC_API_URL.");
    }
  }, []);

  useEffect(() => {
    setSecret(getAdminSecret());
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function onToggle() {
    if (!bot) return;
    if (!getAdminSecret()) {
      setError("Masukkan secret admin dulu untuk mengontrol bot.");
      return;
    }
    setBusy(true);
    const res = await toggleBot(!bot.enabled);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Gagal mengubah status bot.");
      return;
    }
    setError(null);
    await load();
  }

  const enabled = bot?.enabled ?? false;
  const halted = bot?.haltedDate != null;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="eyebrow">AI Crypto Agent</div>
          <h1 className="title-display">Trader Dashboard</h1>
        </div>
        <span className={`chip ${enabled ? "accent" : ""}`}>{enabled ? "🟢 BOT AKTIF" : "🔴 BOT MATI"}</span>
      </header>

      {error && <p className="alert">{error}</p>}

      {/* Wallet summary */}
      <section className="surface-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Ringkasan Wallet</h2>
          <span className="text-xs text-muted">demo · {wallet?.quoteCoin ?? "USDC"}</span>
        </div>
        {wallet ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total Ekuitas" value={`${fmt(wallet.totalEquityQuote)} ${wallet.quoteCoin}`} big />
            <Stat label={`Saldo ${wallet.quoteCoin}`} value={fmt(wallet.quote)} />
            <Stat
              label="PnL Hari Ini"
              value={`${(bot?.realizedPnlToday ?? 0) >= 0 ? "+" : ""}${fmt(bot?.realizedPnlToday ?? 0)}`}
              tone={(bot?.realizedPnlToday ?? 0) >= 0 ? "pos" : "neg"}
            />
            <Stat label="Aset" value={`${Object.values(wallet.coins).filter((v) => v > 0).length} koin`} />
          </div>
        ) : (
          <p className="text-sm text-muted">Memuat saldo…</p>
        )}
        {wallet && (
          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(wallet.coins)
              .filter(([, v]) => v > 0)
              .map(([coin, v]) => (
                <span key={coin} className="chip">
                  {coin}: {fmt(v, coin === wallet.quoteCoin ? 2 : 6)}
                </span>
              ))}
          </div>
        )}
      </section>

      {/* Bot control */}
      <section className="surface-card p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Kontrol Bot</h2>
            <p className="mt-1 text-sm text-muted">
              {enabled
                ? "Bot sedang memindai pasar tiap menit dan boleh membuka posisi."
                : "Bot dimatikan — tidak ada perdagangan sama sekali."}
              {halted && <span className="text-[color:var(--accent-2)]"> · kill-switch aktif hari ini</span>}
            </p>
            {bot && (
              <p className="mt-2 text-xs text-muted">
                Universe: {bot.config.universe.join(", ")} · risk {bot.config.riskPct}% · R:R≥{bot.config.minRR} · kill-switch {bot.config.killSwitchPct}% ·
                {bot.config.debateEnabled ? " debat ON" : " debat OFF"} ·{bot.config.executeTrades ? " LIVE" : " PAPER"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onToggle}
            disabled={busy || !bot}
            className={enabled ? "btn-secondary" : "btn-primary"}
            style={{ minWidth: 140 }}
          >
            {busy ? "…" : enabled ? "Matikan Bot" : "Nyalakan Bot"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onBlur={() => setAdminSecret(secret.trim())}
            placeholder="Secret admin (untuk kontrol)"
            className="input-field"
            style={{ maxWidth: 280 }}
          />
          <button type="button" className="btn-secondary" onClick={() => setAdminSecret(secret.trim())}>
            Simpan
          </button>
        </div>
      </section>

      {/* Open positions */}
      <section className="surface-card p-6">
        <h2 className="mb-3 text-lg font-semibold">Posisi Terbuka</h2>
        {status && status.openTrades.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2">Pasangan</th>
                  <th>Arah</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>Stop</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {status.openTrades.map((t) => (
                  <tr key={t.id} className="border-t border-[color:var(--border)]">
                    <td className="py-2 font-medium">{t.symbol}</td>
                    <td>{t.side}</td>
                    <td>{fmt(t.qty, 6)}</td>
                    <td>{fmt(t.price)}</td>
                    <td>{t.stopLoss ? fmt(t.stopLoss) : "—"}</td>
                    <td>{t.takeProfit ? fmt(t.takeProfit) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">Tidak ada posisi terbuka.</p>
        )}
      </section>

      {/* Recent decisions */}
      <section className="surface-card p-6">
        <h2 className="mb-3 text-lg font-semibold">Keputusan Terbaru</h2>
        {status && status.recentAnalyses.length > 0 ? (
          <ul className="space-y-2">
            {status.recentAnalyses.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 border-t border-[color:var(--border)] py-2 text-sm">
                <div>
                  <span className={`chip ${a.action === "BUY" ? "accent" : ""}`}>{a.action}</span>
                  <span className="ml-2 font-medium">{a.symbol}</span>
                  <span className="ml-2 text-muted">conf {a.confidence}</span>
                  {a.executed === 1 && <span className="ml-2 text-[color:var(--accent)]">✓ eksekusi</span>}
                  <p className="mt-1 text-xs text-muted">{a.reasoning?.slice(0, 140)}</p>
                </div>
                <div className="shrink-0 text-right text-xs text-muted">
                  {ago(a.ts)}
                  {a.outcomePnlPct != null && (
                    <div className={a.outcomeCorrect ? "text-[color:var(--accent)]" : "text-[color:var(--accent-2)]"}>
                      {a.outcomePnlPct >= 0 ? "+" : ""}
                      {fmt(a.outcomePnlPct)}%
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Belum ada keputusan.</p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, big, tone }: { label: string; value: string; big?: boolean; tone?: "pos" | "neg" }) {
  const color = tone === "pos" ? "var(--accent)" : tone === "neg" ? "var(--accent-2)" : "var(--foreground)";
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={big ? "text-2xl font-bold" : "text-lg font-semibold"} style={{ color }}>
        {value}
      </div>
    </div>
  );
}
