---
name: channel-bridge
description: >
  Design and implement Claude Code channel bridges to remote MCP servers running on cloud
  platforms (Dedalus, etc). Use this skill when the user wants to: connect a Claude Code
  session to a remote server via a channel, deploy an MCP server to a cloud workspace,
  build a two-way channel with reply tools, bridge webhook/execution events from a remote
  environment back into Claude Code, or split a server into local channel + remote execution.
  Also use when the user mentions "channel to remote server", "Dedalus channel", "deploy
  MCP server to workspace", or "event bridge to Claude Code".
---

# Channel Bridge: Local Channel ↔ Remote MCP Server

> Channels are in research preview and require Claude Code v2.1.80+. They require
> claude.ai login — Console and API key authentication is not supported. Team and
> Enterprise organizations must explicitly enable them via `channelsEnabled` managed
> setting.

## What This Pattern Is

A channel bridge splits an MCP server into two parts:

1. **Channel (local)**: A thin stdio MCP server that Claude Code spawns as a subprocess.
   It declares `claude/channel` capability and pushes notifications into the session.
2. **Server (remote)**: The full MCP server running on cloud infrastructure (Dedalus
   workspace, Docker, etc). It does the real work — API calls, data storage, workflows.

The channel is the **local proxy** that bridges Claude Code to the remote server. It
communicates with the server over HTTPS (API calls, preview URLs, SSE streams).

```
┌─ User's machine ─────────────────────────────┐
│                                               │
│  Claude Code ←──stdio──→ channel.ts           │
│                            │                  │
│                            │ HTTPS            │
│                            ▼                  │
└────────────────────────────┼──────────────────┘
                             │
┌─ Cloud workspace ──────────┴──────────────────┐
│                                               │
│  MCP server (Express/Hono on :PORT)           │
│  Preview URL exposes it to the network        │
│                                               │
└───────────────────────────────────────────────┘
```

### Hard constraint

The channel MUST run on the same machine as Claude Code. Channels communicate over
stdio — Claude Code spawns the channel as a subprocess. This is non-negotiable.

The server can run anywhere reachable over HTTPS.

### Requirements

- `@modelcontextprotocol/sdk` package
- Any Node.js-compatible runtime: Bun, Node, or Deno
- Claude Code v2.1.80+ with claude.ai login
- During research preview: `--dangerously-load-development-channels` flag for custom
  channels not on the approved allowlist

---

## Architecture Components

### The Channel (local, stdio)

The channel is a thin bridge with three responsibilities:

1. **Event sources**: Subscribe to remote events and push them as
   `notifications/claude/channel` into the Claude Code session
2. **Reply tools** (optional): Expose MCP tools that Claude can call to send commands
   back to the remote server
3. **Instructions**: Tell Claude what events to expect and how to react

A channel declares itself via capabilities:

```ts
const server = new Server(
  { name: 'my-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},  // include for two-way; omit for one-way
    },
    instructions: 'Events arrive as <channel source="my-channel" ...>. ...',
  },
);

await server.connect(new StdioServerTransport());
```

### The Remote Server

The remote server is a standard MCP server (Code Mode or otherwise). It runs on cloud
infrastructure and is reachable via:

- **Preview URL**: A public HTTPS endpoint exposed by the cloud platform
- **Cloud API**: Platform-specific SDK calls for executions, events, artifacts

The remote server doesn't need to know about channels. It's just a server.

---

## Event Sources

A channel bridge typically has multiple event sources running concurrently:

### 1. Platform lifecycle events

Watch the cloud workspace/environment status:

```ts
async function watchLifecycle(client: CloudSDK, resourceId: string) {
  while (true) {
    try {
      const stream = await client.workspaces.watch(resourceId);
      for await (const status of stream) {
        await mcpServer.notification({
          method: 'notifications/claude/channel',
          params: {
            content: JSON.stringify(status, null, 2),
            meta: {
              event_type: 'lifecycle',
              resource_id: resourceId,
              phase: status.phase,
            },
          },
        });
      }
    } catch { /* reconnect */ }
    await sleep(5000);
  }
}
```

