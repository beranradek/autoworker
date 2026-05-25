# Autoworker — Azure Deployment Plan

**Status:** Ready for Execution

---

## Context

| Field | Value                                                        |
|-------|--------------------------------------------------------------|
| Mode | MODIFY (Terraform already existed in `terraform/`; extended) |
| Subscription | <Subscription name> — `<subscription-id>`                    |
| Resource Group | `autoworker-rg` (pre-existing)                               |
| Region | `<region-code>`                                              |
| Recipe | Terraform (extended in place)                                |

---

## Architecture

```
GitHub Issues
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Azure Container Apps Environment (autoworker-cae)          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ACA Job (Scheduled, */2 * * * *)  — Poller          │   │
│  │  image: autoworkeracr.azurecr.io/autoworker-server   │   │
│  │  identity: autoworker-id (UAMI)                      │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │  creates per-issue               │
│                          ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ACA Job (Manual, per accepted issue) — Worker       │   │
│  │  image: autoworkeracr.azurecr.io/autoworker-worker   │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
     │ pull images                     │ read secrets
     ▼                                 ▼
┌──────────────────┐         ┌───────────────────┐
│  ACR             │         │  Key Vault         │
│  autoworkeracr   │         │  autoworker-kv     │
│  (Basic SKU)     │         │  github-token      │
└──────────────────┘         │  openai-api-key    │
                             └───────────────────┘
```

**Managed Identity** (`autoworker-id`) gets:
- `Contributor` on `autoworker-rg` — create/start per-issue ACA Jobs
- `AcrPull` on `autoworkeracr` — pull container images
- `Key Vault Secrets User` on `autoworker-kv` — read secrets at runtime

---

## Image Names

| Image | ACR Tag |
|-------|---------|
| Poller (this repo) | `autoworkeracr.azurecr.io/autoworker-server:latest` |
| Worker (OpenCode + tools) | `autoworkeracr.azurecr.io/autoworker-worker:latest` |

> ACR names are alphanumeric-only (no hyphens). `autoworkeracr` is confirmed available.

---

## Secrets Strategy

Secrets **never** appear in Terraform variables, `terraform.tfvars`, or `terraform.tfstate`.

| Secret | Storage | How consumed |
|--------|---------|--------------|
| `GITHUB_TOKEN` | Key Vault secret `github-token` | ACA Job secret ref via UAMI |
| `OPENAI_API_KEY` | Key Vault secret `openai-api-key` | ACA Job secret ref via UAMI |

Set manually after first apply:
```bash
az keyvault secret set --vault-name autoworker-kv --name github-token  --value "ghp_..."
az keyvault secret set --vault-name autoworker-kv --name openai-api-key --value "sk-..."
```

---

## Minimum Required Inputs

Only 4 variables needed — everything else has defaults: 
subscription_id, resource_group_name, location (region code), github_repos

---

## Execution Steps

### Step 1 — Infra (already done: Terraform extended)

Files changed:
- `terraform/main.tf` — Added ACR, KV, role assignments, KV secret refs in ACA Job
- `terraform/variables.tf` — Removed secret vars, added `acr_name`
- `terraform/README.md` — Updated docs
- `README.md` — Updated image names and Azure setup section

### Step 2 — terraform init + apply

```bash
cd terraform
terraform init

export TF_VAR_subscription_id="<subscription-id>"
export TF_VAR_resource_group_name="autoworker-rg"
export TF_VAR_location="<region-code>"
export TF_VAR_github_repos="myorg/myrepo"

# Select correct Azure subscription:
az account set --subscription <subscription-id>

terraform apply
```

### Step 3 — Set secrets in Key Vault

```bash
az keyvault secret set --vault-name autoworker-kv --name github-token  --value "ghp_..."
az keyvault secret set --vault-name autoworker-kv --name openai-api-key --value "sk-..."
```

### Step 4 — Build and push images

```bash
# From repo root:
az acr build --registry autoworkeracr --imageautoworker-server:latest -f docker/Dockerfile .
az acr build --registry autoworkeracr --image autoworker-worker:latest -f docker/worker.Dockerfile .
```

### Step 5 — Verify

```bash
# Check poller job logs (runs every 2 min, or trigger manually):
az containerapp job start --name autoworker-poller --resource-group autoworker-rg
az containerapp job execution list --name autoworker-poller --resource-group autoworker-rg
az containerapp job execution list --name autoworker-poller --resource-group autoworker-rg --output table
```

---

## Files Modified

| File | Change |
|------|--------|
| `terraform/main.tf` | Added ACR, KV, role assignments; KV secret refs; removed plaintext secrets |
| `terraform/variables.tf` | Removed `github_token`, `openai_api_key`; added `acr_name` |
| `terraform/README.md` | Rewritten for new workflow |
| `README.md` | Updated image names and Azure section |
| `.azure/deployment-plan.md` | This file |
