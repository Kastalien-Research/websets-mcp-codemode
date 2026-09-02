project_id      = "recruiter-sourcing-502805"
region          = "us-central1"
image           = "us-central1-docker.pkg.dev/recruiter-sourcing-502805/websets-mcp/server:latest"
secret_env_keys = ["EXA_API_KEY", "WEBHOOK_BUFFER_TOKEN", "EXA_WEBHOOK_SECRET"]
# Cloud Run owns webhook ingestion: it pulls from the Cloudflare buffer.
# The local docker-compose instance must NOT also set WEBHOOK_BUFFER_URL.
webhook_buffer_url = "https://websets-webhook-buffer.websets-webhook-buffer.workers.dev"
# One-time bootstrap of the 19k-record local store; inert once the replica exists.
seed_gcs_url = "https://storage.googleapis.com/storage/v1/b/recruiter-sourcing-502805-websets-litestream/o/seed%2Fwebsets.db?alt=media"
# kastalienresearch@gmail.com resolves to the same Google identity as the
# glassBead account (IAM silently rewrites it), so only the primary is listed.
invoker_members = ["user:glassBead@kastalienresearch.ai"]