### 2. Execution events (stdout/stderr)

Stream output from running processes:

```ts
async function watchExecution(
  client: CloudSDK,
  workspaceId: string,
  executionId: string,
) {
  let cursor: string | undefined;
  while (true) {
    const events = await client.executions.events(executionId, {
      workspace_id: workspaceId,
      ...(cursor ? { after: cursor } : {}),
    });
    for await (const event of events) {
      if (event.chunk) {
        await mcpServer.notification({
          method: 'notifications/claude/channel',
          params: {
            content: event.chunk,
            meta: {
              event_type: 'execution_output',
              stream: event.type, // 'stdout' | 'stderr'
              execution_id: executionId,
            },
          },
        });
      }
    }
    await sleep(2000);
  }
}
```

### 3. Application-level events (SSE from server)

Subscribe to the remote server's own event stream via its preview URL:

```ts
async function subscribeSSE(previewUrl: string) {
  const sseUrl = `${previewUrl}/events`;
  while (true) {
    try {
      const response = await fetch(sseUrl);
      if (!response.ok || !response.body) throw new Error('SSE failed');
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
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              await mcpServer.notification({
                method: 'notifications/claude/channel',
                params: {
                  content: JSON.stringify(event.payload, null, 2),
                  meta: {
                    event_type: event.type,
                    event_id: event.id,
                  },
                },
              });
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch { /* reconnect */ }
    await sleep(5000);
  }
}
```

---

## Reply Tools

Two-way channels expose MCP tools that let Claude act on the remote server:

```ts
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute_command',
      description: 'Run a shell command in the remote workspace',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command and arguments',
          },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
    {
      name: 'call_server',
      description: 'Call the MCP server running in the workspace',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['tool_name', 'arguments'],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'execute_command') {
    const { command, timeout_ms } = args as {
      command: string[];
      timeout_ms?: number;
    };
    const exec = await cloudClient.executions.create(workspaceId, {
      command,
      timeout_ms,
    });
    const output = await pollUntilDone(exec);
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  }

  if (name === 'call_server') {
    const { tool_name, arguments: toolArgs } = args as {
      tool_name: string;
      arguments: Record<string, unknown>;
    };
    const res = await fetch(`${previewUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool_name, arguments: toolArgs },
        id: 1,
      }),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(await res.json(), null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});
```

---

## Sender Gating

An ungated channel is a prompt injection vector. Anyone who can reach your endpoint
can put text in front of Claude. Gate on the **sender's identity**, not the room/chat
identity.

```ts
const allowed = new Set(loadAllowlist());

// Inside your inbound message handler, before emitting:
if (!allowed.has(message.from.id)) {
  return; // drop silently
}
await mcpServer.notification({ ... });
```

For the channel bridge pattern, gating depends on the event source:

- **Cloud API events** (execution events, lifecycle): Already authenticated via your
  API key. No additional gating needed.
- **SSE from preview URL**: The preview URL is public. If your server's SSE endpoint
  doesn't require auth, anyone who discovers the URL can inject events. Add auth to
  the SSE endpoint or validate event signatures.
- **Reply tools**: Gated by Claude Code's own permission system. Only Claude in the
  local session can call them.

The allowlist also gates permission relay if the channel declares it — anyone who can
reply through the channel can approve or deny tool use in your session.

---

## Permission Relay

> Requires Claude Code v2.1.81+.

A two-way channel can opt in to receive tool approval prompts and relay them to you
on another device. Both the local terminal dialog and the remote prompt stay live —
whichever answer arrives first is applied.

Permission relay covers tool-use approvals (Bash, Write, Edit). Project trust and
MCP server consent dialogs don't relay.

### Declare the capability

```ts
const server = new Server(
  { name: 'my-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},  // opt in to permission relay
      },
      tools: {},
    },
    instructions: '...',
  },
);
```

### Handle the permission request

Claude Code sends `notifications/claude/channel/permission_request` with four fields:

| Field | Description |
|---|---|
| `request_id` | Five lowercase letters (a-z without l). Include in your outbound prompt. |
| `tool_name` | Name of the tool Claude wants to use (e.g. `Bash`, `Write`). |
| `description` | Human-readable summary of this specific tool call. |
| `input_preview` | Tool arguments as JSON string, truncated to 200 chars. |

```ts
import { z } from 'zod';

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcpServer.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Forward to your notification channel (chat platform, SSE stream, etc)
  send(
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
  );
});
```

### Send the verdict back

Parse inbound replies for the verdict format and emit
`notifications/claude/channel/permission`:

```ts
// Matches "y abcde", "yes abcde", "n abcde", "no abcde"
// [a-km-z] is the ID alphabet (lowercase, skips 'l')
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

