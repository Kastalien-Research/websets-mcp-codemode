#!/usr/bin/env node
import { createServer } from "./server.js";
import { resolveExaApiKey } from "./config.js";
import { devWorkflowsEnabled } from "./workflows/types.js";
import { startWebhookPuller } from "./webhooks/puller.js";

const defaultCompatModeRaw = process.env.MANAGE_WEBSETS_DEFAULT_COMPAT_MODE;
const defaultCompatMode = defaultCompatModeRaw === 'safe' ? 'safe' : 'strict';
if (
  defaultCompatModeRaw !== undefined &&
  defaultCompatModeRaw !== 'safe' &&
  defaultCompatModeRaw !== 'strict'
) {
  console.warn(
    `Invalid MANAGE_WEBSETS_DEFAULT_COMPAT_MODE="${defaultCompatModeRaw}". Using "strict".`,
  );
}

if (!process.env.EXA_WEBHOOK_SECRET) {
  console.warn(
    'NOTE: EXA_WEBHOOK_SECRET is not set. Per-webhook secrets captured at '
    + 'webhooks.create time will be used for signature verification; until at '
    + 'least one webhook is registered, POST /webhooks/exa accepts unsigned '
    + 'payloads.',
  );
}

if (devWorkflowsEnabled()) {
  console.warn(
    'WARNING: WEBSETS_ENABLE_DEV_WORKFLOWS=1 — dev/demo workflows (webhook.inject, '
    + 'semantic.cron.replay) are registered. They inject synthetic events into the '
    + 'live event bus (persist + receiver rules + SSE). Do not enable in production.',
  );
}

let exaApiKey: string;
try {
  const resolved = resolveExaApiKey(process.env);
  exaApiKey = resolved.apiKey;
  if (resolved.warning) console.warn(resolved.warning);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { app } = createServer({
  exaApiKey,
  defaultCompatMode,
  webhookSecret: process.env.EXA_WEBHOOK_SECRET,
});

const PORT = process.env.PORT || 7860;

app.listen(PORT, () => {
  console.log(`Websets MCP Server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});

// Optional durable ingest path: pull buffered deliveries from the Cloudflare
// Worker instead of relying on this box being publicly reachable. Both paths can
// run at once — POST /webhooks/exa stays live for direct delivery.
const bufferUrl = process.env.WEBHOOK_BUFFER_URL;
const pullToken = process.env.WEBHOOK_BUFFER_TOKEN;
if (bufferUrl && pullToken) {
  const pollMsRaw = Number(process.env.WEBHOOK_BUFFER_POLL_MS);
  startWebhookPuller({
    bufferUrl,
    pullToken,
    pollMs: Number.isFinite(pollMsRaw) && pollMsRaw > 0 ? pollMsRaw : undefined,
    envSecret: process.env.EXA_WEBHOOK_SECRET,
  });
} else if (bufferUrl || pullToken) {
  console.warn(
    'NOTE: webhook buffer puller not started — WEBHOOK_BUFFER_URL and '
    + 'WEBHOOK_BUFFER_TOKEN must both be set.',
  );
}
