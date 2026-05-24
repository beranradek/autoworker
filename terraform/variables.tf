variable "subscription_id" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "name_prefix" {
  type    = string
  default = "autoworker"
}

variable "autoworker_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "worker_job_name_prefix" {
  type    = string
  default = "issue-agent"
}

variable "github_repos" {
  type        = string
  description = "Comma/whitespace-separated list of owner/repo entries to poll (can be a single entry)"
}

variable "github_token" {
  type      = string
  sensitive = true
}

variable "openai_api_key" {
  type      = string
  sensitive = true
}

variable "llm_model" {
  type    = string
  default = "openai/gpt-5-mini"
}

variable "poll_cron" {
  type    = string
  default = "*/2 * * * *"
}
