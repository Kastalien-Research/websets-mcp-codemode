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
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { decideItemReady, SYNTHETIC_ITEM_READY, type ChannelEvent } from './channelSynthesis.js';

const WEBSETS_SERVER_URL = process.env.WEBSETS_SERVER_URL || 'http://localhost:7860';
const RECONNECT_DELAY_MS = 5_000;
const CHANNEL_CONFIG_PATH =
  process.env.WEBSETS_CHANNEL_CONFIG ||
  resolvePath(process.cwd(), 'data/channel-config.json');

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

1. **Read the workflow config**: Use the Read tool on data/workflow-configs.json (relative to the project root)
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

### webset.item.ready (synthesized)
The bridge emits ONE webset.item.ready per item after the per-item event stream
quiesces (default 60s) AND no evaluation is satisfied:"no". Payload carries the
full final item state (properties, enrichments, evaluations). Items with any
satisfied:"no" evaluation are dropped silently — Stage-2 verification only sees
items that passed the criteria gate. Log the entity. Use websets MCP for
further research, or dispatch agentRuns.verifyItem for Stage 2 of a research
pipeline.

### webset.item.created / webset.item.enriched (raw, opt-in)
NOT emitted by default — superseded by the synthesized webset.item.ready event
above. Available only if a webset's channel-config explicitly lists them.

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

// --- Notification queueing: dedup, per-item coalescing, synthesis ---
// Three concerns addressed here:
//   1. Duplicate event delivery: same event_id arriving twice (likely from
//      doubled SSE subscribers after reconnects). Dedup by event_id.
//   2. Volume: every enrichment increment fires a webhook. We coalesce per
//      item.id with a longer debounce so the bridge emits exactly one
//      notification per item once its enrichment pipeline has settled.
//   3. Synthesis: at debounce-fire time, inspect the item's evaluations[].
//      If any evaluation has satisfied:"no", drop the event entirely (the
//      item failed the webset's criteria gate). Otherwise re-brand the
//      emitted event_type as `webset.item.ready` — a synthetic per-item
//      completion signal callers can use to trigger Stage-2 verification
//      (e.g. dispatch an agentRuns.verifyItem workflow on the item).
//
// Filter policy (permissive): items pass through when no evaluation is
// satisfied:"no". satisfied:"yes" and satisfied:"unclear" both pass — the
// caller's downstream verifier (e.g. an agent run) resolves the ambiguity.
// The pure decision helper lives in ./channelSynthesis (separate module so
// unit tests can import without triggering bridge startup side effects).

const recentEventIds = new Map<string, number>();
const EVENT_DEDUP_WINDOW_MS = 60_000;

const itemCoalesceTimers = new Map<string, NodeJS.Timeout>();
const itemLatestEvent = new Map<string, ChannelEvent>();
// Quiescence window for per-item synthesis. Default 60s — bumped from 5s
// because Exa enrichment jobs for an item arrive ~10–60s apart. 5s was
// shorter than the inter-enrichment cadence, so each enrichment fired its
// own coalesce window and the user saw a flood. 60s is long enough that
// every enrichment for a typical item lands inside one window. Override
// with CHANNEL_ITEM_COALESCE_MS for atypical workloads.
const ITEM_COALESCE_DELAY_MS = parseInt(
  process.env.CHANNEL_ITEM_COALESCE_MS ?? '60000',
  10,
);

// SYNTHETIC_ITEM_READY constant is imported from ./channelSynthesis above.

// --- Per-webset filtering ---
// Loaded from data/channel-config.json. Watched for live edits.
type WebsetEntry = {
  label?: string;
  enabled?: boolean;
  events?: string[]; // event-type allowlist; missing = all
};
type ChannelConfig = {
  default?: WebsetEntry;
  websets?: Record<string, WebsetEntry>;
};

let channelConfig: ChannelConfig = { default: { enabled: true }, websets: {} };

function loadChannelConfig(): void {
  try {
    const raw = readFileSync(CHANNEL_CONFIG_PATH, 'utf8');
    channelConfig = JSON.parse(raw) as ChannelConfig;
  } catch {
    // No file or unreadable → fail open (enabled by default).
    channelConfig = { default: { enabled: true }, websets: {} };
  }
}

