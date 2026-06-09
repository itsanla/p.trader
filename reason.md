# Alasan: Mengapa Membangun Bot AI Trading (p.trader) Tidak Worth It sebagai Sumber Passive Income Utama untuk Modal 13 Juta Rupiah

**Tanggal analisis:** Juni 2026 (berdasarkan live demo saat ini + deep research)

**Kesimpulan utama:**  
Tidak worth it untuk mengalokasikan waktu besar membangun dan memelihara bot ini **sebagai mesin utama** passive income yang stabil. Bot ini adalah project engineering yang sangat baik, tapi secara fundamental tidak cocok untuk tujuan tersebut dengan modal kecil.

---

## 1. Setup Bot Saat Ini (dari live demo & code)
- Strategi: **Proactive cross-sectional momentum rotation** (long-only spot di Bybit).
- Mekanisme: Screener ambil top momentum 24h (likuiditas + chg kuat) → AI (Groq) pilih 1 terbaik dari shortlist → deploy modal agresif ke koin terkuat.
- Risk layer: Sudah sangat baik (ATR stop, portfolio heat, R:R net biaya real-time, daily kill-switch, cooldown, sizing allocation-first, cash reserve).
- Kondisi live demo (saat analisis):
  - Total equity ~$159k (demo).
  - PnL hari ini & total: **-3.43%** (-$5,672).
  - Posisi terkonsentrasi: TON ($55k), ADA ($30k), NEAR ($30k), LIT ($28k), WLD ($16k) — hampir tidak ada USDT.
  - Aktivitas terbaru: Beli berulang NEAR, TON, ADA, WLD (tepat sesuai "always deploy capital" philosophy).

Ini adalah eksekusi sempurna dari strategi yang sudah dibangun, bukan kegagalan coding.

## 2. Alasan Teknis Mengapa Sulit Memberi Profit Stabil
- **Long-only spot pada altcoin volatil**  
  Hanya bisa profit saat harga naik. Sangat lemah di tren turun berkepanjangan atau choppy sideways (crypto sangat sering mengalami ini). Sudah diakui di `summary.md` project sendiri.

- **Momentum rotation + "proactive deploy"**  
  Membeli koin yang baru saja naik kuat (TON, ADA, NEAR, WLD, LIT). Ini klasik **momentum crash risk**. Saat tren berbalik, semua posisi besar bisa rugi bareng (correlated drawdown).

- **Biaya & friction memakan edge**  
  Meskipun code sudah menghitung fee 0.1% + live spread + slippage dengan sangat baik, di pasar altcoin yang volatile, edge kecil tetap mudah hilang karena turnover tinggi.

- **Modal kecil memperburuk masalah**  
  Dengan 13 juta (~$800), diversifikasi terbatas. Min order + heat cap + max position membuat posisi jadi oversized relatif terhadap modal. Demo dengan saldo besar menyembunyikan masalah ini.

- **AI layer membantu, tapi bukan magic**  
  LLM bagus untuk ranking relatif dari kandidat, tapi tetap mengikuti sinyal momentum yang inherently noisy dan regime-dependent.

## 3. Bukti dari Internet & Riset (Deep Search)
- **Crypto momentum sangat crash-prone** (studi akademik):
  - Grobys et al. (2025): Crypto momentum mengalami crash ekstrem, contoh -255% dalam satu minggu (Des 2020). Bahkan long-only version menderita drawdown parah.
  - Momentum hanya kuat di regime "UP–UP" berkelanjutan. Lemah/negatif di DOWN, choppy, atau transisi.

- **Retail trader & bot statistik**:
  - 80–95%+ retail crypto trader rugi jangka panjang.
  - Bahkan systematic/automated bots jarang menghasilkan "stable profit" (konsisten, drawdown rendah, predictable setiap bulan).
  - Klaim tinggi dari vendor (Bybit grid bot APR 50–200%+) hampir selalu backtest atau cherry-picked di kondisi ranging. Real user result sering mengalami drawdown seperti yang bot kamu alami sekarang.

- **Perbandingan strategi**:
  - Grid/DCA lebih "stabil" di market ranging.
  - Pure momentum rotation (seperti bot ini) bagus di bull altseason, tapi brutal di reversal.
  - Bahkan trend-following crypto yang lebih canggih (paper Concretum Group) masih butuh vol scaling ketat dan tidak menjanjikan stabilitas.

