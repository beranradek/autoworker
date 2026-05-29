import fs from "node:fs";
import path from "node:path";
import { log, spawnOpencode, readJsonFile } from "./common.mjs";

export async function runGrader({ criteriaText, diffText, resultData, repoDir, artifactsDir, opencodeEnv, timeoutMs, iteration }) {
  try {
    const graderPrompt = [
      "You are a code reviewer evaluating whether an implementation satisfies acceptance criteria.",
      "",
      "Your ONLY job is to evaluate. Do NOT modify any source files. Do NOT run git or gh commands.",
      "Do NOT push, commit, or create PRs. Do NOT install packages or change configuration.",
      "",
      "Evaluate each acceptance criterion independently against the git diff and implementer result below.",
      "Then write a JSON file at .autoworker/eval-result.json with this exact schema:",
      "{",
      '  "pass": boolean,',
      '  "gaps": string[],',
      '  "summary": string',
      "}",
      "",
      '"pass" is true only if ALL criteria are satisfied.',
      '"gaps" is a list of unmet criteria with specific reasons. Empty array if pass is true.',
      '"summary" is a one-paragraph evaluation summary.',
      "",
      "<acceptance-criteria>",
      criteriaText,
      "</acceptance-criteria>",
      "",
      "<git-diff>",
      diffText,
      "</git-diff>",
      "",
      "<implementer-result>",
      JSON.stringify(resultData, null, 2),
      "</implementer-result>"
    ].join("\n");

    const promptPath = path.join(artifactsDir, `grader-prompt-${iteration}.txt`);
    fs.writeFileSync(promptPath, graderPrompt, "utf8");
    log("info", "grader.prompt.written", { iteration, promptPath });

    const logPath = path.join(artifactsDir, `opencode-grader-${iteration}.log`);
    log("info", "grader.start", { iteration, model: opencodeEnv.LLM_MODEL, dir: repoDir });
    const ocExitCode = await spawnOpencode({
      prompt: graderPrompt,
      repoDir,
      logPath,
      env: opencodeEnv,
      timeoutMs
    });
    log(ocExitCode === 0 ? "info" : "warn", "grader.opencode.done", { iteration, exitCode: ocExitCode });
    if (ocExitCode !== 0) {
      log("error", "grader.opencode.failed", { iteration, exitCode: ocExitCode });
      return null;
    }

    const evalResultPath = path.join(repoDir, ".autoworker", "eval-result.json");
    const evalResult = readJsonFile(evalResultPath);
    if (!evalResult.ok) {
      log("error", "grader.eval_result.missing_or_invalid", {
        iteration,
        path: evalResultPath,
        reason: evalResult.reason,
        error: evalResult.error
      });
      return null;
    }

    try {
      fs.rmSync(evalResultPath, { force: true });
    } catch {
      // ignore
    }

    const parsed = evalResult.parsed ?? {};
    const pass = typeof parsed.pass === "boolean" ? parsed.pass : false;
    const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : [];
    const summary = String(parsed.summary ?? "");

    if (typeof pass !== "boolean" || !Array.isArray(gaps) || typeof summary !== "string") {
      log("warn", "grader.eval_result.invalid_schema", {
        iteration,
        path: evalResultPath,
        parsed: JSON.stringify(parsed)
      });
      return null;
    }

    log("info", "eval.done", { iteration, pass, gapCount: gaps.length });
    return { pass, gaps, summary };
  } catch (e) {
    log("error", "grader.exception", { iteration, error: String(e) });
    return null;
  }
}