loadChannelConfig();
// watchFile (polling) instead of fs.watch — fs.watch is unreliable on macOS
// for in-place edits (it sometimes silently drops events when an editor
// rewrites the file via atomic replace, and reliability varies by Node
// version + filesystem). The polling-based watchFile is slower (default 5s)
// but deterministic across all platforms; for a human-edited config file
// 1s polling latency is invisible. unwatchFile is exposed for tests.
const CONFIG_POLL_INTERVAL_MS = 1_000;
try {
  watchFile(
    CHANNEL_CONFIG_PATH,
    { interval: CONFIG_POLL_INTERVAL_MS, persistent: false },
    (curr, prev) => {
      // mtimeMs is 0 when the file doesn't exist; ignore the initial event.
      if (curr.mtimeMs !== prev.mtimeMs) loadChannelConfig();
    },
  );
} catch {
  // Filesystem doesn't support watchFile — config still loaded once at boot.
}
process.on('exit', () => {
  try { unwatchFile(CHANNEL_CONFIG_PATH); } catch { /* ignore */ }
});

function extractWebsetId(event: ChannelEvent): string | undefined {
  const payload = event.payload || {};
  const data = (payload.data ?? {}) as Record<string, unknown>;
  // Item events: data.websetId
  if (typeof data.websetId === 'string') return data.websetId;
  // Webset-level events (idle): data.id is the webset id
  if (event.type.startsWith('webset.') && !event.type.includes('item') && typeof data.id === 'string') {
    return data.id;
  }
  // Workflow-emitted events (semantic-cron.*) — webset is encoded inside snapshot.lenses
  const snapshot = (payload.snapshot ?? {}) as Record<string, unknown>;
  const lenses = (snapshot.lenses ?? {}) as Record<string, { websetId?: string }>;
  for (const lens of Object.values(lenses)) {
    if (lens?.websetId) return lens.websetId;
  }
  return undefined;
}

function isAllowed(event: ChannelEvent): boolean {
  const websetId = extractWebsetId(event);
  const websets = channelConfig.websets || {};
  // For semantic-cron.* events, the event isn't tied to a single webset — the
  // *config* spans both lenses. Allow if ANY lens-webset of this config is
  // enabled (and event-type allowed).
  if (event.type.startsWith('semantic-cron.')) {
    const payload = event.payload || {};
    const snapshot = (payload.snapshot ?? {}) as Record<string, unknown>;
    const lenses = (snapshot.lenses ?? {}) as Record<string, { websetId?: string }>;
    const lensWebsetIds = Object.values(lenses).map(l => l?.websetId).filter(Boolean) as string[];
    for (const id of lensWebsetIds) {
      const entry = websets[id];
      if (entry && entry.enabled !== false &&
          (!entry.events || entry.events.includes(event.type))) {
        return true;
      }
    }
    // Fall through to default if no lens-webset is explicitly listed.
    const def = channelConfig.default ?? { enabled: true };
    return def.enabled !== false &&
      (!def.events || def.events.includes(event.type));
  }
  // Per-webset filtering for everything else.
  const entry = websetId ? websets[websetId] : undefined;
  const effective = entry ?? channelConfig.default ?? { enabled: true };
  if (effective.enabled === false) return false;
  if (effective.events && !effective.events.includes(event.type)) return false;
  return true;
}

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

