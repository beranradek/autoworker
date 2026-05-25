variable "subscription_id" {
  type        = string
  description = "Azure subscription ID."
}

variable "resource_group_name" {
  type        = string
  description = "Pre-existing resource group to deploy into."
}

variable "location" {
  type        = string
  description = "Azure region (e.g. germanywestcentral)."
}

variable "name_prefix" {
  type        = string
  default     = "autoworker"
  description = "Prefix for all created resource names."
}

variable "acr_name" {
  type        = string
  default     = "autoworkeracr"
  description = "Azure Container Registry name (alphanumeric only, globally unique)."
}

variable "github_repos" {
  type        = string
  description = "Comma/whitespace-separated list of owner/repo entries to poll (e.g. myorg/myrepo)."
}

variable "worker_job_name_prefix" {
  type        = string
  default     = "issue-agent"
  description = "Prefix for per-issue worker ACA Job names."
}

variable "llm_model" {
  type        = string
  default     = "openai/gpt-5-mini"
  description = "LLM model passed to the worker container."
}

variable "poll_cron" {
  type        = string
  default     = "*/2 5-19 * * 1-5"
  description = "Cron schedule for the poller job (default: every 2 minutes, Mon-Fri 05:00-19:59 UTC)."
}
