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
import { buildSemanticCronNotification, type WorkflowConfig } from './channelNotification.js';

const WEBSETS_SERVER_URL = process.env.WEBSETS_SERVER_URL || 'http://localhost:7860';
const RECONNECT_DELAY_MS = 5_000;
const CHANNEL_CONFIG_PATH =
  process.env.WEBSETS_CHANNEL_CONFIG ||
  resolvePath(process.cwd(), 'data/channel-config.json');
// Prototype 2: the bridge pre-resolves routes from workflow-configs.json and
// stamps a decision-ready directive into notification meta. This file was
// historically read only by the agent; the bridge now ALSO reads it (additive
// — the agent can still consult it). Watched for live edits like the channel
// config below.
const WORKFLOW_CONFIG_PATH =
  process.env.WEBSETS_WORKFLOW_CONFIG ||
  resolvePath(process.cwd(), 'data/workflow-configs.json');

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

## Delivery Semantics

Events are turn-gated: a notification is queued and delivered when this session
next yields a turn — it NEVER interrupts a turn already in progress. If several
events arrive while the session is busy, they are delivered together on the next
turn; handle them as a group (dedupe/aggregate by webset_id where relevant). An
event that does not appear immediately after a triggering action is NOT lost and
is NOT a sign of a broken bridge — it is simply queued until the next turn
boundary. Finish the current turn before concluding anything is wrong, then look
again. Because delivery cannot preempt you, design your handling to act from a
single notification where possible rather than relying on rapid back-and-forth.

## Dispatch Protocol

When a channel event arrives, follow this protocol:

