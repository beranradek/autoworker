# Azure OpenAI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the autoworker worker to use Azure OpenAI models (e.g. an Azure-hosted `gpt-4o` deployment) in addition to the existing OpenAI API, by threading two new optional env vars through the stack.

**Architecture:** OpenCode (the agent inside the worker container) accepts Azure OpenAI via the `azure/<deployment-name>` model string plus `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` env vars. We add these as optional fields at every layer — config validation, the type shared between runner and job-launcher, the ACA job env, the worker harness — and wire the same two vars into Terraform (Key Vault secret + poller env). When neither key is set and `DRY_RUN` is false, the existing error is preserved.

**Tech Stack:** TypeScript (Node 22, Zod for config validation), Vitest for tests, Terraform (azurerm ≥ 4.70.0), OpenCode for the inner agent loop.

---

## File Map

| File | Role |
|------|------|
| `src/job-runner/types.ts` | Shared `IssueRunInput` type — add two optional Azure fields |
| `src/config.ts` | Zod schema + validation — add two optional Azure fields, relax non-dry-run check |
| `src/job-runner/aca.ts` | ACA job creator — forward new fields into the container env |
| `src/runner/run-once.ts` | Poller — forward new config fields into `runner.runIssue()` |
| `docker/worker-harness.mjs` | Worker entrypoint — read, validate, and pass to OpenCode |
| `terraform/variables.tf` | Add `azure_openai_endpoint` variable |
| `terraform/main.tf` | Add KV secret + env vars for poller job |
| `test/config.test.ts` | Add tests for new config validation paths |

---

## Task 1: Extend the shared `IssueRunInput` type

**Files:**
- Modify: `src/job-runner/types.ts`

- [ ] **Step 1: Add the two optional fields**

Replace the contents of `src/job-runner/types.ts` with:

```typescript
export type IssueRunInput = {
  issueUrl: string;
  githubToken: string;
  openaiApiKey: string;
  azureOpenaiApiKey?: string;
  azureOpenaiEndpoint?: string;
  workerImage: string;
  correlationId: string;
  llmModel?: string;
};

export type IssueRunResult = {
  runner: "local-docker" | "aca";
  jobName?: string;
};

export interface JobRunner {
  runIssue(input: IssueRunInput): Promise<IssueRunResult>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/radek/dev/autoworker && npx tsc --noEmit
```

Expected: no errors (the new optional fields add no breaking changes).

- [ ] **Step 3: Commit**

```bash
git add src/job-runner/types.ts
git commit -m "feat: add azureOpenaiApiKey/Endpoint to IssueRunInput"
```

---

## Task 2: Extend config validation

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing tests first**

Add the following cases to the `describe("getConfig")` block in `test/config.test.ts`:

```typescript
it("accepts AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT in non-dry-run mode", () => {
  withEnv(
    {
      GITHUB_TOKEN: "x",
      GITHUB_REPOS: "o/r",
      JOB_RUNNER: "local-docker",
      WORKER_IMAGE: "img",
      AZURE_OPENAI_API_KEY: "az-key",
      AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com"
    },
    () => {
      const cfg = getConfig();
      expect(cfg.AZURE_OPENAI_API_KEY).toBe("az-key");
      expect(cfg.AZURE_OPENAI_ENDPOINT).toBe("https://my-resource.openai.azure.com");
    }
  );
});

it("throws when neither OPENAI_API_KEY nor AZURE_OPENAI_API_KEY is set in non-dry-run mode", () => {
  withEnv(
    {
      GITHUB_TOKEN: "x",
      GITHUB_REPOS: "o/r",
      JOB_RUNNER: "local-docker",
      WORKER_IMAGE: "img"
    },
    () => {
      expect(() => getConfig()).toThrow(/OPENAI_API_KEY/);
    }
  );
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/radek/dev/autoworker && npx vitest run test/config.test.ts
```

