---
name: channels-mcp
description: "Build Claude Code Channels — MCP servers that push events into a live Claude Code session so Claude can react to things happening outside the terminal. Use this skill whenever the user wants to: build a custom channel server, push webhooks/CI alerts/monitoring events into Claude Code, build a two-way chat bridge (Telegram, Discord, or custom), relay tool-use permission prompts remotely, understand the channel notification protocol, declare the claude/channel or claude/channel/permission capability, wire up sender gating/allowlists, or package a channel as a plugin. Trigger on any mention of Channels, channel MCP, push events to Claude Code, Claude Code from phone, or remote control Claude Code."
---

# Claude Code Channels — Build Guide

Channels turn Claude Code into an event-driven agent. Instead of waiting for terminal input, a channel MCP server pushes events into the running session — CI failures, webhook payloads, chat messages — and Claude reacts with full codebase context already loaded.

**Research Preview.** Requires Claude Code **v2.1.80+** and **claude.ai login** (Console/API key auth not supported). Team/Enterprise orgs must enable channels from Admin settings.

---

## What a Channel Is

A channel is a standard MCP server with one extra capability declaration. Claude Code spawns it as a subprocess (stdio transport). Your server is the bridge:

- **Chat platforms (Telegram, Discord):** server polls the platform API for new messages, forwards to Claude, sends replies back. No public URL needed.
- **Webhooks (CI, monitoring):** server listens on a local HTTP port; external systems POST to it; server pushes payload to Claude.

**One-way channels** forward events; Claude acts silently. **Two-way channels** also expose a `reply` tool so Claude can respond back through the platform.

---

## The Channel Contract

Three things your server must do:

1. Declare `claude/channel` in capabilities
2. Connect over stdio transport
3. Push events via `mcp.notification()` with method `notifications/claude/channel`

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'my-channel', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},           // required — registers the listener
        // 'claude/channel/permission': {} // opt in for permission relay (v2.1.81+)
      },
      // tools: {}  // include if two-way (exposes reply tool)
    },
    instructions:
      'Messages arrive as <channel source="my-channel" chat_id="...">body</channel>. ' +
      'Reply with the reply tool, passing chat_id.',
  }
)

const transport = new StdioServerTransport()
await mcp.connect(transport)
```

The `instructions` string is injected into Claude's system prompt. Use it to tell Claude what events to expect, what tag attributes mean, and whether to reply.

---

## Pushing Events

```typescript
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'Build failed on main: 3 test failures in auth.test.ts',
    meta: {
      severity: 'high',
      source: 'github-actions',
      chat_id: 'user-123',       // any key-value pairs
    },
  },
})
```

Claude receives this as a `<channel>` XML tag:
```xml
<channel source="my-channel" severity="high" source="github-actions" chat_id="user-123">
  Build failed on main: 3 test failures in auth.test.ts
</channel>
```

Each key in `meta` becomes an attribute on the tag. The `content` string becomes the tag body.

---

## Two-Way: Reply Tool

For chat bridges, expose a `reply` tool so Claude can send messages back:

```typescript
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back over this channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Conversation to reply in' },
        text:    { type: 'string', description: 'Message to send' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    await sendToPlatform(chat_id, text)   // your platform API call
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`Unknown tool: ${req.params.name}`)
})
```

---

## Sender Gating

**Gate on sender ID, not room/chat ID.** In group chats these differ — gating on the room lets anyone in the group inject into your session.

```typescript
const allowed = new Set<string>(['user-id-123'])  // from your allowlist/pairing flow

