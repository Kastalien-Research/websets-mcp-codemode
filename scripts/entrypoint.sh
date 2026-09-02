#!/bin/sh
# Container entrypoint. When LITESTREAM_REPLICA_URL is set (Cloud Run), restore
# the SQLite shadow store from the replica before boot and run the server under
# litestream so WAL changes stream continuously to GCS. Without it (local
# docker compose), run the server directly — behavior is unchanged.
set -e

DB_PATH="${WEBSETS_DB_PATH:-/app/data/websets.db}"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  mkdir -p "$(dirname "$DB_PATH")"
  litestream restore -if-replica-exists -if-db-not-exists -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"

  # One-time seed: if the replica had nothing to restore and a seed object is
  # configured, bootstrap the database from GCS (JSON API, metadata-server
  # token). Runs only when both the replica and the local file are absent, so
  # it is inert once the replica exists.
  if [ ! -f "$DB_PATH" ] && [ -n "$WEBSETS_SEED_GCS_URL" ]; then
    echo "[entrypoint] no replica found - seeding database from $WEBSETS_SEED_GCS_URL"
    TOKEN=$(wget -qO- --header "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
      | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
    if [ -z "$TOKEN" ]; then
      echo "[entrypoint] FATAL: could not fetch metadata-server token for seeding" >&2
      exit 1
    fi
    wget -qO "$DB_PATH.seed-tmp" --header "Authorization: Bearer $TOKEN" "$WEBSETS_SEED_GCS_URL" \
      || { echo "[entrypoint] FATAL: seed download failed" >&2; exit 1; }
    mv "$DB_PATH.seed-tmp" "$DB_PATH"
    echo "[entrypoint] seeded $(wc -c < "$DB_PATH") bytes"
  fi

  exec litestream replicate -exec "node dist/index.js" "$DB_PATH" "$LITESTREAM_REPLICA_URL"
fi

exec node dist/index.js
