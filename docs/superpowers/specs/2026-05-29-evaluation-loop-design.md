# Evaluation Loop Design

**Date:** 2026-05-29  
**Status:** Approved  
**Scope:** Worker container only (`docker/lib/`) — no orchestrator or Terraform changes.

---

## Problem

The worker currently runs a single OpenCode session per issue and creates a PR regardless of whether the implementation actually satisfies the stated requirements. For non-trivial issues, this produces PRs that need significant human review to catch gaps.

The [Anthropic Managed Agents article on outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes) describes a pattern where a separate grader agent evaluates the implementer's artifact against an explicit rubric, then hands feedback back for iteration. This design brings that pattern to the autoworker harness.

---

## Goals

- When a GitHub issue contains an `## Acceptance Criteria` (or `## Evaluation Criteria`) section, run a grader agent after the implementer to check whether the criteria are met.
- If not met, give the implementer one more shot with the grader's specific feedback.
- Always create the PR (never silently fail); note the evaluation outcome in the PR body.
- Zero change to behavior for issues without a criteria section.
- No new required env vars, no orchestrator changes, no Terraform changes.

---

## Architecture

The evaluation loop lives entirely inside the worker container, in `docker/lib/`. The harness (`worker-harness.mjs`) is unchanged.

```
issue body
  └─ parseCriteria() → criteriaText  (null → skip eval, current single-shot behavior)

iteration = 1, feedback = null
loop (max 2 iterations, configurable via MAX_EVAL_ITERATIONS, default 2):

  build implementer prompt (base + grader feedback if iteration > 1)
  spawnOpencode(implementerPrompt)          ← existing path, unchanged
  read .autoworker/result.json

  if criteriaText AND git diff has changes:
    diffText = `git diff HEAD` (first 15 000 chars; remainder truncated)
    spawnOpencode(graderPrompt)             ← new: fresh process = fresh context window
    read .autoworker/eval-result.json → { pass, gaps[], summary }
    log eval outcome
    if pass → break
    if iteration < max → feedback = gaps joined as text, iteration++
    else → break (PR created with "not fully satisfied" note)
  else:
    break  (no criteria or no changes → no grader)

clean .autoworker/ from repo
commit → push → createPR  (PR body includes eval outcome section when criteria present)
```

The grader runs as a second `spawnOpencode` call — a fresh OS process with its own context window, no access to the implementer's conversation history. This mirrors the article's "separate context window" design principle.

---

## New Modules

### `docker/lib/criteria.mjs`

Single export:

```js
parseCriteria(issueBody: string): string | null
```

- Searches for a heading matching `/^##+ *(acceptance|evaluation) criteria/i`.
- Returns all text from that heading until the next `##`-level heading (or end of body), trimmed.
- Returns `null` if no such section exists.
- The returned text becomes the rubric passed to the grader.

### `docker/lib/evaluate.mjs`

Single export:

```js
runGrader({
  criteriaText: string,
  diffText: string,
  resultData: object | null,
  repoDir: string,
  artifactsDir: string,
  opencodeEnv: object,
  timeoutMs: number,
}): Promise<{ pass: boolean, gaps: string[], summary: string } | null>
```

- Constructs the grader prompt (see below).
- Calls `spawnOpencode` from `common.mjs`.
- Reads `.autoworker/eval-result.json` written by the grader.
- Returns `null` on any failure (OpenCode crash, missing file, bad JSON) — caller treats `null` as "evaluation skipped, proceed normally."
- Logs the outcome at `info` level as `eval.done`.

**Grader prompt:**

```
You are a code reviewer evaluating whether an implementation satisfies acceptance criteria.

Your ONLY job is to evaluate. Do NOT modify any source files. Do NOT run git or gh commands.
Do NOT push, commit, or create PRs.

Evaluate each acceptance criterion independently against the git diff and implementer result below.
Then write a JSON file at .autoworker/eval-result.json with this schema:
{
  "pass": boolean,           // true only if ALL criteria are satisfied
  "gaps": string[],          // list of unmet criteria with specific reasons; empty if pass=true
  "summary": string          // one-paragraph evaluation summary
}

<acceptance-criteria>
${criteriaText}
</acceptance-criteria>

<git-diff>
${diffText}
</git-diff>

<implementer-result>
${JSON.stringify(resultData, null, 2)}
</implementer-result>
```

