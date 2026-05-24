# autoworker (PoC)

Node.js server that polls a configured GitHub repo for issues that mention `@worker` and triggers an Azure Container Apps Job run using the ephemeral AI worker image.

## Local dev

```bash
pnpm install
pnpm build
cp .env.example .env
# edit .env
pnpm start
```

## Required env vars

### GitHub

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

### Azure (service principal)

- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION` (e.g. `westeurope`)
- Either:
  - Managed Identity: `AZURE_USE_MANAGED_IDENTITY=true`
  - Service principal: `AZURE_USE_MANAGED_IDENTITY=false` + `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` + `AZURE_CLIENT_SECRET`

### Worker job

- `ACA_ENV_NAME` (Container Apps Environment name)
- `ACA_JOB_NAME` (existing manual job name)
- `WORKER_IMAGE` (container image ref)
- `ANTHROPIC_API_KEY`

## Notes

- This PoC aims to be simple (no Temporal). It focuses on idempotence and cheap operations.
- The Azure trigger strategy is “one job resource per accepted issue” (create + start). This keeps the runtime simple, but you may want a cleanup policy later.
