"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchBot,
  fetchEquity,
  fetchStatus,
  getAdminSecret,
  setAdminSecret,
  toggleBot,
  type BotInfo,
  type EquityData,
  type EquityPoint,
  type Status,
} from "@/lib/trader-api";

const POLL_MS = 20_000;

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n: number): string {
  return (n >= 0 ? "+" : "−") + usd(Math.abs(n)).slice(1);
}
function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

export default function Dashboard() {
  const [eq, setEq] = useState<EquityData | null>(null);
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    try {
      const [e, b, s] = await Promise.all([fetchEquity(), fetchBot(), fetchStatus()]);
      setEq(e);
      setBot(b);
      setStatus(s);
      setError(null);
    } catch {
      setError("Gagal memuat data. Cek NEXT_PUBLIC_API_URL.");
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
    if (!res.ok) return setError(res.error ?? "Gagal mengubah bot.");
    setError(null);
    await load();
  }

  const enabled = bot?.enabled ?? false;
  const history = eq?.history ?? [];
  const latest = eq?.current?.totalUsd ?? history[history.length - 1]?.equityUsd ?? 0;

  // Untung/rugi = perubahan TOTAL KEKAYAAN (termasuk koin yang sedang dipegang).
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const todayBase = history.find((p) => p.ts >= startToday.getTime())?.equityUsd ?? history[0]?.equityUsd ?? latest;
  const totalBase = history[0]?.equityUsd ?? latest;
  const todayChange = latest - todayBase;
  const totalChange = latest - totalBase;
  const pct = (chg: number, base: number) => (base > 0 ? (chg / base) * 100 : 0);

  return (
    <div className="space-y-5">
      {/* Hero: total wealth + bot switch */}
      <section className="surface-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm text-muted">Total Kekayaan (semua koin)</div>
            <div className="text-4xl font-bold tracking-tight" style={{ marginTop: 4 }}>
              {eq ? usd(latest) : "…"}
            </div>
            <div className="mt-1 text-xs text-muted">dalam USD — nilai stabil (sengaja tidak dikonversi ke Rupiah agar tidak menyesatkan)</div>
          </div>
          <button type="button" onClick={onToggle} disabled={busy || !bot} className={enabled ? "btn-secondary" : "btn-primary"} style={{ minWidth: 130 }}>
            {busy ? "…" : enabled ? "■ Matikan Bot" : "▶ Nyalakan Bot"}
          </button>
        </div>
        <div className="mt-2">
          <span className={`chip ${enabled ? "accent" : ""}`}>{enabled ? "🟢 Bot menyala — sedang berdagang" : "🔴 Bot mati — tidak berdagang"}</span>
          {bot?.haltedDate && <span className="ml-2 text-xs" style={{ color: "var(--accent-2)" }}>kill-switch aktif hari ini</span>}
        </div>
      </section>

      {error && <p className="alert">{error}</p>}

      {/* Untung / Rugi */}
      <div className="grid grid-cols-2 gap-4">
        <PnL label="Untung / Rugi — Hari Ini" change={todayChange} pct={pct(todayChange, todayBase)} ready={history.length > 0} />
        <PnL label="Untung / Rugi — Total" change={totalChange} pct={pct(totalChange, totalBase)} ready={history.length > 1} />
      </div>

      {/* Chart */}
      <section className="surface-card p-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">📈 Perubahan Kekayaan (per jam)</h2>
          <span className="text-xs text-muted">{history.length} titik tercatat</span>
        </div>
        <EquityChart points={history} />
      </section>

      {/* Rincian koin */}
      <section className="surface-card p-6">
        <h2 className="mb-3 text-base font-semibold">Rincian Koin (nilai USD)</h2>
        {eq?.current ? (
          <div className="space-y-2">
            {eq.current.coins.map((c) => (
              <div key={c.coin} className="flex items-center justify-between border-b border-[color:var(--border)] pb-2 text-sm">
                <div>
                  <span className="font-medium">{c.coin}</span>
                  <span className="ml-2 text-muted">{c.balance.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
                </div>
                <div className="font-semibold">{usd(c.usd)}</div>
              </div>
            ))}
            {eq.current.coins.length === 0 && <p className="text-sm text-muted">Belum ada koin.</p>}
          </div>
        ) : (
          <p className="text-sm text-muted">Memuat saldo…</p>
        )}
      </section>

      {/* Aktivitas (bahasa sederhana) */}
      <section className="surface-card p-6">
        <h2 className="mb-3 text-base font-semibold">Aktivitas Bot</h2>
        {status && status.openTrades.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-muted">Sedang dipegang</div>
            {status.openTrades.map((t) => (
              <div key={t.id} className="text-sm">
                🟢 <span className="font-medium">{t.symbol.replace(/USDT$|USDC$/, "")}</span> — beli {t.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} di {usd(t.price)}
              </div>
            ))}
          </div>
        )}
        <div className="mb-1 text-xs uppercase tracking-wide text-muted">Keputusan terbaru</div>
        {status && status.recentAnalyses.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {status.recentAnalyses.slice(0, 8).map((a) => {
              const name = a.symbol.replace(/USDT$|USDC$/, "");
              const label = a.action === "BUY" ? `🟢 Beli ${name}` : a.action === "SELL" ? `🔴 Jual ${name}` : `⚪ Tahan (belum ada peluang bagus)`;
              return (
                <li key={a.id} className="flex items-center justify-between">
                  <span>
                    {label}
                    {a.action !== "HOLD" && a.executed === 1 && <span className="ml-1 text-[color:var(--accent)]">✓</span>}
                    {a.outcomePnlPct != null && (
                      <span className={a.outcomePnlPct >= 0 ? "ml-2" : "ml-2"} style={{ color: a.outcomePnlPct >= 0 ? "var(--accent)" : "var(--accent-2)" }}>
                        ({a.outcomePnlPct >= 0 ? "untung" : "rugi"} {Math.abs(a.outcomePnlPct).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted">{ago(a.ts)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">Belum ada aktivitas.</p>
        )}
      </section>

      {/* Kontrol secret */}
      <section className="surface-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Secret admin (untuk nyala/matikan bot):</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} onBlur={() => setAdminSecret(secret.trim())} placeholder="secret" className="input-field" style={{ maxWidth: 220 }} />
          <button type="button" className="btn-secondary" onClick={() => setAdminSecret(secret.trim())}>
            Simpan
          </button>
        </div>
      </section>
    </div>
  );
}

function PnL({ label, change, pct, ready }: { label: string; change: number; pct: number; ready: boolean }) {
  const pos = change >= 0;
  const color = pos ? "var(--accent)" : "var(--accent-2)";
  return (
    <div className="surface-card p-5">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      {ready ? (
        <>
          <div className="text-2xl font-bold" style={{ color, marginTop: 4 }}>
            {signed(change)}
          </div>
          <div className="text-sm" style={{ color }}>
            {pos ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
          </div>
        </>
      ) : (
        <div className="mt-2 text-sm text-muted">Mengumpulkan data…</div>
      )}
    </div>
  );
}

function EquityChart({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) {
    return <p className="py-8 text-center text-sm text-muted">Grafik muncul setelah beberapa jam data terkumpul (snapshot diambil tiap jam).</p>;
  }
  const w = 720;
  const h = 200;
  const pad = 10;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.equityUsd);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const X = (t: number) => pad + ((t - minX) / (maxX - minX || 1)) * (w - 2 * pad);
  const Y = (v: number) => pad + (1 - (v - minY) / (maxY - minY || 1)) * (h - 2 * pad);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.ts).toFixed(1)},${Y(p.equityUsd).toFixed(1)}`).join(" ");
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? "var(--accent)" : "var(--accent-2)";
  const area = `${line} L${X(maxX).toFixed(1)},${(h - pad).toFixed(1)} L${X(minX).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height: 200 }}>
        <path d={area} fill={color} opacity={0.12} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{new Date(minX).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        <span>{new Date(maxX).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}