async function onInbound(message: PlatformMessage) {
  if (!allowed.has(message.from.id)) return   // drop silently

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: message.text, meta: { chat_id: message.chat.id } },
  })
}
```

The official Telegram and Discord plugins bootstrap their allowlists via a **pairing flow**: user DMs the bot → bot replies with a pairing code → user approves in their Claude Code session → sender ID is added to allowlist.

---

## Permission Relay (v2.1.81+)

When Claude hits a tool-approval prompt (Bash, Write, Edit), the session pauses. A two-way channel can relay the prompt to your phone and accept a remote verdict.

**Declare the capability:**
```typescript
experimental: {
  'claude/channel': {},
  'claude/channel/permission': {},  // opt in
},
```

**Register the inbound permission notification handler:**
```typescript
import { PermissionRequestSchema } from '@modelcontextprotocol/sdk/types.js'
// (or use the raw method string if the schema isn't exported yet)

mcp.setNotificationHandler(PermissionRequestSchema, async (notification) => {
  const { request_id, tool_name, tool_input } = notification.params
  const promptText = `Allow ${tool_name}?\n${JSON.stringify(tool_input, null, 2)}\n\nReply: y ${request_id} or n ${request_id}`
  await sendToPlatform(chat_id, promptText)
})
```

**Parse remote verdict in your inbound message handler:**
```typescript
// matches "y abcde", "yes abcde", "n abcde", "no abcde"
// [a-km-z] is the ID alphabet Claude Code uses (lowercase, skips 'l')
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

async function onInbound(message: PlatformMessage) {
  if (!allowed.has(message.from.id)) return

  const m = PERMISSION_REPLY_RE.exec(message.text)
  if (m) {
    // emit verdict notification to Claude Code — never reaches Claude itself
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: m[2].toLowerCase(),
        verdict: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    return
  }

  // not a permission reply — forward as regular channel event
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: message.text, meta: { chat_id: message.chat.id } },
  })
}
```

**Security note:** Only declare `claude/channel/permission` if your channel authenticates senders. Anyone who can send verdicts can approve tool use in your session.

What relays: Bash, Write, Edit tool-use approvals. What does NOT relay: project trust and MCP server consent dialogs (local terminal only).

---

## Launching Channels

Add the server to your MCP config (`.mcp.json` or `~/.claude.json`):
```json
{
  "mcpServers": {
    "my-channel": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/webhook.ts"]
    }
  }
}
```

Then launch Claude Code with the `--channels` flag:
```bash
claude --channels my-channel
# or multiple
claude --channels plugin:telegram@claude-plugins-official,my-channel
```

**Being in `.mcp.json` is not enough** — the server must also be named in `--channels` each session for event delivery to activate.

**During research preview:** Custom channels aren't on the approved allowlist. Test locally with:
```bash
claude --channels --dangerously-load-development-channels my-channel
```

---

## Official Plugins (Research Preview)

Install via the plugin system; requires Bun:
```
/plugin marketplace add anthropics/claude-plugins-official
/plugin install telegram   # or discord, fakechat
/reload-plugins
```

Then launch:
```bash
claude --channels plugin:telegram@claude-plugins-official
```

**Pairing (Telegram/Discord):** Send any message to your bot → bot replies with a pairing code → approve in Claude Code → done.

**fakechat:** Local demo channel. No bot setup needed, good for testing the flow before connecting a real platform.

---

## Persistent Sessions

Events only arrive while the session is open. Messages sent while the terminal is closed are lost. For always-on setups:

```bash
# Recommended: run inside tmux or screen
tmux new-session -s claude
claude --channels plugin:telegram@claude-plugins-official
# detach: Ctrl-B D
# reattach: tmux attach -t claude
```

---

## Enterprise Controls

Team/Enterprise: channels are off by default. Admins enable via:
- `claude.ai → Admin settings → Claude Code → Channels`
- Or set `channelsEnabled: true` in managed settings

Pro/Max (no org): channels available, users opt in per session with `--channels`.

---

## Reference Files

- `references/webhook-example.md` — Complete webhook receiver implementation (one-way and two-way with SSE)
- `references/channel-contract.md` — Full protocol spec: capability keys, notification schemas, permission relay flow, plugin packaging