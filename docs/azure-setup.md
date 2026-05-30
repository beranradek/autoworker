# Azure setup (Terraform)

See also [`terraform/README.md`](../terraform/README.md) for all available variables.

## Deploy

From the `terraform/` directory, set the minimum variables and apply:

```bash
export TF_VAR_subscription_id="<your-subscription-id>"
export TF_VAR_resource_group_name="autoworker-rg"
export TF_VAR_location="germanywestcentral"
export TF_VAR_repos='[{"provider":"github","slug":"myorg/myrepo"}]'
terraform apply
```

## Post-deploy: set secrets in Key Vault

Secrets are never stored in Terraform vars or tfstate — set them in Key Vault after apply. Use the `secret_setup_commands` output for the exact commands:

```bash
terraform output secret_setup_commands
```

Required secrets:

| Secret | Used when |
|--------|-----------|
| `github-token` | always |
| `github-webhook-secret` | always (serve mode) |
| `api-key` | always — Bearer token for GET /api/workers and SSE stream |
| `openai-api-key` | `llm_model = "openai/..."` |
| `anthropic-api-key` | `llm_model = "anthropic/..."` |
| `azure-api-key` | `llm_model = "azure/<deployment>"` |

For `azure/<deployment>` models, also set `azure_resource_name` in `terraform.tfvars`.

## Register the webhook in GitHub

Get the URL from the Terraform output:

```bash
terraform output webhook_url
```

Then follow [docs/webhook.md](webhook.md) to register the webhook in GitHub using this URL.

## Useful `az` commands

### Orchestrator app

Show FQDN:

```bash
az containerapp show --name autoworker-orchestrator --resource-group autoworker-rg --query properties.configuration.ingress.fqdn -o tsv
```

Stream logs:

```bash
az containerapp logs show --name autoworker-orchestrator --resource-group autoworker-rg --container autoworker-server --tail 200
az containerapp logs show --name autoworker-orchestrator --resource-group autoworker-rg --container autoworker-server --follow
```

Check health/webhook status:

```bash
curl -s https://<orchestrator-fqdn>/healthz | jq .status
```

Update an env var:

```bash
az containerapp update --name autoworker-orchestrator --resource-group autoworker-rg --set-env-vars 'REPOS=[{"provider":"github","slug":"myorg/myrepo"}]'
```

### Worker jobs

The worker is not a static Container App — it's dynamically created as an ACA Job per issue with the prefix `issue-agent`.

List recent worker job executions:

```bash
az containerapp job list --resource-group autoworker-rg --query "[?starts_with(name, 'issue-agent')].{name:name, created:systemData.createdAt}" -o table
```

View logs for a specific worker job:

```bash
az containerapp job logs show --name <issue-agent-XXXXX> --resource-group autoworker-rg --container worker --follow --tail 200
```

Log Analytics (if configured):

```bash
az monitor log-analytics query --workspace <workspace-id> --analytics-query "ContainerAppConsoleLogs_CL | where ContainerName_s startswith 'issue-agent' | order by TimeGenerated desc | limit 100" --resource-group autoworker-rg --tail 200
```
