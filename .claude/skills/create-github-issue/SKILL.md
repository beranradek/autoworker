# Skill: create-github-issue

Create a new GitHub issue that is ready for **autoworker** to pick up (contains `@worker`), is **self-contained**, includes **implementation + verification steps**, and has explicit **acceptance criteria** suitable for automated evaluation.

This skill also reads existing issues and their **issue dependencies** (“blocked by” / “blocking”) and, when relevant, sets the new issue’s dependencies via the official GitHub REST API using `gh api`.

## Inputs you must have

- Target repo in `owner/repo` format (either provided explicitly, or inferred from the current git remote).
- Issue `title`
- Issue `description context` (can be a plan/spec/design file path, or raw text)

Optional:
- One or more context files (e.g. design notes, plan docs) to embed into the issue description.
- A list of known related issues (numbers like `#123`) if the plan/spec references them.

## Tools

- `gh` CLI (must be authenticated for the target repo)
- Shell utilities: `rg`, `sed`, `cat`, `jq` (if available)

## Workflow

### 1) Identify the repo

If repo is not provided, infer it:

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "$REPO"
```

### 2) Load context (plan/spec/design)

If a context file path is given, read it and extract the **minimum necessary** content to make the issue self-contained:

- What needs to be built and why
- Constraints / non-goals
- Any referenced endpoints, env vars, files, or data formats
- Verification strategy

If the context references other issues (e.g. `#123`), record them as candidate dependencies.

### 3) Read existing issues + dependency graph

Fetch open issues (short summary):

```bash
gh issue list --repo "$REPO" --state open --limit 200 --json number,title,labels,url -q '.[] | {number,title,labels:[.labels[].name],url}'
```

For dependency analysis, use the **official GitHub issue dependencies REST API** (blocked_by / blocking):
https://docs.github.com/en/enterprise-cloud@latest/rest/issues/issue-dependencies?apiVersion=2022-11-28

Example: list which issues a given issue is blocked by:

```bash
N=123
gh api -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/${REPO}/issues/${N}/dependencies/blocked_by"
```

Example: list which issues a given issue is blocking:

```bash
gh api -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/${REPO}/issues/${N}/dependencies/blocking"
```

Build a quick local picture:
- Which issues are already **closed** (dependencies satisfied)
- Which open issues are **blocked** by what
- Which issues would unblock many others

Also check for potential duplicates (title keywords):

```bash
QUERY="some keywords"
gh issue list --repo "$REPO" --state all --search "$QUERY" --limit 50 --json number,title,state,url -q '.[] | "\(.number)\t\(.state)\t\(.title)"'
```

### 4) Decide dependencies for the new issue

Only set a dependency when it is clearly required for correctness (e.g. shared API contract, database migration, foundational refactor).

Output dependencies as “blocked by” relationships:
- New issue is **blocked by** prerequisite issue(s).

### 5) Write the issue body (self-contained, evaluator-friendly)

The body MUST include:

- A clear `@worker` mention near the top.
- **Implementation steps**: concrete file/route/module changes, ordered.
- **Verification steps**: exact commands/checks that should pass.
- **Acceptance criteria**: 5–10 specific, testable bullets (these are what an evaluator subagent can score).

Recommended template:

```md
@worker

## Overview
<1–3 paragraphs: what to implement and why>

## Context
<key context distilled from plan/spec/design; include important constraints>

## Dependencies
- Blocked by: #<n> — <why>
- Blocked by: #<n> — <why>

## Implementation steps
1. ...
2. ...

## Verification steps
1. ...
2. ...

## Acceptance criteria
- [ ] ...
- [ ] ...
```

### 6) Create the issue via `gh`

Write the body to a temp file to avoid quoting issues:

```bash
TITLE="..."
BODY_FILE="/tmp/autoworker-new-issue.md"

OUT="$(gh issue create --repo "$REPO" --title "$TITLE" --body-file "$BODY_FILE")"
echo "$OUT"
```

Capture the new issue number:

```bash
NEW_URL="$OUT"                       # gh prints the created issue URL
NEW_NUM="$(echo "$NEW_URL" | awk -F/ '{print $NF}')"
echo "$NEW_NUM"
```

(Alternatively parse the output of `gh issue create`; prefer a robust approach in your environment.)

### 7) Set dependencies (blocked by) on the new issue

The GitHub REST endpoint requires the dependency issue **ID** (not the issue number). See the official docs above.

For each prerequisite issue `DEP_NUM`:

```bash
DEP_ID="$(gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "/repos/${REPO}/issues/${DEP_NUM}" -q .id)"

gh api -X POST -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/${REPO}/issues/${NEW_NUM}/dependencies/blocked_by" \
  -f "issue_id=${DEP_ID}"
```

Verify:

```bash
gh api -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/${REPO}/issues/${NEW_NUM}/dependencies/blocked_by" \
  -q '.[] | {number,title,state,url}'
```

## Safety / correctness checks

- Never paste secrets into the issue body (tokens, webhook secrets, internal URLs with secrets).
- Prefer linking to files/paths over embedding huge logs.
- Dependencies: avoid creating circular dependency chains; if unsure, don’t set it automatically—mention it in the “Dependencies” section for human confirmation.

## Notes / limitations

- Dependency APIs are relatively new; if the dependency endpoints return 404, the feature may be unavailable for that repo/org. In that case, include dependencies in the body text and skip the API linking.
