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
  features {}
}

data "azurerm_client_config" "current" {}

resource "azurerm_log_analytics_workspace" "law" {
  name                = "${var.name_prefix}-law"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "cae" {
  name                       = "${var.name_prefix}-cae"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
}

resource "azurerm_user_assigned_identity" "autoworker" {
  name                = "${var.name_prefix}-id"
  location            = var.location
  resource_group_name = var.resource_group_name
}

# PoC: wide permissions so the poller can create/start jobs in the RG.
resource "azurerm_role_assignment" "autoworker_rg_contributor" {
  scope                = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.autoworker.principal_id
}

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

  template {
    container {
      name   = "autoworker"
      image  = var.autoworker_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "GITHUB_REPOS"
        value = var.github_repos
      }
      env {
        name  = "WORKER_IMAGE"
        value = var.worker_image
      }
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

      # Secrets (PoC): passed directly as TF vars. Prefer Key Vault/managed identity for production.
      env {
        name  = "GITHUB_TOKEN"
        value = var.github_token
      }
      env {
        name  = "OPENAI_API_KEY"
        value = var.openai_api_key
      }
      env {
        name  = "LLM_MODEL"
        value = var.llm_model
      }
    }
  }

  schedule_trigger_config {
    cron_expression = var.poll_cron
    parallelism              = 1
    replica_completion_count = 1
  }
}

output "container_app_environment_id" {
  value = azurerm_container_app_environment.cae.id
}

output "poller_job_name" {
  value = azurerm_container_app_job.poller.name
}