Expected: the two new tests FAIL (config doesn't know about Azure vars yet).

- [ ] **Step 3: Update the Zod schema and validation in `src/config.ts`**

Add two fields to the `schema` object (after the existing `OPENAI_API_KEY` line):

```typescript
  OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
```

Then replace the existing non-dry-run guard (lines ~76–80):

```typescript
  if (!parsed.data.DRY_RUN) {
    if (!parsed.data.WORKER_IMAGE) {
      throw new Error("Worker config missing: provide WORKER_IMAGE (or set DRY_RUN=true for claim-only mode)");
    }
    const hasOpenAiKey = Boolean(parsed.data.OPENAI_API_KEY);
    const hasAzureKey = Boolean(parsed.data.AZURE_OPENAI_API_KEY && parsed.data.AZURE_OPENAI_ENDPOINT);
    if (!hasOpenAiKey && !hasAzureKey) {
      throw new Error(
        "Worker config missing: provide OPENAI_API_KEY, or both AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT (or set DRY_RUN=true for claim-only mode)"
      );
    }
  }
```

Also update the exported `Config` type alias at the bottom to expose the two new fields:

```typescript
export type Config = Omit<RawConfig, "GITHUB_TOKEN" | "OPENAI_API_KEY"> & {
  GITHUB_TOKEN: string;
  OPENAI_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_ENDPOINT?: string;
};
```

- [ ] **Step 4: Run tests — all should pass**

```bash
cd /home/radek/dev/autoworker && npx vitest run test/config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: TypeScript compile check**

```bash
cd /home/radek/dev/autoworker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: support AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT in config"
```

---

## Task 3: Forward Azure vars through the ACA job runner

**Files:**
- Modify: `src/job-runner/aca.ts`
- Modify: `src/runner/run-once.ts`

- [ ] **Step 1: Update `aca.ts` to pass the new env vars**

In `src/job-runner/aca.ts`, update the `env` block inside `createManualJob` (around line 52):

```typescript
      env: {
        GH_TOKEN: input.githubToken,
        GITHUB_TOKEN: input.githubToken,
        OPENAI_API_KEY: input.openaiApiKey,
        ...(input.azureOpenaiApiKey ? { AZURE_OPENAI_API_KEY: input.azureOpenaiApiKey } : {}),
        ...(input.azureOpenaiEndpoint ? { AZURE_OPENAI_ENDPOINT: input.azureOpenaiEndpoint } : {}),
        LLM_MODEL: input.llmModel ?? "openai/gpt-5-mini",
        ISSUE_URL: input.issueUrl
      }
```

- [ ] **Step 2: Update `run-once.ts` to forward the new config fields**

In `src/runner/run-once.ts`, update the `runner.runIssue({...})` call (around line 125):

```typescript
        runner
          .runIssue({
            issueUrl,
            githubToken: cfg.GITHUB_TOKEN,
            openaiApiKey: cfg.OPENAI_API_KEY!,
            azureOpenaiApiKey: cfg.AZURE_OPENAI_API_KEY,
            azureOpenaiEndpoint: cfg.AZURE_OPENAI_ENDPOINT,
            workerImage: cfg.WORKER_IMAGE!,
            correlationId,
            llmModel: cfg.LLM_MODEL
          })
```

- [ ] **Step 3: TypeScript compile check**

```bash
cd /home/radek/dev/autoworker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
cd /home/radek/dev/autoworker && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/job-runner/aca.ts src/runner/run-once.ts
git commit -m "feat: forward Azure OpenAI vars into ACA worker job env"
```

---

## Task 4: Update the worker harness

**Files:**
- Modify: `docker/worker-harness.mjs`

- [ ] **Step 1: Read and forward the new env vars to OpenCode**

In `docker/worker-harness.mjs`, replace the `main()` function preamble (lines ~117–121):

```js
  const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
  const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
  const LLM_MODEL = process.env.LLM_MODEL || "openai/gpt-5-mini";

  if (!OPENAI_API_KEY && !AZURE_OPENAI_API_KEY) die("OPENAI_API_KEY or AZURE_OPENAI_API_KEY is required");
  if (AZURE_OPENAI_API_KEY && !AZURE_OPENAI_ENDPOINT) die("AZURE_OPENAI_ENDPOINT is required when AZURE_OPENAI_API_KEY is set");
```

Then extend `opencodeEnv` (around line 256) to include the Azure vars conditionally:

```js
  const opencodeEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    TMPDIR: process.env.TMPDIR,
    CI: process.env.CI,
    CHROME_BIN: process.env.CHROME_BIN,
    OPENAI_API_KEY: OPENAI_API_KEY || undefined,
    AZURE_OPENAI_API_KEY: AZURE_OPENAI_API_KEY || undefined,
    AZURE_OPENAI_ENDPOINT: AZURE_OPENAI_ENDPOINT || undefined,
    LLM_MODEL
  };
