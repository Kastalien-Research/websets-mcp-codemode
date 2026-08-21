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
  exec litestream replicate -exec "node dist/index.js" "$DB_PATH" "$LITESTREAM_REPLICA_URL"
fi

exec node dist/index.js