Kesimpulan riset: Setup sebaik dan serapi apapun (seperti milikmu), **sulit** menghasilkan passive income yang stabil di crypto dengan modal kecil.

## 4. Opportunity Cost Waktu Sangat Tinggi
- Membangun, debug, maintain, backtest, monitor, adjust parameter, handle perubahan API Bybit, dll. butuh waktu terus-menerus.
- Hasil yang realistis (bahkan kalau suatu hari mencapai 15–20% per tahun bersih — sudah sangat optimis): hanya ~Rp 1.5–2 juta per tahun dari 13 juta, atau ~Rp 125–170 ribu per bulan.
- Itu **sebelum** periode rugi besar, sebelum pajak, dan setelah menghabiskan ratusan jam.
- Waktu tersebut bisa dipakai untuk:
  - Meningkatkan skill (project bot ini justru bukti bagus).
  - Side hustle yang scalable.
  - Riset & eksekusi investasi yang benar-benar low-effort.

## 5. Alternatif yang Lebih Masuk Akal untuk 13 Juta Rupiah
Tujuan: **memutar uang agar tidak diam + risiko terkontrol + effort rendah**.

**Pilihan utama (paling direkomendasikan untuk modal utama):**
- **SBN Ritel (ORI / SR / ST)**: Min Rp1 juta. Imbal hasil 5.3–6.75%+ (tergantung seri), dibayar **setiap bulan**, dijamin negara 100% (UU). Bisa dibeli via Bibit. Pajak lebih rendah daripada deposito. Ini adalah "passive income" paling murni yang tersedia untuk ritel.
- **Reksa Dana Pasar Uang + Obligasi** (Bibit / Ajaib / Makmur): Saat ini ~5–6.1% untuk RDPU, historis 5–8% untuk obligasi index. Bisa auto-invest rutin. Sangat rendah maintenance.

**Estimasi hasil (13 juta, sebelum pajak/biaya):**
- 5–6% (aman, SBN/RDPU bagus) → ± Rp 55–65 ribu/bulan rata-rata.
- 7–9% (balanced) → ± Rp 75–100 ribu/bulan rata-rata (dengan compounding + tambah modal rutin akan terasa lebih cepat).

Ini jauh lebih stabil daripada bot yang bisa -3.4% dalam sehari dan berpotensi lebih dalam.

**Porsi kecil untuk eksperimen (opsional):**
- Alokasikan maksimal 10–20% (Rp 1–3 juta) ke bot (atau instrumen berisiko tinggi lain). Anggap sebagai "tuition fee" belajar + upside potensial.

## 6. Rekomendasi Akhir
- **Jangan matikan total project bot**. Ini adalah achievement engineering yang bagus. Jadikan sebagai:
  - Learning project / portfolio untuk skill development.
  - High-risk experiment bucket dengan alokasi sangat kecil.
  - Atau pivot menjadi signal generator (bukan full auto-execute).

- **Pindahkan modal utama** ke instrumen regulated yang benar-benar low-effort (SBN + reksa dana via platform bagus seperti Bibit).

- **Fokus energi ke hal yang leverage lebih tinggi**:
  - Tingkatkan kemampuan menghasilkan uang (side income).
  - Tambah modal secara rutin (compounding + capital addition jauh lebih powerful daripada chasing high return dari modal kecil).
  - Manfaatkan skill yang sudah dibangun (coding + AI + sistem) untuk hal yang lebih scalable daripada trading sendiri.

**Inti pesan:**  
Bot trading AI yang canggih seperti ini **bisa** memiliki positive expectancy di regime tertentu, tapi **sangat jarang** menjadi sumber passive income yang stabil dan predictable — terutama dengan modal kecil di pasar crypto. Waktu dan energi kamu lebih berharga dialokasikan ke cara yang sesuai dengan ukuran modal dan tujuan sebenarnya.

---

## 7. Bukti Tambahan dari Jurnal Akademik (Hanya Sumber dengan DOI)

Berikut adalah alasan tambahan yang diambil **hanya dari jurnal peer-reviewed** dengan kode DOI yang dapat diverifikasi. Alasan-alasan ini secara langsung mendukung mengapa pendekatan algorithmic/AI trading dan momentum rotation (seperti yang diimplementasikan di p.trader) sulit atau tidak cocok untuk menghasilkan **passive income yang stabil**, khususnya bagi retail investor di pasar kripto:

