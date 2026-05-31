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

variable "repos" {
  type        = string
  default     = null
  description = <<-EOT
    Preferred: JSON array of repo configs with per-repo step flags. Example:
      [{"provider":"github","slug":"myorg/myrepo","steps":["impl","review","merge"]}]
    `steps` is optional and defaults to ["impl","review"] (merge must be opted in).
    When set, takes precedence over `github_repos`.
  EOT
}

variable "github_repos" {
  type        = string
  default     = null
  description = "Deprecated: comma/whitespace-separated list of owner/repo entries. Used only when `repos` is unset; steps come from the global STEP_* env vars."

  validation {
    condition     = var.github_repos != null || var.repos != null
    error_message = "Either `repos` (preferred, JSON) or `github_repos` (deprecated) must be set."
  }
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

variable "enable_github_webhook_secret" {
  type        = bool
  default     = false
  description = "Set to true once github-webhook-secret has been stored in Key Vault. When false the GITHUB_WEBHOOK_SECRET env var is omitted and the orchestrator skips HMAC verification."
}

variable "enable_api_key" {
  type        = bool
  default     = false
  description = "Set to true once api-key has been stored in Key Vault. When true, the API_KEY env var is injected into the orchestrator and Bearer-token auth is enforced on /api/* endpoints (including the worker streaming endpoint)."
}

variable "safety_poll_interval_seconds" {
  type        = number
  default     = 900
  description = "Safety-net poll interval for the always-on orchestrator (seconds). Webhooks drive most work and run 24/7; this poll catches any missed deliveries and only runs within the work-hours window (WORK_HOURS_START/END, default 07:00-21:00) to spare cost."
}
