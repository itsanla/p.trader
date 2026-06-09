import { z } from "zod";
import type { Ctx } from "./context";
import { logger } from "./logger";
import type { Action, Decision, Indicators, MarketSnapshot, Wallet } from "./types";
import type { OpenTrade } from "./db";

const log = logger("analysis");

// Structured, schema-typed decision. generateObject guarantees a parseable result,
// so execution never depends on regex-parsing free text. Field descriptions double
// as inline instructions to the model.
// Constraints are deliberately lenient: gpt-oss/Llama occasionally return a
// 1-element entryZone or extra keyFactors, and a hard .length()/.max() makes
// generateObject throw NoObjectGenerated (failing every failover key). We accept a
// loose shape here and normalize/clamp in normalizeDecision().
export const decisionSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]).describe("Aksi trading. Default HOLD jika sinyal tidak jelas."),
  confidence: z.number().describe("Keyakinan 0-100. Hanya BUY/SELL bila yakin."),
  timeframeBias: z.enum(["bullish", "bearish", "neutral"]).describe("Bias tren gabungan multi-timeframe."),
  entryZone: z.array(z.number()).nullable().describe("[low, high] zona entry (2 angka), atau null untuk HOLD."),
  stopLoss: z.number().nullable().describe("Harga stop-loss. WAJIB diisi untuk BUY/SELL."),
  takeProfit: z.array(z.number()).nullable().describe("Satu atau dua target take-profit, atau null."),
  reasoning: z.string().describe("Alasan ringkas berbasis indikator & konteks."),
  keyFactors: z.array(z.string()).describe("Maksimal 5 faktor kunci pendorong keputusan."),
  invalidation: z.string().describe("Kondisi yang membatalkan tesis ini."),
});

/** Clamp/normalize a raw model object into a well-formed Decision. */
export function normalizeDecision(raw: z.infer<typeof decisionSchema>): Decision {
  const ez = raw.entryZone;
  const entryZone: [number, number] | null =
    ez && ez.length >= 2 ? [ez[0], ez[1]] : ez && ez.length === 1 ? [ez[0], ez[0]] : null;
  return {
    action: raw.action,
    confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
    timeframeBias: raw.timeframeBias,
    entryZone,
    stopLoss: raw.stopLoss,
    takeProfit: raw.takeProfit && raw.takeProfit.length ? raw.takeProfit.slice(0, 2) : null,
    reasoning: raw.reasoning.slice(0, 1000),
    keyFactors: (raw.keyFactors ?? []).slice(0, 5),
    invalidation: raw.invalidation,
  };
}

const SYSTEM_PROMPT = `Kamu analis teknikal kripto yang disiplin dan konservatif. Tugasmu memutuskan BUY, SELL, atau HOLD untuk satu pasangan spot.

Prinsip:
- Preservasi modal di atas FOMO. Jika sinyal tidak selaras atau ambigu, pilih HOLD.
- BUY/SELL hanya jika minimal 2 dari 3 timeframe (1H/4H/1D) searah DAN ada konfirmasi momentum.
- Selalu sertakan stop_loss yang masuk akal (berbasis ATR/struktur), jangan menebak.
- Pelajari memori situasi serupa di masa lalu beserta hasilnya — jika pola serupa sering rugi, turunkan keyakinan.
- Jawab HANYA sesuai skema terstruktur. Bahasa Indonesia untuk teks.`;

function fmtTf(label: string, i: Indicators): string {
  return [
    `${label}: harga=${i.price.toFixed(2)}`,
    `EMA20=${i.ema20.toFixed(2)} EMA50=${i.ema50.toFixed(2)} EMA200=${i.ema200.toFixed(2)}`,
    `RSI=${i.rsi14.toFixed(1)}`,
    `MACD=${i.macd.toFixed(2)}/sig=${i.macdSignal.toFixed(2)}/hist=${i.macdHist.toFixed(2)}`,
    `ATR=${i.atr14.toFixed(2)} (${i.atrPct.toFixed(2)}%)`,
    `BB=[${i.bbLower.toFixed(2)}, ${i.bbMid.toFixed(2)}, ${i.bbUpper.toFixed(2)}]`,
    `vol=${i.volume.toFixed(2)} (sma20=${i.volumeSma20.toFixed(2)})`,
  ].join(" | ");
}

export interface DecisionContext {
  snapshot: MarketSnapshot;
  wallet: Wallet;
  baseCoin: string; // base coin of the snapshot's symbol (e.g. "BTC")
  openTrades: OpenTrade[];
  triggerReasons: string[];
  similarMemories: string[];
  performance: { wins: number; losses: number; avgPnlPct: number };
}

export const DECISION_SYSTEM_PROMPT = SYSTEM_PROMPT;

