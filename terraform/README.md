# Terraform (PoC)

This module provisions Azure Container Apps Environment + a scheduled Container Apps Job to run `autoworker` periodically.

It is intentionally minimal; adapt to your subscription/resource group conventions and security baseline.

## Prereqs

- Terraform `>= 1.6`
- AzureRM provider `>= 4.70.0`
- Existing Resource Group (set via `resource_group_name`)
- `autoworker` container image published somewhere reachable by Azure Container Apps (GHCR/ACR/...)

## Inputs

Required:

- `subscription_id` – target Azure subscription id
- `resource_group_name` – existing RG name to deploy into
- `location` – Azure region (e.g. `westeurope`)
- `autoworker_image` – image for the poller (this repo)
- `worker_image` – worker image that will create PRs for accepted issues
- `github_owner`, `github_repo` – repo to poll
- `github_token` – PAT/token with access to read/write issues in the repo
- `openai_api_key` – passed through to the worker container as `OPENAI_API_KEY`

Optional:

  - `name_prefix` (default `autoworker`) – names all created resources
  - `worker_job_name_prefix` (default `autofactory-issue-agent`) – per-issue job name prefix (autoworker will create one job per accepted issue)
  - `poll_cron` (default `*/2 * * * *`) – how often the scheduled poller runs
  - `llm_model` (default `openai/gpt-5-mini`) – passed through to the worker container as `LLM_MODEL`

## Usage (example)

From `dev/autoworker/terraform/`:

```bash
terraform init

export TF_VAR_subscription_id="00000000-0000-0000-0000-000000000000"
export TF_VAR_resource_group_name="rg-autoworker"
export TF_VAR_location="westeurope"

export TF_VAR_autoworker_image="ghcr.io/beranradek/autoworker:latest"
export TF_VAR_worker_image="ghcr.io/beranradek/autoworker-opencode-agent:latest"

export TF_VAR_github_owner="beranradek"
export TF_VAR_github_repo="some-repo"

# Secrets (PoC): do NOT commit these; prefer Key Vault for real usage.
export TF_VAR_github_token="ghp_..."
export TF_VAR_openai_api_key="sk-..."

terraform plan
terraform apply
```

To change schedule/model later:

```bash
export TF_VAR_poll_cron="*/5 * * * *"
export TF_VAR_llm_model="openai/gpt-5-mini"
terraform apply
```

## What it creates

- Log Analytics Workspace
- Container Apps Environment
- User-assigned managed identity (PoC: gets Contributor on the RG)
- Container Apps Job (scheduled) that runs the `autoworker` poller

## Notes / security

- Secrets are injected as environment variables from Terraform variables (PoC). For anything beyond a PoC, prefer Key Vault + managed identity and avoid `terraform.tfstate` containing secrets.
- The identity gets RG-level Contributor for simplicity so `autoworker` can create/start per-issue jobs. Tighten permissions for real usage.

## Cleanup

```bash
terraform destroy
```
