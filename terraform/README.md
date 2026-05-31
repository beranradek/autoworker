# Terraform

Provisions all Azure infrastructure for Autoworker:

- Log Analytics Workspace
- Azure Container Registry (`autoworkeracr` — alphanumeric only, globally unique)
- Container Apps Environment
- User-assigned Managed Identity (Contributor on RG, AcrPull on ACR, Secrets User on Key Vault)
- Key Vault (secrets are set manually, never stored in tfstate)
- Container App (always-on orchestrator running `autoworker-server` in `serve` mode, with public HMAC-verified webhook ingress)

## Prerequisites

- Terraform `>= 1.6`
- AzureRM provider `>= 4.70.0`
- Pre-existing Resource Group
- Azure CLI authenticated (`az login`)

## Required inputs

| Variable | Description |
|----------|-------------|
| `subscription_id` | Azure subscription ID |
| `resource_group_name` | Pre-existing resource group name |
| `location` | Azure region (e.g. `germanywestcentral`) |
| `repos` | Repos to handle as a JSON array, e.g. `[{"provider":"github","slug":"myorg/myrepo"}]`. Per-repo `steps` (subset of `impl`, `review`, `merge`) default to `["impl","review"]` when omitted. |
| `github_repos` | **Deprecated.** Comma/whitespace-separated `owner/repo` list. Used when `repos` is unset; steps come from the global `STEP_*` env vars. Either `repos` or `github_repos` must be set. |

All other variables have sensible defaults (see `variables.tf`).

## Secrets — never in Terraform

`GITHUB_TOKEN`, the GitHub webhook secret, plus the LLM provider key are stored in Key Vault and never touch Terraform variables or `tfstate`. The provider — and therefore the secret name — is derived from the `llm_model` prefix:

| `llm_model` prefix | Key Vault secret | Extra |
|--------------------|------------------|-------|
| `openai/`    | `openai-api-key`    | — |
| `anthropic/` | `anthropic-api-key` | — |
| `azure/`     | `azure-api-key`     | also set `azure_resource_name` (the `*.openai.azure.com` subdomain; deployment name must match the model name) |

Set them after the first apply (see the `secret_setup_commands` output for the exact name):

```bash
az keyvault secret set --vault-name autoworker-kv --name github-token   --value "ghp_..."
az keyvault secret set --vault-name autoworker-kv --name openai-api-key --value "sk-..."   # or anthropic-api-key / azure-api-key
```

`github-webhook-secret` is optional — see step 2 below.

## Usage

### 1. Init and apply (creates all infra including ACR and Key Vault)

```bash
cd terraform
terraform init

export TF_VAR_subscription_id="<subscription-id>"
export TF_VAR_resource_group_name="autoworker-rg"
export TF_VAR_location="germanywestcentral"
export TF_VAR_repos='[{"provider":"github","slug":"myorg/myrepo"}]'

# Select correct Azure subscription:
az account set --subscription <subscription-id>

terraform apply
```

### 2. Set secrets in Key Vault (shown in terraform output `secret_setup_commands`)

```bash
az keyvault secret set --vault-name autoworker-kv --name github-token   --value "ghp_..."
az keyvault secret set --vault-name autoworker-kv --name openai-api-key --value "sk-..."   # or anthropic-api-key / azure-api-key
```

The GitHub webhook secret is **optional at first apply**. Set it when you're ready, then re-apply with the flag to wire it in:

```bash
az keyvault secret set --vault-name autoworker-kv --name github-webhook-secret --value "<random-secret>"
terraform apply -var="enable_github_webhook_secret=true"
```

### 3. Build and push images to ACR

```bash
# From the repo root:
az acr build --registry autoworkeracr --image autoworker-server:latest -f docker/Dockerfile .
az acr build --registry autoworkeracr --image autoworker-worker:latest -f docker/worker.Dockerfile .
```

> `az acr build` runs the build in the Azure cloud — no local Docker required.

The orchestrator app references `autoworkeracr.azurecr.io/autoworker-server:latest` and sets
`WORKER_IMAGE=autoworkeracr.azurecr.io/autoworker-worker:latest` for per-issue jobs automatically.

After rebuilding the orchestrator image, force the Container App to pull it by creating a new revision:

```bash
az containerapp update --name autoworker-orchestrator --resource-group autoworker-rg \
  --image autoworkeracr.azurecr.io/autoworker-server:latest
```

> `az containerapp revision restart` does **not** pull a new image — use `az containerapp update` instead.

IMPORTANT:

terraform apply will validate secrets in key vault and container images already exist so create the secrets and images
and then run `terraform apply` again. 

### 4. Register the GitHub webhook

Take the `webhook_url` output and add it as a webhook (repo or org Settings → Webhooks):

- Payload URL: the `webhook_url` output
- Content type: `application/json`
- Secret: the same value set for `github-webhook-secret`
- Events: Issues, Issue comments, Pull requests, Pull request reviews

The orchestrator reacts to events immediately and also runs a safety-net poll
(see `safety_poll_interval_seconds`, default 900s) to catch any missed delivery.

## API key for the worker streaming endpoint

The orchestrator exposes `/api/*` endpoints (worker list, SSE streaming) protected by Bearer-token auth. The `/api/*` endpoints **always reject unauthenticated requests** — even when `API_KEY` is not configured — so they are never accidentally public.

To enable authenticated access:

**1. Generate a key and store it in Key Vault:**

```bash
openssl rand -hex 32   # copy the output
az keyvault secret set --vault-name autoworker-kv --name api-key --value "<generated-key>"
```

**2. Wire it into the Container App:**

```bash
terraform apply -var="enable_api_key=true"
```

**3. Use it:**

```bash
# List active workers
curl -H "Authorization: Bearer <key>" https://<orchestrator-fqdn>/api/workers

# Stream events for a worker
curl -H "Authorization: Bearer <key>" https://<orchestrator-fqdn>/api/workers/<id>/stream
```

The `enable_api_key` variable defaults to `false`. When false, the `API_KEY` env var is omitted from the Container App and every `/api/*` request returns 401.

## Changing poll interval or model

```bash
export TF_VAR_safety_poll_interval_seconds="600"
export TF_VAR_llm_model="openai/gpt-4o-mini"
terraform apply
```

To switch provider, change `llm_model` and set the matching Key Vault secret. Example for Azure OpenAI:

```bash
export TF_VAR_llm_model="azure/gpt-4o"            # deployment name must be "gpt-4o"
export TF_VAR_azure_resource_name="my-resource"   # the my-resource.openai.azure.com subdomain
terraform apply
az keyvault secret set --vault-name autoworker-kv --name azure-api-key --value "<AZURE_API_KEY>"
```

## Cleanup

```bash
terraform destroy
```
