#!/usr/bin/env node
// Channel bridge: subscribes to the main server's webhook event stream
// and pushes notifications into the Claude Code session.
//
// Claude Code spawns this as a subprocess via .mcp.json:
//   "websets-channel": { "command": "node", "args": ["dist/channel.js"] }
//
// Start Claude Code with:
//   claude --dangerously-load-development-channels server:websets-channel

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const WEBSETS_SERVER_URL = process.env.WEBSETS_SERVER_URL || 'http://localhost:7860';
const RECONNECT_DELAY_MS = 5_000;

const server = new Server(
  { name: 'websets-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: `You are connected to the Websets webhook channel. Events arrive as:

<channel source="websets-channel" event_type="..." webset_id="..." entity_name="...">
  { item and enrichment data }
</channel>

## Dispatch Protocol

When a channel event arrives, follow this protocol:

1. **Read the workflow config**: Use the Read tool on /workspaces/schwartz13/data/workflow-configs.json
2. **Look up the webset_id** in config.routes
3. **If a matching route exists**:
   a. Check if the event_type matches any key in the route's "on" map
   b. If the route's event entry has a "gate", evaluate it against the event payload
   c. If the gate passes (or no gate exists), execute the steps in order
   d. Between steps, check each step's "gate_output" from config.steps — stop the chain if the gate fails
   e. Substitute {{variable}} placeholders using: event payload fields (webset_id, entity_name, event_type, score), route-level params, and prior step results ({{steps.<step_id>.<field>}})
4. **If no matching route exists**, use the default behavior below

## Step Execution

Look up each step name in config.steps to get its definition:

- **server-workflow**: Use the websets MCP execute tool:
  callOperation('tasks.create', { type: step.workflow, args: merged_params })
  Then poll with callOperation('tasks.get', { taskId }) until complete.

- **mcp-execute**: Use the specified MCP server's execute tool with the params.

- **channel-tool**: Call the specified channel's tool (e.g., gmail reply, draft_for_review).

- **notify**: Report the message to the user. No tool call needed.

After each step, if the step definition has gate_output, evaluate it against the step's result. If the gate fails, stop the chain and report which step failed and why.

## Default Behavior (no config match)

### NEW_OPPORTUNITY_CANDIDATE events
Route by score: claim_and_research (>=10) → run /verify-item then /deep-research-item skills. queue_for_review (7-9) → summarize for user. monitor (<7) → log briefly.

### webset.item.created / webset.item.enriched
Log the entity. Use websets MCP (search + execute) for further research if interesting.

### webset.idle
Report to user. Run store.listUninvestigated and store.listCandidates for pipeline status.

## Available MCP Operations

- execute: Run JS with callOperation() for any Exa/store operation
- search: Discover operations by keyword
- status: Server state overview
- Key operations: exa.search, exa.findSimilar, exa.getContents, exa.answer, store.annotate, store.getItem, store.listUninvestigated, store.listCandidates`,
  },
);

await server.connect(new StdioServerTransport());

// Subscribe to the main server's webhook event stream
connectSSE();

async function connectSSE(): Promise<void> {
  const sseUrl = `${WEBSETS_SERVER_URL}/webhooks/events`;

  // eslint-disable-next-line no-constant-condition
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

        // Parse SSE frames
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                await pushChannelNotification(event);
              } catch {
                // Skip malformed events
              }
            }
          }
        }
      }
    } catch {
      // Reconnect after delay
    }

    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

async function pushChannelNotification(event: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const data = (event.payload?.data ?? {}) as Record<string, unknown>;
  const props = (data.properties ?? {}) as Record<string, unknown>;

  // Extract entity info
  const company = props.company as Record<string, unknown> | undefined;
  const person = props.person as Record<string, unknown> | undefined;
  const article = props.article as Record<string, unknown> | undefined;
  const custom = props.custom as Record<string, unknown> | undefined;

  const entityName = (
    company?.name ?? person?.name ?? article?.title ??
    custom?.title ?? props.description ?? ''
  ) as string;

  // Extract completed enrichments
  const enrichments = (data.enrichments as Array<Record<string, unknown>> | undefined)
    ?.filter((e) => e.status === 'completed' && (e.result as unknown[] | null)?.length)
    ?.map((e) => ({ description: e.description ?? e.enrichmentId ?? 'unknown', value: (e.result as unknown[])[0] }))
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

  await server.notification({
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
