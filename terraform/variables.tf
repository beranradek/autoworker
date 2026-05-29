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
  description = "LLM model passed to the worker container (e.g. openai/gpt-5-mini, anthropic/claude-..., azure/<deployment>)."
}

variable "azure_resource_name" {
  type        = string
  default     = ""
  description = "Azure OpenAI resource name (the *.openai.azure.com subdomain, e.g. my-resource). Set when using an azure/<deployment> model; the deployment name must match the model name."
}

variable "use_claude_subscription" {
  type        = bool
  default     = false
  description = "Use a monthly Claude subscription (OpenCode OAuth) instead of an LLM API key. When true, the poller reads the `opencode-auth-json` Key Vault secret (set via scripts/opencode-auth.sh push-azure) and injects it as OPENCODE_AUTH_JSON; no provider api-key secret is wired. Requires an anthropic/ llm_model."
}

variable "safety_poll_interval_seconds" {
  type        = number
  default     = 900
  description = "Safety-net poll interval for the always-on orchestrator (seconds). Webhooks drive most work; this poll catches any missed deliveries. Work-hours gating is applied in-app via WORK_HOURS_* (defaults 08:00-21:00 Europe/Prague)."
}
