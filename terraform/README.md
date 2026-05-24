# Terraform (PoC)

This module provisions Azure Container Apps Environment + a scheduled Container Apps Job to run `autoworker` periodically.

It is intentionally minimal; adapt to your subscription/resource group conventions.

## Prereqs

- Terraform `>= 1.6`
- AzureRM provider `>= 4.70.0`
- Existing Resource Group (set via `resource_group_name`)
- `autoworker` container image published somewhere reachable by Azure Container Apps

## Usage (example)

From `dev/autoworker/terraform/`:

```bash
terraform init

export TF_VAR_subscription_id="00000000-0000-0000-0000-000000000000"
export TF_VAR_resource_group_name="rg-autoworker"
export TF_VAR_location="westeurope"

export TF_VAR_autoworker_image="ghcr.io/beranradek/autoworker:latest"
export TF_VAR_worker_image="ghcr.io/beranradek/autofactory/claude-agent:latest"

export TF_VAR_github_owner="beranradek"
export TF_VAR_github_repo="some-repo"

# Secrets (PoC): do NOT commit these; prefer Key Vault for real usage.
export TF_VAR_github_token="ghp_..."
export TF_VAR_anthropic_api_key="sk-ant-..."

terraform plan
terraform apply
```

## What it creates

- Log Analytics Workspace
- Container Apps Environment
- User-assigned managed identity (PoC: gets Contributor on the RG)
- Container Apps Job (scheduled) that runs the `autoworker` poller

## Notes / security

- Secrets are injected as environment variables from Terraform variables (PoC). For anything non-trivial, prefer Key Vault + managed identity.
- The identity gets RG-level Contributor for simplicity. Tighten this for real usage.
