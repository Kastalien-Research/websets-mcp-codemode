project_id      = "recruiter-sourcing-502805"
region          = "us-central1"
image           = "us-central1-docker.pkg.dev/recruiter-sourcing-502805/websets-mcp/server:latest"
# kastalienresearch@gmail.com resolves to the same Google identity as the
# glassBead account (IAM silently rewrites it), so only the primary is listed.
invoker_members = ["user:glassBead@kastalienresearch.ai"]