1. **Read the workflow config**: Use your Read tool on \`data/workflow-configs.json\`, relative to the Claude Code project root (the cwd of your session). This file is consumed by YOU, the agent — it is not read by the channel server, and it is a different file from the server's own \`data/channel-config.json\` (a per-webset event filter you never need to read).
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
The notification meta carries score, action, item_id, and webset_id, and content
carries the full candidate — route directly off those, no extra fetch needed.
Route by score:
- claim_and_research (>=10) → kick the /sweep-webset workflow scoped to this item:
  /sweep-webset {items:[{itemId: <item_id>, websetId: <webset_id>, entity: <entity_name>}]}.
  It runs verify → research → mark in the background (no turn-by-turn skill chain).
- queue_for_review (7-9) → summarize the candidate (score, summary, lensHits) for the user.
- monitor (<7) → log briefly. (Note: the channel only emits candidates with score >= 7.)

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
The webset has finished populating. To clear the freshly-populated backlog in one
resumable pass, kick /sweep-webset {websetId: <webset_id>} — it verifies, researches,
and marks every uninvestigated item in the background. For a quick status check
instead, run store.listUninvestigated and store.listCandidates and report to the user.

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
// Per-item raw-event retention keyed by event_type so the fallback path at
// timer-fire can still emit the exact raw type a route opted into. A single
// "latest event" pointer loses semantic fidelity: a config of
// events:["webset.item.created"] would silently drop once a later
// webset.item.enriched event overwrote the slot. Keeping one entry per
// type means the timer can pick the raw event matching the allowlist
// regardless of arrival order.
const itemEventsByType = new Map<string /* itemId */, Map<string /* type */, ChannelEvent>>();
// Pointer to the most recently received event per item — used to drive
// the synthesis decision (decideItemReady reads the cumulative latest
// payload, which carries the union of enrichments + evaluations).
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

// --- Workflow route config (Prototype 2) ---
// Loaded from data/workflow-configs.json. Watched for live edits. Used to
// pre-resolve a decision-ready route directive into notification meta so the
// consuming agent doesn't have to re-read config on every event.
let workflowConfig: WorkflowConfig = {};

function loadWorkflowConfig(): void {
  try {
    const raw = readFileSync(WORKFLOW_CONFIG_PATH, 'utf8');
    workflowConfig = JSON.parse(raw) as WorkflowConfig;
  } catch {
    // No file or unreadable → no routes; notifications still emit with an
    // explicit no-match directive (route:'', action:'default').
    workflowConfig = {};
  }
}

loadWorkflowConfig();
try {
  watchFile(
    WORKFLOW_CONFIG_PATH,
    { interval: CONFIG_POLL_INTERVAL_MS, persistent: false },
    (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) loadWorkflowConfig();
    },
  );
} catch {
  // Filesystem doesn't support watchFile — config still loaded once at boot.
}
process.on('exit', () => {
  try { unwatchFile(WORKFLOW_CONFIG_PATH); } catch { /* ignore */ }
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
      // Retain BOTH the most recent event (for synthesis input — it carries
      // the cumulative latest enrichments + evaluations) AND one entry per
      // raw event_type (for fallback emission when the synthetic is
      // disallowed but a raw type is opted-in).
      itemLatestEvent.set(itemId, event);
      const byType = itemEventsByType.get(itemId) ?? new Map<string, ChannelEvent>();
      byType.set(event.type, event);
      itemEventsByType.set(itemId, byType);

      const existing = itemCoalesceTimers.get(itemId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        itemCoalesceTimers.delete(itemId);
        const finalEvent = itemLatestEvent.get(itemId);
        const rawByType = itemEventsByType.get(itemId);
        itemLatestEvent.delete(itemId);
        itemEventsByType.delete(itemId);
        if (!finalEvent) return;

        const decision = decideItemReady(finalEvent);
        if (!decision.emit) return; // dropped by criteria filter

        const synthetic: ChannelEvent = {
          ...finalEvent,
          type: decision.syntheticType,
        };
        // Allowlist precedence:
        //   1. If config allows the synthetic type → emit synthetic
        //      (new default; most users want webset.item.ready as the
        //      single "item is done + passed gate" signal).
        //   2. Else walk the raw event types we observed in this window
        //      and emit the first one the config allows. The retention is
        //      per-type, not just "latest" — a route configured with
        //      events:["webset.item.created"] gets its created event
        //      back even if an enriched event also arrived in the window.
        //      Iteration order prefers .enriched first (richer payload)
        //      then .created (initial event).
        //   3. Else drop (config opted out of both raw and synthetic).
        if (isAllowed(synthetic)) {
          void emitNotification(synthetic);
        } else if (rawByType) {
          for (const rawType of ['webset.item.enriched', 'webset.item.created']) {
            const rawEvent = rawByType.get(rawType);
            if (rawEvent && isAllowed(rawEvent)) {
              void emitNotification(rawEvent);
              return;
            }
          }
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
    // Prototype 1 (evidence-complete content) + Prototype 2 (decision-ready
    // route directive in meta) are built by the pure formatter so they can be
    // unit-tested without bridge startup side effects.
    const { content, meta } = buildSemanticCronNotification(event, workflowConfig);
    await server.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    });
    return;
  }

  // Scored opportunity candidates carry payload.candidate (a CompactCandidate),
  // NOT payload.data — so the item-shaped formatter below would drop the score
  // and action entirely. Surface them directly so Claude can route without an
  // extra fetch: the score/action ARE the routing decision.
  if (event.type === 'NEW_OPPORTUNITY_CANDIDATE') {
    const candidate = (event.payload?.candidate ?? {}) as Record<string, unknown>;
    const content = JSON.stringify({
      company: candidate.company ?? '',
      companyDomain: candidate.companyDomain ?? '',
      score: candidate.score ?? null,
      action: candidate.action ?? '',
      lensHits: candidate.lensHits ?? [],
      summary: candidate.summary ?? '',
      primaryUrl: candidate.primaryUrl ?? '',
      itemId: candidate.itemId ?? '',
      websetId: candidate.websetId ?? '',
    }, null, 2);

    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          event_type: event.type,
          webset_id: (candidate.websetId ?? '') as string,
          entity_name: (candidate.company ?? '') as string,
          score: (candidate.score ?? '') as string | number,
          action: (candidate.action ?? '') as string,
          item_id: (candidate.itemId ?? '') as string,
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
