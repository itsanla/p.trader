import { buildUserPrompt, decisionSchema, normalizeDecision, type DecisionContext, type DecisionOutput } from "./analysis";
import type { Ctx } from "./context";
import { logger } from "./logger";

const log = logger("debate");

// Multi-agent debate for ABNORMAL / high-stakes events. Three role-specialised agents
// argue on DIFFERENT models (decorrelating their blind spots), then a judge weighs the
// rebuttals into one structured decision. Honest caveat: debate improves entry quality
// but does NOT guarantee profit — the risk layer is what prevents ruin. We A/B this
// against single-model decisions via the outcome table, so its value is measured, not assumed.

// Role → model. Picked from the registry for diversity (different base models).
const BULL_MODEL = "openai/gpt-oss-120b";
const BEAR_MODEL = "llama-3.3-70b-versatile";
const RISK_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const JUDGE_MODEL = "openai/gpt-oss-120b";

async function agent(ctx: Ctx, role: string, model: string, system: string, context: string): Promise<string> {
  try {
    const r = await ctx.groq.generate([{ role: "user", content: context }], { systemPrompt: system, model, temperature: 0.4, maxOutputTokens: 700 });
    return r.text.trim();
  } catch (err) {
    log.warn("agent.failed", { role, err: err instanceof Error ? err.message : String(err) });
    return `(${role} tak tersedia)`;
  }
}

/** Run a Bull/Bear/Risk debate, then a judge, returning a structured Decision. */
export async function runDebate(ctx: Ctx, dctx: DecisionContext): Promise<DecisionOutput> {
  const context = buildUserPrompt(dctx);

  // Round 1 — each agent writes independently (closed) so no one anchors on another.
  const [bull, bear, risk] = await Promise.all([
    agent(ctx, "bull", BULL_MODEL, "Kamu trader BULLISH. Berikan argumen TERKUAT untuk MASUK long sekarang: katalis, konfluensi timeframe, target. Maksimal 6 kalimat.", context),
    agent(ctx, "bear", BEAR_MODEL, "Kamu trader BEARISH. Berikan argumen TERKUAT bahwa harga akan turun / sebaiknya tetap cash. Bantah tesis bullish. Maksimal 6 kalimat.", context),
    agent(ctx, "risk", RISK_MODEL, "Kamu manajer RISIKO (devil's advocate). Jelaskan bagaimana trade ini bisa RUGI besar, di mana stop wajar, dan apakah R:R layak. Boleh VETO. Maksimal 6 kalimat.", context),
  ]);
  log.info("debate.round", { bullChars: bull.length, bearChars: bear.length, riskChars: risk.length });

  // Round 2 — the judge sees all three and must output the structured decision.
  const judgePrompt = [
    context,
    "",
    "=== DEBAT AGEN ===",
    `🐂 BULL:\n${bull}`,
    `🐻 BEAR:\n${bear}`,
    `🛡️ RISK:\n${risk}`,
    "",
    "Sebagai HAKIM: timbang ketiga argumen di atas. Hormati keberatan RISK — jika R:R buruk atau risiko besar, pilih HOLD. Keluarkan keputusan terstruktur final.",
  ].join("\n");

  const r = await ctx.groq.generateStructured(decisionSchema, [{ role: "user", content: judgePrompt }], {
    systemPrompt:
      "Kamu hakim trading yang disiplin. Timbang argumen bull, bear, dan risk. Default HOLD bila ragu atau R:R buruk. Wajib stop_loss untuk BUY/SELL. Jawab hanya sesuai skema.",
    model: JUDGE_MODEL,
    temperature: 0.2,
  });
  const decision = normalizeDecision(r.object);
  log.info("debate.verdict", { action: decision.action, confidence: decision.confidence });
  return { decision, keyUsed: r.keyUsed, modelUsed: `debate:${r.modelUsed}`, samples: 4 };
}