### 7.1 Severe Crashes dan Ketidakstabilan Return pada Strategi Momentum Kripto
- **Referensi**: Grobys, K., Kolari, J.W., Sandretto, D. et al. (2025). Cryptocurrency momentum has (not) its moments. *Financial Markets and Portfolio Management*, 39, 443–476. https://doi.org/10.1007/s11408-025-00474-9
- **Alasan kunci**: Strategi momentum kripto (termasuk long-only) mengalami *crash ekstrem* yang dapat mencapai −255% dalam satu minggu karena pergerakan harga idiosinkratik pada satu atau beberapa aset. Crash ini membuat payoff strategi menjadi tidak signifikan atau negatif di banyak sub-periode. Berbeda dengan momentum ekuitas, crash di kripto sering tidak terkait dengan reversal pasar secara keseluruhan tetapi dengan lonjakan harga ekstrem pada aset individual. Bahkan setelah penerapan risk management (volatility scaling), distribusi return masih memiliki ekor tebal (power-law tails) sehingga variance secara teoritis tidak terdefinisi. Hal ini menyebabkan ketidakpastian ekstrem yang tidak sesuai dengan kebutuhan passive income yang stabil dan predictable.

### 7.2 Perilaku Retail yang Memperburuk Risiko Momentum di Kripto
- **Referensi**: Kogan, S. et al. (2024). Are cryptos different? Evidence from retail trading. *Journal of Financial Economics*. https://doi.org/10.1016/j.jfineco.2024.103897
- **Alasan kunci**: Data dari platform retail (eToro) menunjukkan bahwa investor ritel berperilaku *contrarian* pada aset tradisional (saham dan emas), tetapi beralih ke strategi *momentum-like* ketika trading kripto. Mereka cenderung menafsirkan kenaikan harga kripto sebagai sinyal adopsi massal di masa depan, sehingga terus mengejar (positive feedback). Perilaku ini memperbesar eksposur terhadap reversal dan tren yang tidak persisten. Karena pasar kripto didominasi oleh retail speculative trading, dinamika momentum yang dikejar oleh non-profesional investor cenderung menghasilkan outcome jangka panjang yang buruk, bukan return stabil.

### 7.3 Algorithmic Trading Dapat Memperbesar Ketidakstabilan dan Merugikan Trader Tertentu
- **Referensi**: Zhang, L. et al. (2024). Mispricing and Algorithm Trading. *Information Systems Research*. https://doi.org/10.1287/isre.2021.0570
- **Alasan kunci**: Ketika algorithmic trading dikombinasikan dengan mispricing awal, ia dapat memperbesar deviasi harga, menghasilkan volatilitas tinggi, gelembung, dan *crashes*. Khususnya, feedback trading yang memperbesar mispricing (umum pada strategi momentum berbasis harga masa lalu) hanya menguntungkan dalam jangka pendek tetapi *merugi dalam jangka panjang* saat pasar mengoreksi. Algorithm trading yang mengurangi bias harga bisa profitable, namun yang memperbesar bias justru "dihukum" dengan kerugian. Model ini menunjukkan bahwa algorithmic trading adalah "double-edged sword": tidak semua strategi memberikan keuntungan konsisten bagi peserta ritel atau uninformed. Penggunaan strategi berbasis harga historis secara luas (seperti pada banyak AI/ML bot) justru dapat meningkatkan ketidakstabilan pasar alih-alih menyediakan return pasif yang andal.

**Implikasi untuk proyek ini**: Ketiga jurnal di atas secara independen mengonfirmasi bahwa elemen-elemen inti strategi p.trader (momentum rotation pada aset volatil, penggunaan AI/LLM untuk seleksi, long-only execution, dan proactive capital deployment) menghadapi risiko fundamental berupa crash, feedback loops yang merugikan, dan ketidakcocokan untuk retail yang mencari stabilitas. Bahkan dengan risk layer yang kuat, karakteristik pasar kripto dan perilaku retail membuat hasil yang konsisten dan rendah-volatilitas sangat sulit dicapai.

---

*File ini dibuat berdasarkan analisis mendalam terhadap code project p.trader, live demo performance, serta riset luas dari studi akademik, laporan industri, dan data retail trader 2024–2026. Bagian baru (Bab 7) hanya merujuk jurnal dengan DOI yang terverifikasi (lihat source.md untuk daftar lengkap).*