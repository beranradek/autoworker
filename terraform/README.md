# Terraform

Provisions all Azure infrastructure for Autoworker:

- Log Analytics Workspace
- Azure Container Registry (`autoworkeracr` — alphanumeric only, globally unique)
- Container Apps Environment
- User-assigned Managed Identity (Contributor on RG, AcrPull on ACR, Secrets User on Key Vault)
- Key Vault (secrets are set manually, never stored in tfstate)
- Container Apps Job (scheduled poller running `autoworker-server`)

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
| `github_repos` | Repos to poll, e.g. `myorg/myrepo` |

All other variables have sensible defaults (see `variables.tf`).

## Secrets — never in Terraform

`GITHUB_TOKEN` and `OPENAI_API_KEY` are stored in Key Vault and never touch Terraform variables or `tfstate`. Set them after the first apply:

```bash
az keyvault secret set --vault-name autoworker-kv --name github-token  --value "ghp_..."
az keyvault secret set --vault-name autoworker-kv --name openai-api-key --value "sk-..."
```

## Usage

### 1. Init and apply (creates all infra including ACR and Key Vault)

```bash
cd terraform
terraform init

export TF_VAR_subscription_id="<subscription-id>"
export TF_VAR_resource_group_name="autoworker-rg"
export TF_VAR_location="germanywestcentral"
export TF_VAR_github_repos="myorg/myrepo"

terraform apply
```

### 2. Set secrets in Key Vault (shown in terraform output `secret_setup_commands`)

```bash
az keyvault secret set --vault-name autoworker-kv --name github-token  --value "ghp_..."
az keyvault secret set --vault-name autoworker-kv --name openai-api-key --value "sk-..."
```

### 3. Build and push images to ACR

```bash
# From the repo root:
az acr build --registry autoworkeracr --image autoworker-server:latest -f docker/Dockerfile .
az acr build --registry autoworkeracr --image autoworker-worker:latest -f docker/worker.Dockerfile .
```

> `az acr build` runs the build in the Azure cloud — no local Docker required.

The poller job references `autoworkeracr.azurecr.io/autoworker-server:latest` and sets
`WORKER_IMAGE=autoworkeracr.azurecr.io/autoworker-worker:latest` for per-issue jobs automatically.

### 4. Trigger or wait for the poller

The poller runs every 2 minutes by default. To trigger manually:

```bash
az containerapp job start --name autoworker-poller --resource-group autoworker-rg
```

## Changing schedule or model

```bash
export TF_VAR_poll_cron="*/5 * * * *"
export TF_VAR_llm_model="openai/gpt-4o-mini"
terraform apply
```

## Cleanup

```bash
terraform destroy
```
