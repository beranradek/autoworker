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
# Poller — scheduled ACA Job (runs autoworker-server image)
# ---------------------------------------------------------------------------

resource "azurerm_container_app_job" "poller" {
  name                         = "${var.name_prefix}-poller"
  location                     = var.location
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.cae.id

  replica_timeout_in_seconds = 900
  replica_retry_limit        = 0

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.autoworker.id]
  }

  registry {
    server   = azurerm_container_registry.acr.login_server
    identity = azurerm_user_assigned_identity.autoworker.id
  }

  # Secrets pulled from Key Vault at runtime via the UAMI — never in tfstate.
  secret {
    name                = "github-token"
    key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/github-token"
    identity            = azurerm_user_assigned_identity.autoworker.id
  }

  secret {
    name                = "openai-api-key"
    key_vault_secret_id = "${azurerm_key_vault.kv.vault_uri}secrets/openai-api-key"
    identity            = azurerm_user_assigned_identity.autoworker.id
  }

  template {
    container {
      name   = "autoworker-server"
      image  = "${azurerm_container_registry.acr.login_server}/autoworker-server:latest"
      cpu    = 0.25
      memory = "0.5Gi"

      # --- GitHub ---
      env {
        name  = "GITHUB_REPOS"
        value = var.github_repos
      }
      env {
        name        = "GITHUB_TOKEN"
        secret_name = "github-token"
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
      env {
        name        = "OPENAI_API_KEY"
        secret_name = "openai-api-key"
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
    }
  }

  schedule_trigger_config {
    cron_expression          = var.poll_cron
    parallelism              = 1
    replica_completion_count = 1
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

output "poller_job_name" {
  value = azurerm_container_app_job.poller.name
}

output "secret_setup_commands" {
  value       = <<-EOT
    After applying, set the two secrets in Key Vault (never committed to disk):

      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name github-token  --value "YOUR_GITHUB_PAT"
      az keyvault secret set --vault-name ${azurerm_key_vault.kv.name} --name openai-api-key --value "YOUR_OPENAI_KEY"

    Then build and push the images:

      az acr build --registry ${azurerm_container_registry.acr.name} --image autoworker-server:latest -f docker/Dockerfile .
      az acr build --registry ${azurerm_container_registry.acr.name} --image autoworker-worker:latest -f docker/worker.Dockerfile .
  EOT
  description = "Next steps after terraform apply."
}
