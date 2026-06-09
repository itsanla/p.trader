import type { MarketSnapshot, RouteKind, Signal } from "./types";

// Routing: the free per-minute watcher decides whether an event deserves the LLM at
// all, and if so whether a quick single-model call ("normal") or a full multi-agent
// debate is warranted. Debate is reserved for ABNORMAL / high-stakes moments — that
// is where extra deliberation pays for itself; routine signals don't need it.

export interface Route {
  route: RouteKind;
  abnormal: boolean;
  reasons: string[];
}

const VOL_SPIKE = 3; // volume ≥ 3× its average
const ATR_ABNORMAL = 2.5; // 1H ATR% above this = unusually volatile
const STRONG_MOVE_ATR = 3; // price extended > 3× ATR from the 1H mean

/** Detect abnormal / high-stakes conditions that justify a debate. */
function abnormalFlags(snap: MarketSnapshot, positionAtRisk: boolean): string[] {
  const h = snap.tf1h;
  const flags: string[] = [];
  if (h.atrPct >= ATR_ABNORMAL) flags.push(`volatilitas abnormal (ATR ${h.atrPct.toFixed(2)}%)`);
  if (h.volumeSma20 > 0 && h.volume >= VOL_SPIKE * h.volumeSma20) flags.push("lonjakan volume ekstrem");
  if (h.atr14 > 0 && Math.abs(h.price - h.bbMid) > STRONG_MOVE_ATR * h.atr14) flags.push("harga sangat terentang dari mean");
  // Macro vs short-term conflict: 1D bullish but 4H breaking down (or vice-versa).
  const macroUp = snap.tf1d.price >= snap.tf1d.ema200;
  const shortDown = snap.tf4h.ema20 < snap.tf4h.ema50;
  if (macroUp && shortDown) flags.push("konflik timeframe (1D naik vs 4H melemah)");
  if (positionAtRisk) flags.push("posisi terbuka mendekati stop");
  return flags;
}

/**
 * Decide how to handle a symbol this minute.
 *  - debate : abnormal event (and debate enabled) — argue it out across agents/models.
 *  - normal : a clear actionable signal, or a position to manage — quick LLM call.
 *  - none   : nothing actionable.
 */
export function evaluateRoute(
  snap: MarketSnapshot,
  sig: Signal,
  opts: { hasPosition: boolean; positionAtRisk: boolean; debateEnabled: boolean; minStrength: number },
): Route {
  const flags = abnormalFlags(snap, opts.positionAtRisk);
  const actionable = sig.bias !== "flat" && sig.strength >= opts.minStrength;

  if (flags.length > 0 && (actionable || opts.hasPosition)) {
    return opts.debateEnabled
      ? { route: "debate", abnormal: true, reasons: flags }
      : { route: "normal", abnormal: true, reasons: ["(debat nonaktif) " + flags.join("; ")] };
  }

  if (actionable || opts.hasPosition) {
    const why = actionable ? [`sinyal ${sig.bias} kuat (${sig.strength.toFixed(0)})`, ...sig.reasons.slice(0, 1)] : ["kelola posisi terbuka"];
    return { route: "normal", abnormal: false, reasons: why };
  }

  return { route: "none", abnormal: false, reasons: [] };
}
