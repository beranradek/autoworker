# Potential improvement: opencode serve mode for system/user prompt separation

Status: **suggestion only** — not implemented. Current `opencode run` approach is adequate.

---

## Problem

Both worker modes (implementation and PR review) invoke OpenCode via:

```
opencode run --format json --model <model> --dangerously-skip-permissions --dir <repo> <prompt>
```

The entire prompt — system instructions, security constraints, and untrusted user content (issue title, body, PR title, PR body) — is passed as a single flat string. True system/user message separation is not possible with `opencode run`.

Current mitigation: `<user-content>` XML tags + explicit prompt injection constraints. Adequate for the current threat model (ephemeral containers, no GitHub token inside OpenCode env).

---

## Proposed approach

Switch from `opencode run` to `opencode serve` mode, communicating via HTTP SDK/API.

### How it would work

1. **Start OpenCode as HTTP server** in the container:
   ```
   opencode serve --port <random-free-port> --print-logs
   ```

2. **Write system prompt to config file** before starting the server:
   ```
   {workspace}/.config/opencode/config.json
   → agent.default.prompt = "<system instructions + security constraints>"
   ```
   OpenCode reads this as the agent's persistent system instructions.

3. **Send user content as a user message** via HTTP API:
   ```
   POST /session/{session_id}/message
   {"parts": [{"type": "text", "text": "<issue/PR context>"}]}
   ```
   User content never touches the system prompt.

4. **Poll for completion** via `GET /session/{id}` and `GET /permission` (HIL).

5. **Read output** via `GET /session/{id}/messages`.

### What changes in the harness

- `lib/common.mjs` `spawnOpencode()` → replaced by `runOpencodeServe({ systemPrompt, userMessage, repoDir, ... })`
- New helper: find free port, spawn server, await ready, create session, send message, poll, kill server
- `lib/implement.mjs` / `lib/review.mjs`: split current single prompt string into `systemPrompt` (instructions, constraints, output schema) and `userMessage` (issue/PR context wrapped in structured JSON or plain text)

---

## Tradeoffs

### Benefits
- **True system/user separation**: system instructions and untrusted user content are distinct messages — stronger prompt injection resistance as guaranteed by the LLM's message-role handling
- **Richer interaction**: can support HIL (human-in-the-loop) permission requests mid-session, multi-turn conversation if needed

### Costs
- **Complexity**: ~300–500 lines of server lifecycle management (port detection, spawn, health-check loop, graceful shutdown), session management, polling loops — vs. current ~10 lines per mode
- **Fragility**: HTTP server startup race conditions, port conflicts, orphaned processes if harness crashes mid-session
- **Latency**: server startup adds a few seconds per worker run
- **Debugging**: two processes to inspect (harness + opencode server) instead of one
- **`opencode serve` stability**: the serve mode is less commonly used than `opencode run`; API surface may change across versions

### When this becomes worth it

- Prompt injection becomes a demonstrated attack vector (e.g., a malicious issue body successfully manipulates the agent)
- Multi-turn interaction is needed (e.g., agent asks clarifying questions)
- HIL permission gates are desired inside the worker (pausing for human approval mid-task)

