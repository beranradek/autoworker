terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.70.0"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}

data "azurerm_client_config" "current" {}

# Derive the active LLM provider from the model string prefix so we only wire
# the Key Vault secret + env vars that the chosen provider actually needs.
locals {
  llm_provider = split("/", var.llm_model)[0]
  llm_secret_name = (
    local.llm_provider == "anthropic" ? "anthropic-api-key" :
    local.llm_provider == "azure" ? "azure-api-key" :
    "openai-api-key"
  )
  llm_env_name = (
    local.llm_provider == "anthropic" ? "ANTHROPIC_API_KEY" :
    local.llm_provider == "azure" ? "AZURE_API_KEY" :
    "OPENAI_API_KEY"
  )
  # Claude subscription auth (OpenCode OAuth) replaces the provider api-key path.
  use_subscription          = var.use_claude_subscription
  use_api_key               = !var.use_claude_subscription
  opencode_auth_secret_name = "opencode-auth-json"
  # Webhook secret is optional — only wired once the Key Vault secret exists.
  use_webhook_secret = var.enable_github_webhook_secret
}

# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "law" {
  name                = "${var.name_prefix}-law"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# ---------------------------------------------------------------------------
# Container Registry (ACR names: alphanumeric only, no hyphens)
# ---------------------------------------------------------------------------

resource "azurerm_container_registry" "acr" {
  name                = var.acr_name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Basic"
  admin_enabled       = false
}

# ---------------------------------------------------------------------------
# Managed Identity
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "autoworker" {
  name                = "${var.name_prefix}-id"
  location            = var.location
  resource_group_name = var.resource_group_name
}

# Contributor on the RG so the poller can create/start per-issue ACA Jobs.
resource "azurerm_role_assignment" "autoworker_rg_contributor" {
  scope                = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.autoworker.principal_id
}

# Pull images from ACR.
resource "azurerm_role_assignment" "autoworker_acr_pull" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.autoworker.principal_id
}

# ---------------------------------------------------------------------------
# Key Vault — secrets are set manually via `az keyvault secret set`, never
# stored in Terraform variables or tfstate.
# ---------------------------------------------------------------------------

resource "azurerm_key_vault" "kv" {
  name                      = "${var.name_prefix}-kv"
  location                  = var.location
  resource_group_name       = var.resource_group_name
  sku_name                  = "standard"
  tenant_id                 = data.azurerm_client_config.current.tenant_id
  rbac_authorization_enabled = true
}

# The identity running `terraform apply` can manage secrets in the vault.
resource "azurerm_role_assignment" "kv_admin" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

# The UAMI running the ACA Jobs can read secrets.
resource "azurerm_role_assignment" "autoworker_kv_secrets_user" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.autoworker.principal_id
}

# ---------------------------------------------------------------------------
# Container Apps Environment
# ---------------------------------------------------------------------------

resource "azurerm_container_app_environment" "cae" {
  name                       = "${var.name_prefix}-cae"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
}

# ---------------------------------------------------------------------------
# Orchestrator — always-on Container App (runs autoworker-server image in
# `serve` mode: HMAC-verified webhook receiver + in-memory FIFO queue +
# safety-net poll). Public ingress exposes POST /webhook for GitHub.
#
# Single replica only: the FIFO queue is process-local, so scaling out would
# double-process events. min == max == 1 keeps exactly one instance running.
# ---------------------------------------------------------------------------

