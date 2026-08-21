variable "project_id" {
  type        = string
  description = "GCP project to deploy into"
}

variable "region" {
  type        = string
  description = "Region for Cloud Run, Artifact Registry, and the Litestream bucket"
  default     = "us-central1"
}

variable "image" {
  type        = string
  description = "Full Artifact Registry image ref (REGION-docker.pkg.dev/PROJECT/websets-mcp/server:TAG)"
}

variable "secret_env_keys" {
  type        = list(string)
  description = "Env var names injected from Secret Manager. Each must have a secret version added via gcloud before deploy."
  default     = ["EXA_API_KEY"]
}

variable "webhook_buffer_url" {
  type        = string
  description = "Cloudflare Worker webhook buffer URL. When set, the Cloud Run instance runs the puller and owns event ingestion — make sure no local instance is also pulling."
  default     = ""
}

variable "invoker_members" {
  type        = list(string)
  description = "IAM members granted roles/run.invoker (e.g. user:you@example.com, serviceAccount:...)"
}
