# p.trader — Ringkasan Strategi & Sistem

Bot trading kripto otomatis di Cloudflare Workers. Dokumen ini merangkum **strategi & arsitektur yang sedang berjalan** (per Juni 2026). Untuk panduan pengembangan teknis, lihat `CLAUDE.md`.

> Status: berjalan di **akun DEMO Bybit** (`api-demo.bybit.com`). Uang simulasi. Strategi belum tervalidasi statistik — perlu observasi mingguan + backtest sebelum dianggap profitabel.

---

## 1. Tujuan & filosofi

**Mesin momentum yang PROAKTIF** — modal selalu bekerja di koin-koin terkuat, bukan menganggur. Pendekatan: **cross-sectional + time-series momentum rotation** (long koin terkuat, rotasi saat ranking berubah). Berbasis riset trader profesional (momentum + risk management > tuning sinyal).

Keterbatasan jujur: **spot long-only** → hanya profit dari gerakan NAIK. Bagus di pasar hijau/ada-mover, lemah di pasar turun berkepanjangan (tak bisa short).

---

## 2. Arsitektur

```
Cloudflare cron (* * * * *)  ──poke──▶  Durable Object "TraderTicker" (locationHint: APAC)
(keepalive, tak sentuh Bybit)            └─ alarm() tiap 60 dtk, self-reschedule + self-heal
                                            └─ runCycle()  ← egress dari APAC = LOLOS geo-block Bybit
                                            └─ evaluateOutcomes() (tiap ~10 mnt)
```

- **Worker (Hono)**: HTTP API + scheduled handler (keepalive).
- **Durable Object `TraderTicker`** (`src/ticker.ts`): penggerak otonom. Di-pin ke **APAC** karena Bybit (CloudFront) **memblokir region cron Cloudflare biasa (geo-block 403)**. DO di APAC egress-nya tidak diblokir. Alarm menjadwalkan-ulang dirinya (survive deploy via self-heal `ensureRunning`).
- **D1** (Drizzle): sumber kebenaran — analyses, trades, market_memory, equity_snapshots, bot_settings, usage_counters.
- **Vectorize** (`linda-memory`, namespace per-symbol, embed `@cf/baai/bge-m3`): memori "market fingerprint" + outcome (pembelajaran).
- **Upstash Redis** (shared p.agent, key prefix `trader:`): cooldown per-koin, cron idempotency. (Groq key-state TIDAK dibaca dari Redis lagi — hemat subrequest.)
- **Frontend** (`apps/web`, Next.js static export): dashboard di `trader.anla.my.id`.
- **Logs**: dikirim ke `logs.anla.my.id` (query: `/api/:service` mis. `/api/trader`, `/api/ticker`, `/api/bybit`, `/api/screener`).

---

## 3. Alur satu siklus (`runCycle`, tiap 60 dtk)

1. **Cek bot on/off** (D1 `bot_settings`). Off → berhenti total.
2. **Wallet + ekuitas LIVE**: ambil saldo + SEMUA ticker (1 call), hitung nilai USD dari **harga live** (demo Bybit melaporkan `usdValue` BEKU → kita hitung sendiri: saldo × harga live; stablecoin = $1).
3. **Snapshot kekayaan** (USD) tiap ~10 menit → grafik.
4. **Kill-switch harian**: jika rugi realisasi hari ini > `KILL_SWITCH_PCT` ekuitas → halt sampai besok.
5. **SCREENER** (1 call `tickers`): pindai **SEMUA pair USDT (ratusan)** → filter likuiditas (`MIN_TURNOVER`), buang leveraged token/stablecoin/anomali (`MAX_CHG24H`), buang spread lebar (`MAX_SPREAD_PCT`) → rank by momentum 24j → ambil top `SCREEN_TOP_N`.
6. **Deep-scan** top-N (kline 1H/4H/1D → indikator) + koin yang dipegang.
7. **EXIT pass** (rule-based, tanpa LLM): jual jika stop kena / take-profit / RSI>78 / regime trend_down / tembus EMA50. PnL bersih biaya.
8. **ENTRY pass**: bila ada slot kosong (`MAX_OPEN_POSITIONS`):
   - Shortlist = momentum leaders yang `isLongEligible` (bukan trend_down, RSI<85) & tidak cooldown.
   - **AI memilih** (`runSelection`): LLM diberi tabel kandidat → pilih BUY terbaik (proaktif: deploy kas, HOLD hanya jika semua jelas buruk). Gagal-schema → HOLD (tak crash).
   - **Risk-gate + sizing** → eksekusi market BUY.
   - Set cooldown koin (`COOLDOWN_MINUTES`).

---

## 4. Risk layer (inti pencegah ruin)

- **Sizing ALLOCATION-FIRST**: deploy `MAX_POSITION_PCT` ekuitas per posisi, lalu di-clamp oleh:
  - **Plafon risiko**: kerugian jika stop kena ≤ `MAX_RISK_PCT` ekuitas (otomatis perkecil posisi untuk koin volatil/stop lebar).
  - **Portfolio heat**: total risiko semua posisi ≤ `PORTFOLIO_HEAT_PCT`.
  - **Cash reserve**: jangan belanjakan `CASH_RESERVE_PCT` terakhir (cegah "insufficient balance" akibat gerakan harga antara hitung & fill).
