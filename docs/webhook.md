# Webhook configuration

1. **Key Vault** (Azure) — store the secret so the app can read it as
   `GITHUB_WEBHOOK_SECRET` via the managed identity:

   ```bash
   az keyvault secret set --vault-name autoworker-kv --name github-webhook-secret --value "<random-secret>"
   ```

   Locally, set `GITHUB_WEBHOOK_SECRET` in the environment or `.env`.

2. **GitHub** (repo or org Settings → Webhooks → Add webhook):

   - Payload URL: `https://<host>/webhook` (in Azure, use the `webhook_url` Terraform output)
   - Content type: `application/json`
   - Secret: the **same** value stored in Key Vault
   - Events: Issues, Issue comments, Pull requests, Pull request reviews