export function buildUserPrompt(c: DecisionContext): string {
  const { snapshot: s, wallet, baseCoin, openTrades, triggerReasons, similarMemories, performance } = c;
  const lines: string[] = [];
  lines.push(`PASANGAN: ${s.symbol} | Harga terkini: ${s.price}`);
  lines.push(`Pemicu analisa: ${triggerReasons.join("; ") || "terjadwal"}`);
  lines.push("");
  lines.push("INDIKATOR MULTI-TIMEFRAME:");
  lines.push(fmtTf("1H", s.tf1h));
  lines.push(fmtTf("4H", s.tf4h));
  lines.push(fmtTf("1D", s.tf1d));
  lines.push("");
  lines.push(`SALDO: ${wallet.coins[baseCoin] ?? 0} ${baseCoin}, ${wallet.quote.toFixed(2)} quote, ekuitas ≈ ${wallet.totalEquityQuote.toFixed(2)}`);
  if (openTrades.length) {
    lines.push("POSISI TERBUKA:");
    for (const t of openTrades) {
      lines.push(`- ${t.side} ${t.qty} @ ${t.price} | SL=${t.stopLoss ?? "-"} TP=${t.takeProfit ?? "-"}`);
    }
  } else {
    lines.push("POSISI TERBUKA: tidak ada");
  }
  lines.push("");
  const total = performance.wins + performance.losses;
  if (total > 0) {
    const wr = ((performance.wins / total) * 100).toFixed(0);
    lines.push(`PERFORMA LALU (${total} trade dievaluasi): win-rate ${wr}%, rata-rata PnL ${performance.avgPnlPct.toFixed(2)}%`);
  }
  if (similarMemories.length) {
    lines.push("");
    lines.push("MEMORI SITUASI SERUPA DI MASA LALU (beserta hasilnya):");
    for (const m of similarMemories) lines.push(`- ${m}`);
  }
  lines.push("");
  lines.push("Berikan keputusan trading sesuai skema.");
  return lines.join("\n");
}

export interface DecisionOutput {
  decision: Decision;
  keyUsed: string;
  modelUsed: string;
  samples: number;
}

/** Run the decision model (with self-consistency voting) and return a single Decision. */
export async function runDecision(ctx: Ctx, dctx: DecisionContext): Promise<DecisionOutput> {
  const userPrompt = buildUserPrompt(dctx);
  const n = ctx.cfg.selfConsistency;
  const results: Decision[] = [];
  let keyUsed = "";
  let modelUsed = "";

  for (let i = 0; i < n; i++) {
    try {
      const r = await ctx.groq.generateStructured(decisionSchema, [{ role: "user", content: userPrompt }], {
        systemPrompt: SYSTEM_PROMPT,
        // Vary temperature across samples so voting actually explores.
        temperature: n === 1 ? 0.2 : 0.2 + (i * 0.4) / Math.max(1, n - 1),
      });
      results.push(normalizeDecision(r.object));
      keyUsed = r.keyUsed;
      modelUsed = r.modelUsed;
    } catch (err) {
      log.error("sample.failed", { i, err: err instanceof Error ? err : String(err) });
    }
  }

  if (results.length === 0) throw new Error("All decision samples failed");

  const decision = voteDecisions(results);
  log.info("decision", { action: decision.action, confidence: decision.confidence, samples: results.length, agree: countVotes(results)[decision.action] });
  return { decision, keyUsed, modelUsed, samples: results.length };
}

// ── Proactive selection: let the AI pick the best BUY from the momentum shortlist ──

export const selectionSchema = z.object({
  pick: z.string().describe("Simbol koin terbaik untuk BUY sekarang (mis. SOLUSDT), atau 'HOLD' jika benar-benar tak ada setup layak."),
  confidence: z.number().describe("Keyakinan 0-100 pada pilihan."),
  stopLoss: z.number().nullable().describe("Harga stop-loss untuk koin yang dipilih (WAJIB jika BUY)."),
  takeProfit: z.array(z.number()).nullable().describe("Target take-profit, atau null."),
  reasoning: z.string().describe("Alasan ringkas berbasis data (tren, momentum, volume, R:R)."),
});

export interface SelectionCandidate {
  symbol: string;
  snapshot: MarketSnapshot;
  chg24h: number;
}

export interface SelectionOutput {
  pick: string | null; // chosen symbol, or null for HOLD
  confidence: number;
  stopLoss: number | null;
  takeProfit: number[] | null;
  reasoning: string;
  keyUsed: string;
  modelUsed: string;
}

