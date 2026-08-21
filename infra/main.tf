terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.45"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- Required APIs ---------------------------------------------------------

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# --- Artifact Registry (docker image) --------------------------------------

resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = "websets-mcp"
  description   = "Websets MCP Code Mode server images"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# --- GCS bucket for Litestream replica -------------------------------------

resource "google_storage_bucket" "litestream" {
  name                        = "${var.project_id}-websets-litestream"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Litestream manages its own snapshot/WAL retention; no versioning needed.
  depends_on = [google_project_service.apis]
}

# --- Runtime service account -----------------------------------------------

resource "google_service_account" "run_sa" {
  account_id   = "websets-mcp-run"
  display_name = "Websets MCP Cloud Run runtime"
}

resource "google_storage_bucket_iam_member" "litestream_rw" {
  bucket = google_storage_bucket.litestream.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run_sa.email}"
}

# --- Secrets ---------------------------------------------------------------
# Terraform creates the secret containers only; versions (values) are added
# out-of-band via `gcloud secrets versions add` so plaintext never enters
# Terraform state. Every secret listed here must have a version before the
# Cloud Run service can start.

resource "google_secret_manager_secret" "app" {
  for_each  = toset(var.secret_env_keys)
  secret_id = "websets-mcp-${lower(replace(each.value, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "app_access" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run_sa.email}"
}

# --- Cloud Run service -----------------------------------------------------

resource "google_cloud_run_v2_service" "websets_mcp" {
  name                = "websets-mcp"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL" # IAM (run.invoker) gates access

  template {
    service_account       = google_service_account.run_sa.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    timeout               = "3600s" # long MCP execute calls + SSE

    scaling {
      min_instance_count = 0
      # Single writer: Litestream replication and the SQLite store require
      # exactly one instance. Do not raise without changing the storage design.
      max_instance_count = 1
    }

    containers {
      image = var.image

      ports {
        container_port = 7860
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # CPU stays allocated between requests so Litestream can replicate
        # in the background.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name  = "WEBSETS_DB_PATH"
        value = "/app/data/websets.db"
      }

      env {
        name  = "LITESTREAM_REPLICA_URL"
        value = "gs://${google_storage_bucket.litestream.name}/websets"
      }

      dynamic "env" {
        for_each = var.webhook_buffer_url != "" ? [var.webhook_buffer_url] : []
        content {
          name  = "WEBHOOK_BUFFER_URL"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = google_secret_manager_secret.app
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 7860
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 12
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_storage_bucket_iam_member.litestream_rw,
    google_secret_manager_secret_iam_member.app_access,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = toset(var.invoker_members)
  name     = google_cloud_run_v2_service.websets_mcp.name
  location = google_cloud_run_v2_service.websets_mcp.location
  role     = "roles/run.invoker"
  member   = each.value
}
