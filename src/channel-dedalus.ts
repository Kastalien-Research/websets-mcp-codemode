#!/usr/bin/env node
// Channel bridge: connects to a Websets MCP server running on a Dedalus
// workspace and pushes events into the Claude Code session.
//
// Two event sources:
//   1. WebSocket terminal — real-time server stdout (logs, errors, status)
//   2. SSE via preview URL — Exa webhook events (items, enrichments, candidates)
//
// Two reply tools:
//   1. execute_in_workspace — run shell commands in the workspace
//   2. call_websets_server — call the websets MCP server's execute tool
//
// Claude Code spawns this as a subprocess via .mcp.json:
//   "websets-channel": {
//     "command": "node",
//     "args": ["dist/channel-dedalus.js"],
//     "env": {
//       "DEDALUS_API_KEY": "${DEDALUS_API_KEY}",
//       "DEDALUS_WORKSPACE_ID": "<workspace_id>",
//       "WEBSETS_PREVIEW_URL": "<preview_url>"
//     }
//   }
//
// Start Claude Code with:
//   claude --dangerously-load-development-channels server:websets-channel

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Dedalus from 'dedalus';

const WORKSPACE_ID = requireEnv('DEDALUS_WORKSPACE_ID');
const PREVIEW_URL = requireEnv('WEBSETS_PREVIEW_URL');
const RECONNECT_DELAY_MS = 5_000;
const EXEC_POLL_INTERVAL_MS = 1_000;

const dedalus = new Dedalus();

const channel = new Server(
  { name: 'websets-channel', version: '2.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `You are connected to the Websets MCP server running on a Dedalus workspace.

Events arrive as:
<channel source="websets-channel" event_type="..." ...>
  { payload }
</channel>

## Event types

### server_output
Real-time stdout from the websets server process. Watch for startup messages,
webhook receipts, errors, and status changes.

### NEW_OPPORTUNITY_CANDIDATE
Scored company candidate from the design-partner radar:
- **claim_and_research** (score >= 10): High-priority. Run research workflow immediately.
- **queue_for_review** (score 7-9): Log for user review. Summarize lens hits and score.
- **monitor** (score < 7): Log briefly. No action unless user asks.

### webset.item.created / webset.item.enriched
Raw item events. Research the entity:
1. Use call_websets_server to run exa.search, exa.getContents, exa.findSimilar
2. Annotate via store.annotate with judgment and research findings
3. Synthesize and report to user

### webset.idle
Webset finished populating. Report to user, run store.listUninvestigated
and store.listCandidates to show pipeline status.

## Reply tools

- **execute_in_workspace**: Run a shell command in the Dedalus workspace
- **call_websets_server**: Run JS code with callOperation() on the websets server

## Key operations (via call_websets_server)

- exa.search(query, opts) — web search with filters
- exa.findSimilar(url) — find similar pages
- exa.getContents(urls) — extract content from URLs
- exa.answer(query) — question answering with citations
- store.annotate(itemId, type, value) — annotate item
- store.getItem(itemId) — get item with annotations
- store.listUninvestigated(websetId?) — items needing research
- store.upsertCompany(domain, name) — create/update company
- store.getCompany(domain) — company with lens hits, score, verdict
- store.listCandidates(minScore?, verdict?) — list candidates`,
  },
);

// --- Reply tools ---

channel.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute_in_workspace',
      description:
        'Run a shell command in the Dedalus workspace where the websets server runs',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command and arguments, e.g. ["ls", "-la", "/app"]',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 30000)',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'call_websets_server',
      description:
        'Run JS code with callOperation() on the websets MCP server. ' +
        'Write code exactly as you would for the execute tool.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'JS code using callOperation(). Example: ' +
              'const results = await callOperation("exa.search", ' +
              '{ query: "AI startups", numResults: 5 }); return results;',
          },
        },
        required: ['code'],
      },
    },
  ],
}));

channel.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'execute_in_workspace') {
    const { command, timeout_ms } = args as {
      command: string[];
      timeout_ms?: number;
    };
    const exec = await dedalus.workspaces.executions.create(WORKSPACE_ID, {
      command,
      timeout_ms: timeout_ms ?? 30_000,
    });
    const result = await waitForExecution(exec.execution_id);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: result.status === 'failed',
    };
  }

  if (name === 'call_websets_server') {
    const { code } = args as { code: string };
    try {
      const res = await fetch(`${PREVIEW_URL}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'execute', arguments: { code } },
          id: 1,
        }),
      });
      if (!res.ok) {
        return {
          content: [{
            type: 'text',
            text: `Server returned ${res.status}: ${await res.text()}`,
          }],
          isError: true,
        };
      }
      const body = await res.json();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(body.result ?? body, null, 2),
        }],
        isError: !!body.error,
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Failed to reach websets server: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Connect and start event sources ---