**Grader log path:** `artifacts/opencode-grader-{iteration}.log`

---

## Changes to `implement.mjs`

### Extract helper: `runSingleImplementer`

The existing OpenCode spawn + result.json read logic is extracted into a private helper so it can be called in a loop:

```js
async function runSingleImplementer(prompt, { repoDir, artifactsDir, opencodeEnv, timeoutMs, logSuffix })
  → { ocExitCode, resultFile }
```

`logSuffix` distinguishes log files between iterations: `opencode-1.log`, `opencode-2.log`.

### Modified: `runImplementation`

Top-level changes:

1. Call `parseCriteria(issueBody)` → `criteriaText`.
2. Read `MAX_EVAL_ITERATIONS` env var (default `2`, capped at `5`).
3. Replace the single `spawnOpencode` call with a `for` loop (1..maxIterations):
   - Build implementer prompt; if `feedback` set, append `<grader-feedback>` block.
   - Call `runSingleImplementer`.
   - If `criteriaText` present and git diff shows changes, call `runGrader`.
   - On `pass=true`, break.
   - On `pass=false` and not last iteration, set `feedback = gaps.join("\n")`, continue.
   - On last iteration (or no criteria), break.
4. After the loop, pass `evalOutcome` to PR body construction.

The implementer prompt feedback block:

```
<grader-feedback>
The previous implementation did not fully satisfy the acceptance criteria. Specific gaps:

${gaps.join("\n")}

Please address these gaps in your implementation.
</grader-feedback>
```

### PR body change

When `evalOutcome` is set, append after the existing summary section:

```markdown
## Evaluation

✅ All acceptance criteria satisfied (iteration N of M)
```

or:

```markdown
## Evaluation

⚠️ Acceptance criteria not fully satisfied after N iteration(s):
- gap text 1
- gap text 2
```

---

## Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Issue has no criteria section | `parseCriteria` returns `null`; grader never runs; existing behavior unchanged |
| Grader OpenCode crashes | `runGrader` returns `null`; harness logs `eval.grader_failed`; continues as if no eval |
| Grader writes bad JSON | Same as crash — `null` returned, warning logged |
| Diff is empty (no changes) | Grader skipped even if criteria present; no point evaluating nothing |
| Diff exceeds 15 000 chars | First 15 000 chars kept; a truncation note is appended to the diff block |
| `pass=true` on iteration 1 | Loop exits immediately; PR body notes "satisfied (iteration 1 of 2)" |
| Implementer reports `status=rejected` | Grader loop is skipped; rejection path is unchanged |
| Implementer reports `status=failed` | Grader loop is skipped; failure path is unchanged |

---

## Artifact Files

| File | Written by | Cleaned before commit |
|---|---|---|
| `artifacts/issue-prompt.txt` | harness | no (artifact) |
| `artifacts/opencode-1.log` | harness | no (artifact) |
| `artifacts/opencode-2.log` | harness (if iteration 2) | no (artifact) |
| `artifacts/opencode-grader-1.log` | harness | no (artifact) |
| `artifacts/opencode-grader-2.log` | harness (if iteration 2) | no (artifact) |
| `artifacts/agent-result.json` | harness | no (artifact) |
| `artifacts/eval-result.json` | harness (copy) | no (artifact) |
| `.autoworker/result.json` | implementer OpenCode | yes (before commit) |
| `.autoworker/eval-result.json` | grader OpenCode | yes (before commit) |

---

## Migration Note: Log Filename Change

The existing `artifacts/opencode.log` artifact is renamed to `artifacts/opencode-1.log` so all iteration logs follow a consistent naming scheme. Anyone tailing this file by name in Azure (`az containerapp job logs show ...` scripts or dashboards) will need to update to the new name. The old `opencode.log` path will no longer be written.

---

## Out of Scope

- Orchestrator changes
- Terraform changes
- A separate container/job for evaluation
- Using the Anthropic Managed Agents API (the harness self-implements the same pattern via OpenCode)
- Per-criterion scoring or partial credit — just `pass` / `needs_revision`
- Different LLM model for grader vs. implementer
