import dotenv from "dotenv";

// In production, never override already-provided env vars.
dotenv.config({ override: false });
import { runOnce } from "./runner/run-once.js";
import { pollForever } from "./runner/poll.js";
import { serve } from "./runner/serve.js";
import { cleanupJobs } from "./runner/cleanup.js";

async function main() {
  const cmd = process.argv[2] ?? "";
  if (cmd === "run-once") {
    await runOnce();
    return;
  }
  if (cmd === "poll") {
    await pollForever();
    return;
  }
  if (cmd === "serve") {
    await serve();
    return;
  }
  if (cmd === "cleanup") {
    await cleanupJobs();
    return;
  }
  console.error("Usage: node dist/cli.js <run-once|poll|serve|cleanup>");
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