async function onInbound(message: string) {
  const m = PERMISSION_REPLY_RE.exec(message);
  if (m) {
    await mcpServer.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: m[2].toLowerCase(),
        behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    });
    return; // handled as verdict, don't forward as chat
  }
  // ... normal event forwarding
}
```

Only declare permission relay if your channel authenticates the sender.

---

## Deployment Sequence

To get an MCP server running on a cloud workspace (using Dedalus as the example):

### 1. Create workspace

```ts
const workspace = await client.workspaces.create({
  memory_mib: 2048,
  storage_gib: 10,
  vcpu: 1,
});
```

### 2. Deploy code

```ts
await client.workspaces.executions.create(workspace.workspace_id, {
  command: ['bash', '-c', 'git clone <repo> /app && cd /app && npm install && npm run build'],
  timeout_ms: 120_000,
});
```

### 3. Start the server

```ts
const serverExec = await client.workspaces.executions.create(workspace.workspace_id, {
  command: ['node', '/app/dist/index.js'],
  env: {
    API_KEY: process.env.API_KEY!,
    PORT: '7860',
  },
});
```

### 4. Expose the port

```ts
const preview = await client.workspaces.previews.create(workspace.workspace_id, {
  port: 7860,
});
// preview.url is now the public HTTPS endpoint
```

### 5. Configure external webhooks

Point any external webhook sources at the preview URL:

```ts
await exaClient.webhooks.create({
  url: `${preview.url}/webhooks/incoming`,
  secret: process.env.WEBHOOK_SECRET,
});
```

### 6. Start the local channel

Register in `.mcp.json`:

```json
{
  "mcpServers": {
    "my-channel": {
      "command": "node",
      "args": ["dist/channel.js"],
      "env": {
        "CLOUD_API_KEY": "${CLOUD_API_KEY}",
        "WORKSPACE_ID": "<workspace_id>",
        "PREVIEW_URL": "<preview_url>"
      }
    }
  }
}
```

Launch Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:my-channel
```

---

## Notification Format

Channel notifications arrive in Claude's context as XML tags:

```xml
<channel source="my-channel" event_type="item_created" resource_id="abc123">
  { "id": "item_1", "name": "Acme Corp", "score": 8.5 }
</channel>
```

The `source` attribute is set automatically from the server name. Each key in `meta`
becomes a tag attribute. Keys must be identifiers (letters, digits, underscores only).

---

## Instructions Design

The `instructions` string in the Server constructor is added to Claude's system prompt.
It should tell Claude:

1. What event types to expect and what they mean
2. How to react to each event type
3. Which reply tools are available and when to use them
4. What operations are available on the remote server

Keep instructions focused on behavior, not implementation. Claude doesn't need to know
about SSE parsing or API polling — it just needs to know what events mean and what
tools to call.

---

## When to Use This Pattern