- **Stop-loss**: ATR-based (`ATR_STOP_MULT × ATR`) atau dari AI. **"Soft stop"** — dijaga bot (jual market saat harga ≤ stop tiap menit), BUKAN order native (Bybit spot market TIDAK dukung TP/SL native — hanya limit order).
- **R:R bersih biaya** ≥ `MIN_RR` (longgar untuk momentum; exit dinamis).
- **Biaya diperhitungкан**: fee 0.1%/sisi (terverifikasi dok Bybit) + spread **diukur live** dari bid/ask → masuk R:R, PnL, outcome.
- **Cooldown** per koin: jangan ulang koin sama dalam `COOLDOWN_MINUTES`.
- **Kill-switch harian** + tombol **on/off** (kill-switch manual penuh).

---

## 5. Konfigurasi saat ini (wrangler vars)

| Var | Nilai | Arti |
|---|---|---|
| `QUOTE_COIN` | USDT | mata uang dasar (saldo demo 50k USDT) |
| `MIN_TURNOVER` | 10000000 | gerbang likuiditas screener ($10M/24j) |
| `MAX_CHG24H` | 35 | buang koin gerak >35%/24j (anomali/rug) |
| `MAX_SPREAD_PCT` | 0.3 | buang spread lebih lebar dari ini |
| `SCREEN_TOP_N` | 8 | momentum leader yang di-deep-scan (dibatasi subrequest!) |
| `MAX_OPEN_POSITIONS` | 4 | posisi konkuren |
| `MAX_POSITION_PCT` | 18 | target % ekuitas per posisi |
| `MAX_RISK_PCT` | 2 | plafon rugi per trade jika stop kena |
| `PORTFOLIO_HEAT_PCT` | 10 | total risiko terbuka maks |
| `CASH_RESERVE_PCT` | 5 | sisakan kas (cegah insufficient balance) |
| `MIN_RR` | 1.3 | reward:risk bersih minimum |
| `ATR_STOP_MULT` | 2 | jarak stop = 2× ATR |
| `FEE_PCT` / `SLIPPAGE_PCT` | 0.1 / 0.05 | biaya (spread asli diukur live) |
| `KILL_SWITCH_PCT` | 5 | halt jika rugi harian > 5% |
| `MIN_CONFIDENCE` | 55 | minimum keyakinan AI untuk eksekusi |
| `DEBATE_ENABLED` | true | debat multi-agen (saat ini jalur seleksi pakai single-call) |
| `GROQ_CHAT_MODEL` | openai/gpt-oss-120b | model keputusan |
| Groq keys | **15** (org terpisah) | kuota token sangat lega; rotasi failover |

---

## 6. Fitur lain

- **Equity tracking**: nilai portfolio USD (live), snapshot ~10 mnt → grafik per jam di dashboard.
- **Tombol Withdraw**: `POST /withdraw` (hanya saat bot OFF) → jual SEMUA koin ke USDT. Nyalakan bot lagi → dagang dari awal.
- **Halaman Penggunaan AI** (`/usage`): eksekusi + token per Groq key vs limit `model.json`.
- **Learning loop**: `evaluateOutcomes` menilai keputusan setelah 12 jam → simpan hasil ke Vectorize (namespace per-symbol) untuk recall situasi serupa.
- **Endpoints**: `/wallet`, `/equity`, `/bot` (GET/POST), `/status`, `/usage`, `/usage/:key`, `/withdraw`, `/run`, `/evaluate`, `/diag`, `/tick/start|stop|status`.

---

## 7. Kendala & catatan jujur

- **Subrequest limit Cloudflare (50 free)** = bottleneck utama. Dengan 8 koin × 3 kline = batas aman. Untuk scan 15-20 koin / debat → butuh **Workers Paid ($5/bln, 1000 subrequest)**.
- **Spot long-only** → tak bisa profit di pasar turun. Futures + short = langkah berikutnya untuk profit dua arah.
- **Stop "soft"** (bot-enforced) — bukan native exchange stop; bergantung bot hidup & cek tiap menit.
- **Demo ≠ nyata**: fill & slippage akun asli berbeda. Strategi BELUM terbukti — validasi di demo dulu.
- **Modal kecil ($10-20)**: minimum order Bybit ~$1-5 → hanya muat 1 posisi (mode konsentrasi). Untuk belajar, bukan income.

---

## 8. Roadmap

1. **Workers Paid** → universe 15-20 koin + debat multi-agen aktif.
2. **Futures/perps + short** → profit di pasar turun.
3. **Native limit TP/SL** (order limit) untuk stop sisi-exchange yang lebih kokoh.
4. **Preset "mode modal kecil"** (1 posisi, alokasi tinggi) untuk akun asli $10-20.
5. **Backtest + A/B** (single vs debat) memakai tabel `analyses.outcome`.
6. **Kartu "Kinerja Bot saja"** (P&L hanya dari koin yang dibeli bot, pisah dari saldo bawaan).
