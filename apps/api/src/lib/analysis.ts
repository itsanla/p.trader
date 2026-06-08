import { z } from "zod";
import type { Ctx } from "./context";
import { logger } from "./logger";
import type { Action, Decision, Indicators, MarketSnapshot, WalletBalance } from "./types";
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
function normalizeDecision(raw: z.infer<typeof decisionSchema>): Decision {
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
  wallet: WalletBalance;
  openTrades: OpenTrade[];
  triggerReasons: string[];
  similarMemories: string[];
  performance: { wins: number; losses: number; avgPnlPct: number };
}

function buildUserPrompt(c: DecisionContext): string {
  const { snapshot: s, wallet, openTrades, triggerReasons, similarMemories, performance } = c;
  const lines: string[] = [];
  lines.push(`PASANGAN: ${s.symbol} | Harga terkini: ${s.price}`);
  lines.push(`Pemicu analisa: ${triggerReasons.join("; ") || "terjadwal"}`);
  lines.push("");
  lines.push("INDIKATOR MULTI-TIMEFRAME:");
  lines.push(fmtTf("1H", s.tf1h));
  lines.push(fmtTf("4H", s.tf4h));
  lines.push(fmtTf("1D", s.tf1d));
  lines.push("");
  lines.push(`SALDO: ${wallet.baseCoin} base, ${wallet.quoteCoin} quote, ekuitas ≈ ${wallet.totalEquityQuote.toFixed(2)}`);
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
