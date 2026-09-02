output "service_url" {
  description = "Cloud Run service URL (MCP endpoint is <url>/mcp)"
  value       = google_cloud_run_v2_service.websets_mcp.uri
}

output "artifact_repo" {
  description = "Docker push target prefix"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}"
}

output "litestream_bucket" {
  description = "GCS bucket holding the SQLite replica"
  value       = google_storage_bucket.litestream.name
}

output "runtime_service_account" {
  value = google_service_account.run_sa.email
}
