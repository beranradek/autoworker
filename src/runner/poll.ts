import { getConfig } from "../config.js";
import { log } from "../log.js";
import { runOnce } from "./run-once.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pollForever(): Promise<void> {
  const cfg = getConfig();
  log("info", "poll.loop_start", { intervalSeconds: cfg.POLL_INTERVAL_SECONDS });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      log("error", "poll.loop_error", { error: String(err) });
    }
    await sleep(cfg.POLL_INTERVAL_SECONDS * 1000);
  }
}

