"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchKeyDetail, fetchUsage, type ModelUsage, type UsageData } from "@/lib/trader-api";

function num(n: number): string {
  return n.toLocaleString("en-US");
}
function pct(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
}

function Bar({ used, limit }: { used: number; limit: number }) {
  const p = pct(used, limit);
  const color = p > 85 ? "var(--accent-2)" : p > 60 ? "#caa23a" : "var(--accent)";
  return (
    <div style={{ height: 8, borderRadius: 6, background: "var(--surface-3)", overflow: "hidden" }}>
      <div style={{ width: `${p}%`, height: "100%", background: color }} />
    </div>
  );
}

export default function UsagePage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [details, setDetails] = useState<Record<number, ModelUsage[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const u = await fetchUsage();
      setUsage(u);
      const entries = await Promise.all(u.keys.map(async (k) => [k.index, (await fetchKeyDetail(k.index)).models] as const));
      setDetails(Object.fromEntries(entries));
      setError(null);
    } catch {
      setError("Gagal memuat data penggunaan.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <div className="eyebrow">Penggunaan AI</div>
          <h1 className="title-display">Token & Eksekusi AI</h1>
        </div>
        <Link href="/" className="btn-secondary" style={{ textDecoration: "none" }}>
          ← Kembali
        </Link>
      </header>

      {error && <p className="alert">{error}</p>}

      {usage && (
        <section className="surface-card p-5">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">API Key (org)</div>
              <div className="text-2xl font-bold">{usage.combined.totalKeys}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Eksekusi AI Hari Ini</div>
              <div className="text-2xl font-bold">{num(usage.combined.totalRequestsToday)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Token Dipakai Hari Ini</div>
              <div className="text-2xl font-bold">{num(usage.combined.totalTokensToday)}</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            Tiap API key = organisasi Groq terpisah, jadi kuota harian dijumlahkan. Batas total token/hari (gabungan semua model):{" "}
            <b>{num(usage.combined.combinedDailyTokenLimit)}</b>.
          </p>
        </section>
      )}

      {usage?.keys.map((k) => (
        <section key={k.index} className="surface-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold">
              API Key #{k.index} <span className="text-muted">{k.maskedKey}</span>
            </h2>
            <span className={`chip ${k.restricted || k.isLimited ? "" : "accent"}`}>{k.restricted ? "🚫 dibatasi" : k.isLimited ? "⏳ rate-limit" : "🟢 aktif"}</span>
          </div>
          <div className="mb-1 flex justify-between text-sm">
            <span className="text-muted">
              {num(k.totalRequests)} eksekusi · {num(k.totalTokens)} token
            </span>
            <span className="text-muted">limit {num(k.combinedTokenLimit)} token/hari</span>
          </div>
          <Bar used={k.totalTokens} limit={k.combinedTokenLimit} />

          <div className="mt-4 space-y-3">
            {(details[k.index] ?? [])
              .filter((m) => m.totalRequests > 0 || m.totalTokens > 0)
              .map((m) => (
                <div key={m.model}>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted">
                      {num(m.totalTokens)}/{num(m.tokenLimit)} token · {num(m.totalRequests)}/{num(m.requestLimit)} req
                    </span>
                  </div>
                  <div className="mt-1">
                    <Bar used={m.totalTokens} limit={m.tokenLimit} />
                  </div>
                </div>
              ))}
            {(details[k.index] ?? []).every((m) => m.totalRequests === 0) && <p className="text-xs text-muted">Belum ada pemakaian model hari ini.</p>}
          </div>
        </section>
      ))}

      {usage && usage.keys.length === 0 && <p className="text-sm text-muted">Belum ada data penggunaan.</p>}
    </div>
  );
}