**Use a channel bridge when**:
- Your MCP server needs to run on remote infrastructure (cloud GPUs, persistent storage,
  external network access)
- You need asynchronous events pushed into Claude Code (webhooks, execution results,
  monitoring alerts)
- You want two-way interaction: Claude receives events AND sends commands back
- The server has long-running processes that outlive a single tool call

**Use a standard MCP server when**:
- Everything runs locally
- All operations are synchronous request/response
- No external events need to reach the Claude Code session

**Use a one-way channel when**:
- You only need to forward events (monitoring, alerts, CI notifications)
- Claude should react but doesn't need to send commands back through the channel
- The remote server is read-only from Claude's perspective

---

## Reference Implementation

The websets-mcp-codemode project implements this pattern:

- `src/channel.ts`: One-way channel that subscribes to the server's SSE webhook stream
  and pushes Exa webhook events into Claude Code as channel notifications
- `src/server.ts`: Code Mode MCP server with search/execute/status tools, webhook
  receiver, SQLite store, and background workflows
- `src/webhooks/eventBus.ts`: Pub/sub event bus that bridges webhook ingestion to SSE
  delivery (the event source the channel subscribes to)

The Dedalus TypeScript SDK (`dedalus-typescript/packages/mcp-server/src/`) provides
the Code Mode server-side SDK patterns:

- `code-tool.ts`: Code execution with local Deno sandbox or remote Stainless sandbox
- `code-tool-worker.ts`: Deno worker with TS diagnostics, SDK proxy with fuzzy method
  suggestions, and `run(client)` execution pattern
- `methods.ts`: SDK method registry with regex-based allow/block lists

---

## Common Mistakes

1. **Trying to run the channel remotely**: The channel MUST be local. Claude Code spawns
   it as a subprocess over stdio. If you need remote execution, that's the server's job.

2. **Polling too aggressively**: Use SSE/streaming when available. Fall back to polling
   with reasonable intervals (2-10 seconds). Don't hammer the cloud API.

3. **Fat channel**: Keep the channel thin. It's a bridge, not a server. Business logic,
   data storage, and API orchestration belong in the remote server.

4. **Missing reconnection logic**: SSE connections drop. API calls fail. Always wrap
   event source loops in retry logic with backoff.

5. **No instructions**: Without `instructions` in the Server constructor, Claude won't
   know what the channel events mean or how to react to them.

6. **Ignoring the `meta` constraint**: Meta keys must be identifiers (letters, digits,
   underscores). Hyphens and other characters are silently dropped.

7. **No sender gating on public endpoints**: If your channel listens on a network port
   or subscribes to a public preview URL, gate on sender identity before emitting
   notifications. An ungated channel is a prompt injection vector.

8. **Permission relay without authentication**: Only declare `claude/channel/permission`
   if your channel authenticates the sender. Anyone who can reply through the channel
   can approve or deny tool use in your session.

---

## Enterprise and Distribution

### Enterprise controls

On Team and Enterprise plans, channels are off by default:

| Setting | Purpose |
|---|---|
| `channelsEnabled` | Master switch. Must be `true` for any channel to deliver messages. |
| `allowedChannelPlugins` | Which plugins can register. Replaces the Anthropic-maintained allowlist when set. |

Pro and Max users without an organization skip these checks.

### Plugin packaging

To make your channel installable, wrap it in a plugin and publish it to a marketplace.
Users install with `/plugin install`, then enable per session with
`--channels plugin:<name>@<marketplace>`.

During research preview, custom channels need `--dangerously-load-development-channels`
unless added to the organization's `allowedChannelPlugins` list or the Anthropic
allowlist.

### Testing custom channels

```bash
# Bare .mcp.json server
claude --dangerously-load-development-channels server:my-channel

# Plugin from a marketplace
claude --dangerously-load-development-channels plugin:myplugin@mymarketplace
```

The bypass is per-entry. The `channelsEnabled` org policy still applies even with
the development flag.