resource "azurerm_container_app" "orchestrator" {
  name                         = "${var.name_prefix}-orchestrator"
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.cae.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.autoworker.id]
  }

  registry {
    server   = azurerm_container_registry.acr.login_server
    identity = azurerm_user_assigned_identity.autoworker.id
  }

  # Public ingress so GitHub can POST webhooks. TLS is managed by the platform
  # on the *.azurecontainerapps.io FQDN; the webhook path is /webhook.
  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  # Secrets pulled from Key Vault at runtime via the UAMI — never in tfstate.
  secret {
    name                = "github-token"
    key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/github-token"
    identity            = azurerm_user_assigned_identity.autoworker.id
  }

  dynamic "secret" {
    for_each = local.use_webhook_secret ? [1] : []
    content {
      name                = "github-webhook-secret"
      key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/github-webhook-secret"
      identity            = azurerm_user_assigned_identity.autoworker.id
    }
  }

  dynamic "secret" {
    for_each = local.use_api_key ? [1] : []
    content {
      name                = local.llm_secret_name
      key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/${local.llm_secret_name}"
      identity            = azurerm_user_assigned_identity.autoworker.id
    }
  }

  dynamic "secret" {
    for_each = local.use_subscription ? [1] : []
    content {
      name                = local.opencode_auth_secret_name
      key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/${local.opencode_auth_secret_name}"
      identity            = azurerm_user_assigned_identity.autoworker.id
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name    = "autoworker-server"
      image   = "${azurerm_container_registry.acr.login_server}/autoworker-server:latest"
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["node", "dist/cli.js", "serve"]

      # --- GitHub / repos ---
      dynamic "env" {
        for_each = var.repos != null ? [1] : []
        content {
          name  = "REPOS"
          value = var.repos
        }
      }
      dynamic "env" {
        for_each = var.repos == null && var.github_repos != null ? [1] : []
        content {
          name  = "GITHUB_REPOS"
          value = var.github_repos
        }
      }
      env {
        name        = "GITHUB_TOKEN"
        secret_name = "github-token"
      }
      dynamic "env" {
        for_each = local.use_webhook_secret ? [1] : []
        content {
          name        = "GITHUB_WEBHOOK_SECRET"
          secret_name = "github-webhook-secret"
        }
      }

      # --- Safety-net poll (relaxed; webhooks drive most work) ---
      env {
        name  = "POLL_INTERVAL_SECONDS"
        value = tostring(var.safety_poll_interval_seconds)
      }

      # --- Worker ---
      env {
        name  = "JOB_RUNNER"
        value = "aca"
      }
      env {
        name  = "WORKER_IMAGE"
        value = "${azurerm_container_registry.acr.login_server}/autoworker-worker:latest"
      }
      dynamic "env" {
        for_each = local.use_api_key ? [1] : []
        content {
          name        = local.llm_env_name
          secret_name = local.llm_secret_name
        }
      }
      dynamic "env" {
        for_each = local.use_subscription ? [1] : []
        content {
          name        = "OPENCODE_AUTH_JSON"
          secret_name = local.opencode_auth_secret_name
        }
      }
      dynamic "env" {
        for_each = local.use_api_key && local.llm_provider == "azure" ? [1] : []
        content {
          name  = "AZURE_RESOURCE_NAME"
          value = var.azure_resource_name
        }
      }
      env {
        name  = "LLM_MODEL"
        value = var.llm_model
      }

      # --- Azure runtime (derived from infra, no user input needed) ---
      env {
        name  = "ACA_ENV_NAME"
        value = azurerm_container_app_environment.cae.name
      }
      env {
        name  = "ACA_JOB_NAME"
        value = var.worker_job_name_prefix
      }
      env {
        name  = "AZURE_SUBSCRIPTION_ID"
        value = var.subscription_id
      }
      env {
        name  = "AZURE_RESOURCE_GROUP"
        value = var.resource_group_name
      }
      env {
        name  = "AZURE_LOCATION"
        value = var.location
      }
      env {
        name  = "AZURE_USE_MANAGED_IDENTITY"
        value = "true"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.autoworker.client_id
      }
      env {
        name  = "AZURE_UAMI_ID"
        value = azurerm_user_assigned_identity.autoworker.id
      }
    }
  }

  lifecycle {
    precondition {
      condition     = local.use_subscription || local.llm_provider != "azure" || var.azure_resource_name != ""
      error_message = "azure_resource_name must be set when llm_model uses the azure/ prefix."
    }
    precondition {
      condition     = !local.use_subscription || local.llm_provider == "anthropic"
      error_message = "use_claude_subscription requires an anthropic/ llm_model (e.g. anthropic/claude-...)."
    }
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "acr_login_server" {
  value       = azurerm_container_registry.acr.login_server
  description = "ACR login server — use this as the image prefix when pushing."
}

output "key_vault_name" {
  value       = azurerm_key_vault.kv.name
  description = "Key Vault name — set secrets here after first apply."
}

output "key_vault_uri" {
  value       = azurerm_key_vault.kv.vault_uri
  description = "Key Vault URI."
}

output "container_app_environment_id" {
  value = azurerm_container_app_environment.cae.id
}

output "orchestrator_app_name" {
  value = azurerm_container_app.orchestrator.name
}

output "orchestrator_fqdn" {
  value       = azurerm_container_app.orchestrator.ingress[0].fqdn
  description = "Public FQDN of the orchestrator Container App."
}

output "webhook_url" {
  value       = "https://${azurerm_container_app.orchestrator.ingress[0].fqdn}/webhook"
  description = "Set this as the Payload URL on the GitHub webhook (content type: application/json, secret: github-webhook-secret)."
}

output "secret_setup_commands" {
  value       = <<-EOT
    After applying, set the secrets in Key Vault (never committed to disk):

      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name github-token --value "YOUR_GITHUB_PAT"

    GitHub webhook secret (optional — set when ready, then re-apply with enable_github_webhook_secret=true):
      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name github-webhook-secret --value "YOUR_WEBHOOK_SECRET"

    ${local.use_subscription ?
    "Claude subscription auth (use_claude_subscription=true) — log in locally and push the\n    OpenCode credentials, instead of a provider api key:\n      scripts/opencode-auth.sh login\n      scripts/opencode-auth.sh push-azure ${azurerm_key_vault.kv.name}" :
    "Provider key for the selected model (${var.llm_model}):\n      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name ${local.llm_secret_name} --value \"YOUR_PROVIDER_KEY\"\n\n    (For azure/<deployment> models also set azure_resource_name in terraform.tfvars.)"}

    Then build and push the images:

      az acr build --registry ${azurerm_container_registry.acr.name} --image autoworker-server:latest -f docker/Dockerfile .
      az acr build --registry ${azurerm_container_registry.acr.name} --image autoworker-worker:latest -f docker/worker.Dockerfile .

    Finally, configure the GitHub webhook (repo or org Settings → Webhooks → Add webhook):
      - Payload URL:  the `webhook_url` output above
      - Content type: application/json
      - Secret:       the same value set for github-webhook-secret
      - Events:       Issues, Issue comments, Pull requests, Pull request reviews
  EOT
  description = "Next steps after terraform apply."
}