const SELECT_SYSTEM = `Kamu MANAJER PORTFOLIO MOMENTUM yang proaktif. Filosofimu: modal harus SELALU BEKERJA di koin-koin TERKUAT, bukan menganggur sebagai kas. Kas menganggur = biaya peluang (tidak menghasilkan apa-apa).

Kamu punya slot posisi kosong dan kas. TUGAS UTAMAMU: isi slot dengan koin momentum TERBAIK yang tersedia SEKARANG dari daftar pemimpin momentum.

Aturan pilih:
- BUY kandidat terbaik (momentum + tren naik terkuat). Ini default-mu.
- RSI 55-80 dengan EMA naik = momentum SEHAT, BOLEH dan BAGUS dibeli — momentum sering berlanjut. JANGAN terlalu takut "overbought"; jangan menolak hanya karena RSI 70-an atau MACD datar sesaat.
- Pilih 'HOLD' HANYA jika SEMUA kandidat benar-benar buruk: tren JELAS turun (EMA menurun/harga di bawah EMA50), ATAU blow-off ekstrem (RSI > 85).
- Bandingkan kandidat secara relatif: pilih yang PALING kuat, bukan yang sempurna.

Wajib stop_loss masuk akal (berbasis ATR/struktur, biasanya 1.5-2× ATR di bawah harga). Jawab hanya sesuai skema.`;

/** Ask the LLM to pick the single best BUY among the screened momentum leaders. */
export async function runSelection(ctx: Ctx, candidates: SelectionCandidate[], wallet: Wallet, performance: { wins: number; losses: number; avgPnlPct: number }): Promise<SelectionOutput> {
  const lines = candidates.map((c) => {
    const h = c.snapshot.tf1h;
    const trend = h.ema20 > h.ema50 && h.ema50 > h.ema200 ? "EMA↑susun" : h.ema20 > h.ema50 ? "EMA↑lemah" : "EMA↓";
    const volX = h.volumeSma20 > 0 ? (h.volume / h.volumeSma20).toFixed(1) : "?";
    return `${c.symbol} | 24h ${c.chg24h >= 0 ? "+" : ""}${c.chg24h.toFixed(1)}% | px ${c.snapshot.price} | RSI ${h.rsi14.toFixed(0)} ADX4h ${c.snapshot.tf4h.adx14.toFixed(0)} MACDh ${h.macdHist.toFixed(2)} ATR% ${h.atrPct.toFixed(2)} vol×${volX} | ${trend}`;
  });
  const total = performance.wins + performance.losses;
  const perf = total > 0 ? `\nPerforma lalu: win-rate ${((performance.wins / total) * 100).toFixed(0)}% (${total} trade), rata PnL ${performance.avgPnlPct.toFixed(2)}%` : "";
  const prompt = `Kas menganggur: ${wallet.quote.toFixed(0)} USDT — idealnya di-deploy ke koin terkuat (jangan dibiarkan diam).\nKANDIDAT MOMENTUM TERKUAT (sudah lolos screening likuiditas):\n${lines.join("\n")}${perf}\n\nPilih SATU koin TERBAIK untuk BUY sekarang. HOLD hanya jika SEMUA jelas buruk (tren turun / blow-off RSI>85).`;

  let r;
  try {
    r = await ctx.groq.generateStructured(selectionSchema, [{ role: "user", content: prompt }], { systemPrompt: SELECT_SYSTEM, temperature: 0.3 });
  } catch (err) {
    // A malformed model response must NOT crash the cycle — treat as HOLD this minute.
    log.warn("selection.failed", { err: err instanceof Error ? err.message : String(err) });
    return { pick: null, confidence: 0, stopLoss: null, takeProfit: null, reasoning: "model error → HOLD", keyUsed: "", modelUsed: "" };
  }
  const o = r.object;
  const pickRaw = (o.pick ?? "").trim().toUpperCase();
  const pick = pickRaw && pickRaw !== "HOLD" && candidates.some((c) => c.symbol === pickRaw) ? pickRaw : null;
  log.info("selection", { pick: pick ?? "HOLD", confidence: o.confidence, candidates: candidates.length });
  return {
    pick,
    confidence: Math.max(0, Math.min(100, Math.round(o.confidence))),
    stopLoss: o.stopLoss,
    takeProfit: o.takeProfit && o.takeProfit.length ? o.takeProfit.slice(0, 2) : null,
    reasoning: o.reasoning.slice(0, 1000),
    keyUsed: r.keyUsed,
    modelUsed: r.modelUsed,
  };
}

function countVotes(results: Decision[]): Record<Action, number> {
  const votes: Record<Action, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const r of results) votes[r.action]++;
  return votes;
}

/** Majority-vote the action; if BUY/SELL doesn't win a strict majority, fall back to HOLD. */
function voteDecisions(results: Decision[]): Decision {
  if (results.length === 1) return results[0];
  const votes = countVotes(results);
  const total = results.length;

  let winner: Action = "HOLD";
  if (votes.BUY > total / 2) winner = "BUY";
  else if (votes.SELL > total / 2) winner = "SELL";

  const winning = results.filter((r) => r.action === winner);
  // Represent the bloc with its highest-confidence member, but report the bloc's
  // AVERAGE confidence (a split vote should not look more certain than it is).
  const rep = winning.reduce((a, b) => (b.confidence > a.confidence ? b : a), winning[0] ?? results[0]);
  const avgConf = winning.length ? winning.reduce((acc, r) => acc + r.confidence, 0) / winning.length : 0;
  return { ...rep, confidence: Math.round(avgConf) };
}
