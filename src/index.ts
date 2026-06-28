#!/usr/bin/env node
import { createServer } from "./server.js";
import { devWorkflowsEnabled } from "./workflows/types.js";

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
