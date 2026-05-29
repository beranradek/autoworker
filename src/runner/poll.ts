import { getConfig } from "../config.js";
import { log } from "../log.js";
import { startHealthServer } from "../health/server.js";
import { markPollDoneError, markPollDoneOk, markPollStart } from "../status.js";
import { isWithinWorkHours, secondsUntilNextWorkWindow } from "../schedule/work-hours.js";
import { runOnce } from "./run-once.js";
import type { Mutex } from "./lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The polling loop body, without starting the health server. Used directly by
 * `serve` (as a safety net alongside webhooks) and via `pollForever` by the
 * standalone `poll` command.
 *
 * When `lock` is provided, each poll cycle runs under it so it never overlaps a
 * webhook-triggered orchestration run.
 */
export async function pollLoop(opts: { lock?: Mutex } = {}): Promise<void> {
  const cfg = getConfig();
  log("info", "poll.loop_start", { intervalSeconds: cfg.POLL_INTERVAL_SECONDS });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const inWorkHours = isWithinWorkHours(new Date(), {
        timeZone: cfg.WORK_HOURS_TZ,
        startHour: cfg.WORK_HOURS_START,
        endHour: cfg.WORK_HOURS_END
      });

      if (!inWorkHours) {
        const secondsUntil = secondsUntilNextWorkWindow(new Date(), {
          timeZone: cfg.WORK_HOURS_TZ,
          startHour: cfg.WORK_HOURS_START,
          endHour: cfg.WORK_HOURS_END
        });
        const sleepSeconds = Math.min(Math.max(secondsUntil, 60), 15 * 60);
        log("info", "poll.outside_work_hours", {
          timeZone: cfg.WORK_HOURS_TZ,
          startHour: cfg.WORK_HOURS_START,
          endHour: cfg.WORK_HOURS_END,
          sleepSeconds
        });
        await sleep(sleepSeconds * 1000);
        continue;
      }

      markPollStart();
      await (opts.lock ? opts.lock.run(() => runOnce()) : runOnce());
      markPollDoneOk();
    } catch (err) {
      log("error", "poll.loop_error", { error: String(err) });
      markPollDoneError(err);
    }
    await sleep(cfg.POLL_INTERVAL_SECONDS * 1000);
  }
}

export async function pollForever(): Promise<void> {
  startHealthServer();
  await pollLoop();
}