async function pushChannelNotification(event: ChannelEvent): Promise<void> {
  // 0. Filter by per-webset allowlist (data/channel-config.json).
  //    Exception: raw webset.item.created and webset.item.enriched events
  //    bypass the allowlist here because they're INPUTS to per-item
  //    synthesis. The synthetic webset.item.ready emitted at the end of the
  //    coalescence window is then re-checked against the same allowlist
  //    before actual emission. This means a config like
  //      events: ["webset.item.ready", "webset.idle"]
  //    correctly suppresses the raw events while still allowing the
  //    bridge to compute and emit the synthetic completion event.
  const isRawItemEvent =
    event.type === 'webset.item.created' ||
    event.type === 'webset.item.enriched';
  if (!isRawItemEvent && !isAllowed(event)) return;

  // 1. Dedup by event_id — same event delivered twice is a known duplication
  //    (likely from doubled SSE subscribers). Drop the second copy.
  if (recentEventIds.has(event.id)) return;
  const now = Date.now();
  recentEventIds.set(event.id, now);
  // Garbage-collect old entries
  if (recentEventIds.size > 1000) {
    for (const [id, ts] of recentEventIds) {
      if (now - ts > EVENT_DEDUP_WINDOW_MS) recentEventIds.delete(id);
    }
  }

  // 2. Coalesce per-item updates. webset.item.created and webset.item.enriched
  //    fire many times for the same item as enrichments complete. We aggregate
  //    them by item.id with a quiescence window; once no new event has arrived
  //    for the item within ITEM_COALESCE_DELAY_MS, we synthesize one final
  //    notification.
  //
  //    At timer-fire we call decideItemReady() to either:
  //      - drop the event (item failed the criteria gate), or
  //      - re-brand the event_type as `webset.item.ready` and emit with the
  //        latest cumulative payload. The synthetic type then passes through
  //        isAllowed() so per-webset config can still suppress it.
  if (
    event.type === 'webset.item.created' ||
    event.type === 'webset.item.enriched'
  ) {
    const data = (event.payload?.data ?? {}) as Record<string, unknown>;
    const itemId = data.id as string | undefined;
    if (itemId) {
      itemLatestEvent.set(itemId, event);
      const existing = itemCoalesceTimers.get(itemId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        itemCoalesceTimers.delete(itemId);
        const finalEvent = itemLatestEvent.get(itemId);
        itemLatestEvent.delete(itemId);
        if (!finalEvent) return;

        const decision = decideItemReady(finalEvent);
        if (!decision.emit) return; // dropped by criteria filter

        const synthetic: ChannelEvent = {
          ...finalEvent,
          type: decision.syntheticType,
        };
        // Allowlist precedence (preserves backward-compat for raw-event
        // consumers):
        //   1. If config allows the synthetic type → emit synthetic.
        //      Most users want webset.item.ready as the single "this item
        //      is done enriching and passed the gate" signal.
        //   2. Else if config allows the raw event type (e.g. legacy
        //      route with events: ["webset.item.created"]) → emit the raw
        //      event with its original type. The payload is the latest
        //      cumulative state from the coalescence window — the same
        //      coalescence the pre-PR-24 bridge applied, just with a
        //      longer window. Raw consumers were never seeing every
        //      individual enrichment anyway.
        //   3. Else → drop. Config explicitly opted out of both types.
        if (isAllowed(synthetic)) {
          void emitNotification(synthetic);
        } else if (isAllowed(finalEvent)) {
          void emitNotification(finalEvent);
        }
      }, ITEM_COALESCE_DELAY_MS);
      itemCoalesceTimers.set(itemId, timer);
      return;
    }
  }

  // Non-item events (e.g. webset.idle, NEW_OPPORTUNITY_CANDIDATE) emit immediately.
  await emitNotification(event);
}

async function emitNotification(event: ChannelEvent): Promise<void> {
  // Special-case workflow-emitted signal events. Their payload is the full
  // snapshot, not an item, so the item-shaped formatter below would be empty.
  if (event.type.startsWith('semantic-cron.')) {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const snapshot = (p.snapshot ?? {}) as Record<string, unknown>;
    const signal = (snapshot.signal ?? {}) as Record<string, unknown>;
    const join = (snapshot.join ?? {}) as Record<string, unknown>;
    const transition = (p.transition ?? {}) as Record<string, unknown>;

    const content = JSON.stringify({
      configName: p.configName,
      taskId: p.taskId,
      reason: p.reason,
      signal: {
        fired: signal.fired,
        rule: signal.rule,
        entities: signal.entities,
      },
      transition: {
        was: transition.was,
        now: transition.now,
        newEntities: transition.newEntities,
        lostEntities: transition.lostEntities,
      },
      joinedEntities: (join.entities as Array<{ entity: string; lensCount: number; presentInLenses: string[] }> | undefined)
        ?.map(e => ({ entity: e.entity, lensCount: e.lensCount, lenses: e.presentInLenses })) ?? [],
    }, null, 2);

    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          event_type: event.type,
          config_name: (p.configName ?? '') as string,
          task_id: (p.taskId ?? '') as string,
          reason: (p.reason ?? '') as string,
          event_id: event.id,
        },
      },
    });
    return;
  }

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
