import { runOnce } from "./runner/run-once.js";
import { pollForever } from "./runner/poll.js";

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
  console.error("Usage: node dist/cli.js <run-once|poll>");
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