```

- [ ] **Step 2: Run tests (harness is not unit-tested; verify TypeScript still compiles)**

```bash
cd /home/radek/dev/autoworker && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add docker/worker-harness.mjs
git commit -m "feat: pass Azure OpenAI vars to OpenCode in worker harness"
```

---

## Task 5: Update Terraform

**Files:**
- Modify: `terraform/variables.tf`
- Modify: `terraform/main.tf`

> These are infrastructure-only changes. No unit tests exist for Terraform in this repo. Validate with `terraform validate`.

- [ ] **Step 1: Add the new variable to `terraform/variables.tf`**

Append after the existing `llm_model` variable:

```hcl
variable "azure_openai_endpoint" {
  type        = string
  default     = ""
  description = "Azure OpenAI endpoint URL (e.g. https://my-resource.openai.azure.com). Set when using an Azure-hosted model."
}
```

- [ ] **Step 2: Add the Key Vault secret block in `terraform/main.tf`**

After the existing `openai-api-key` secret block (around line 140–144), add:

```hcl
  secret {
    name                = "azure-openai-api-key"
    key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/azure-openai-api-key"
    identity            = azurerm_user_assigned_identity.autoworker.id
  }
```

- [ ] **Step 3: Add the env vars to the poller container in `terraform/main.tf`**

After the existing `OPENAI_API_KEY` env block (around line 172–175), add:

```hcl
      env {
        name        = "AZURE_OPENAI_API_KEY"
        secret_name = "azure-openai-api-key"
      }
      env {
        name  = "AZURE_OPENAI_ENDPOINT"
        value = var.azure_openai_endpoint
      }
```

- [ ] **Step 4: Update the `secret_setup_commands` output to mention the new secret**

Replace the existing `secret_setup_commands` output value (around line 252–264):

```hcl
output "secret_setup_commands" {
  value       = <<-EOT
    After applying, set secrets in Key Vault (never committed to disk):

      # Required
      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name github-token  --value "YOUR_GITHUB_PAT"

      # Choose one LLM provider:
      # Option A — OpenAI API
      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name openai-api-key --value "YOUR_OPENAI_KEY"
      # Option B — Azure OpenAI (also set azure_openai_endpoint in terraform.tfvars)
      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name azure-openai-api-key --value "YOUR_AZURE_OPENAI_KEY"

    Then build and push the images:

      az acr build --registry ${azurerm_container_registry.acr.name} --image autoworker-server:latest -f docker/Dockerfile .
      az acr build --registry ${azurerm_container_registry.acr.name} --image autoworker-worker:latest -f docker/worker.Dockerfile .
  EOT
  description = "Next steps after terraform apply."
}
```

- [ ] **Step 5: Validate Terraform**

```bash
cd /home/radek/dev/autoworker/terraform && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
git add terraform/variables.tf terraform/main.tf
git commit -m "feat: add Azure OpenAI Key Vault secret and env vars to Terraform"
```

---

## Usage After Deployment

To switch to an Azure OpenAI deployment named `gpt-4o-prod`:

1. In `terraform/terraform.tfvars`:
   ```hcl
   llm_model             = "azure/gpt-4o-prod"
   azure_openai_endpoint = "https://my-resource.openai.azure.com"
   ```
2. Set the secret:
   ```bash
   az keyvault secret set --vault-name <kv-name> --name azure-openai-api-key --value "YOUR_KEY"
   ```
3. `terraform apply`

The existing `openai-api-key` secret can be left empty — the validation only requires one of the two key strategies.