await channel.connect(new StdioServerTransport());

// Run event sources concurrently — both reconnect independently on failure
watchTerminalOutput();
subscribeWebhookSSE();


// --- Event source 1: WebSocket terminal for real-time server output ---

async function watchTerminalOutput(): Promise<void> {
  // Dynamic import — ws may not be installed in all environments
  const { default: WS } = await import('ws');

  while (true) {
    try {
      // Find or create a terminal session
      const terminals = [];
      for await (const t of dedalus.workspaces.terminals.list(WORKSPACE_ID)) {
        if (t.status === 'ready') terminals.push(t);
      }

      let terminalId: string;
      if (terminals.length > 0) {
        terminalId = terminals[0].terminal_id;
      } else {
        const terminal = await dedalus.workspaces.terminals.create(
          WORKSPACE_ID,
          { height: 24, width: 120 },
        );
        terminalId = terminal.terminal_id;
      }

      // Build WebSocket URL from the client's base
      const baseUrl = dedalus.baseURL.replace(/^http/, 'ws');
      const wsUrl = `${baseUrl}/v1/workspaces/${WORKSPACE_ID}/terminals/${terminalId}/connect`;

      const headers: Record<string, string> = {};
      if (dedalus.apiKey) headers['Authorization'] = `Bearer ${dedalus.apiKey}`;
      if (dedalus.xAPIKey) headers['x-api-key'] = dedalus.xAPIKey;

      const ws = new WS(wsUrl, { headers });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
      });

      ws.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'output' && event.data) {
            await channel.notification({
              method: 'notifications/claude/channel',
              params: {
                content: event.data,
                meta: {
                  event_type: 'server_output',
                  workspace_id: WORKSPACE_ID,
                },
              },
            });
          }
        } catch {
          // Skip unparseable frames
        }
      });

      // Wait for close
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
    } catch {
      // Reconnect
    }

    await sleep(RECONNECT_DELAY_MS);
  }
}


// --- Event source 2: SSE from the websets server's webhook stream ---

async function subscribeWebhookSSE(): Promise<void> {
  const sseUrl = `${PREVIEW_URL}/webhooks/events`;

  while (true) {
    try {
      const response = await fetch(sseUrl);
      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                await pushWebhookNotification(event);
              } catch {
                // Skip malformed events
              }
            }
          }
        }
      }
    } catch {
      // Reconnect
    }

    await sleep(RECONNECT_DELAY_MS);
  }
}


// --- Notification formatting (same as current channel.ts) ---

async function pushWebhookNotification(event: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const data = (event.payload?.data ?? {}) as Record<string, unknown>;
  const props = (data.properties ?? {}) as Record<string, unknown>;

  const company = props.company as Record<string, unknown> | undefined;
  const person = props.person as Record<string, unknown> | undefined;
  const article = props.article as Record<string, unknown> | undefined;
  const custom = props.custom as Record<string, unknown> | undefined;

  const entityName = (
    company?.name ?? person?.name ?? article?.title ??
    custom?.title ?? props.description ?? ''
  ) as string;

  const enrichments = (data.enrichments as Array<Record<string, unknown>> | undefined)
    ?.filter((e) => e.status === 'completed' && (e.result as unknown[] | null)?.length)
    ?.map((e) => ({
      description: e.description ?? e.enrichmentId ?? 'unknown',
      value: (e.result as unknown[])[0],
    }))
    ?? [];

  const content = JSON.stringify({
    item: {
      id: data.id ?? null,
      name: entityName,
      url: (props.url ?? data.url ?? '') as string,
      entityType: (props.type ?? 'unknown') as string,
    },
    enrichments,
    evaluations: data.evaluations ?? [],
  }, null, 2);

  const websetId = (data.websetId ?? data.id ?? '') as string;

  await channel.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        event_type: event.type,
        webset_id: websetId,
        entity_name: entityName,
        event_id: event.id,
      },
    },
  });
}


// --- Utilities ---

async function waitForExecution(executionId: string): Promise<{
  status: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}> {
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
  while (true) {
    const exec = await dedalus.workspaces.executions.retrieve(executionId, {
      workspace_id: WORKSPACE_ID,
    });
    if (terminal.has(exec.status)) {
      const output = await dedalus.workspaces.executions.output(executionId, {
        workspace_id: WORKSPACE_ID,
      });
      return {
        status: exec.status,
        exit_code: exec.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
      };
    }
    await sleep(EXEC_POLL_INTERVAL_MS);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
