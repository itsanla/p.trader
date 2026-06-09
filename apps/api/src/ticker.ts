import { DurableObject } from "cloudflare:workers";
import { buildCtx } from "./lib/context";
import { logger } from "./lib/logger";
import { flushLogsAsync } from "./lib/logsink";
import { evaluateOutcomes, runCycle } from "./lib/trader";
import type { TraderEnv } from "./lib/types";

const log = logger("ticker");
const TICK_MS = 60_000; // run one cycle per minute

/**
 * The autonomous driver. Pinned to the APAC region (via locationHint when the stub is
 * created) so its outbound fetches to Bybit egress from a NON-geo-blocked location —
 * which the Cloudflare cron, running in an arbitrary (often US) colo, could not.
 * A self-rescheduling alarm keeps the loop alive without any external trigger.
 */
export class TraderTicker extends DurableObject<TraderEnv> {
  /** Idempotently ensure the alarm loop is running. Called by the keepalive cron / bootstrap.
   * Self-heals: a redeploy can leave the alarm un-fired/overdue, so if it's missing OR more
   * than 2 minutes overdue, reschedule it. The cron pokes this every minute. */
  async ensureRunning(): Promise<{ alarmAt: number | null; colo: string }> {
    let alarmAt = await this.ctx.storage.getAlarm();
    const stale = alarmAt != null && alarmAt < Date.now() - 120_000;
    if (alarmAt == null || stale) {
      alarmAt = Date.now() + 1500;
      await this.ctx.storage.setAlarm(alarmAt);
      log.info("ticker.started", { healed: stale });
      void flushLogsAsync(this.env);
    }
    return { alarmAt, colo: (this.ctx as unknown as { colo?: string }).colo ?? "?" };
  }

  /** Stop the loop entirely (clears the alarm). */
  async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    log.info("ticker.stopped");
    void flushLogsAsync(this.env);
  }

  async alarm(): Promise<void> {
    // Reschedule FIRST, so a thrown error in a cycle never kills the loop.
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    const ctx = buildCtx(this.env);
    try {
      const r = await runCycle(ctx);
      log.info("ticker.cycle", { ran: r.ran, scanned: r.scanned, exits: r.exits, action: r.action, executed: r.executed, note: r.note });
    } catch (err) {
      log.error("ticker.cycle.failed", { err: err instanceof Error ? err.message : String(err) });
    }
    // Score outcomes only every ~10 min — it makes its own subrequests (price + embed per
    // analysis), and running it every cycle would blow the Worker subrequest budget.
    if (new Date().getUTCMinutes() % 10 === 0) {
      try {
        await evaluateOutcomes(ctx);
      } catch (err) {
        log.error("ticker.evaluate.failed", { err: err instanceof Error ? err.message : String(err) });
      }
    }
    await flushLogsAsync(this.env);
  }
}
