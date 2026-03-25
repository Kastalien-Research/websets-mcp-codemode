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

## How to react

When you receive a **webset.item.created** or **webset.item.enriched** event:

1. Read the entity name and enrichment values from the event payload
2. Use the websets MCP server (search + execute tools) to research the entity further
3. Launch parallel searches for context:
   - exa.search for news, analysis, and background
   - exa.getContents to read full pages from the item's URL
   - exa.findSimilar to discover related entities
4. After researching, annotate the item in the local store:
   - store.annotate with type "judgment" and your assessment
   - store.annotate with type "research_finding" for key discoveries
5. Synthesize findings and report to the user

When you receive a **webset.idle** event:
- The webset has finished populating. Run store.listUninvestigated to see which items haven't been researched yet.
- Consider triggering a semantic.cron evaluation if this is part of a composite signal setup.

You can spin up multiple subagent searches in parallel — the Exa search API is
stateless and session-independent. The webset continues populating while you research.

## Available tools on the websets MCP server

- execute: Run JS code with callOperation() for any Exa API operation
- search: Discover available operations by keyword
- status: Check webset counts and server state

## Key operations for research

- exa.search(query, opts) — instant web search with category/date/domain filters
- exa.findSimilar(url) — find pages similar to a URL
- exa.getContents(urls) — extract text/highlights/summary from URLs
- exa.answer(query) — question answering with citations
- store.annotate(itemId, type, value) — annotate item in local store
- store.getItem(itemId) — get item with all annotations
- store.listUninvestigated(websetId?) — items needing research`,
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
    ?.map((e) => ({ description: e.description, value: (e.result as unknown[])[0] }))
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
