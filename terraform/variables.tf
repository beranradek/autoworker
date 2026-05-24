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
  default = "autofactory-issue-agent"
}

variable "github_owner" {
  type = string
}

variable "github_repo" {
  type = string
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
