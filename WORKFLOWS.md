# Workflow Tasks

This document describes the workflow task types exposed through `tasks.create`.
These workflows run asynchronously inside the server and are best used through the
Docker-hosted HTTP MCP endpoint.

## Common Pattern

All workflows follow the same lifecycle:

```text
tasks.create -> tasks.get -> tasks.result
```

- `tasks.create` starts the workflow and returns a task ID.
- `tasks.get` reports status and progress.
- `tasks.result` returns the final result or the current partial state.

## Collection and Search Workflows

### `lifecycle.harvest`

Best for a straightforward search -> enrich -> collect pipeline.

Typical args:
- `query`
- `entity`
- `criteria?`
- `enrichments?`
- `count?`

### `convergent.search`

Runs multiple query variants, deduplicates the results, and highlights overlap.

Typical args:
- `queries`
- `entity`
- `criteria?`
- `count?`

### `qd.winnow`

Quality-diversity workflow for exploring a space across multiple criteria and enrichments.

Typical args:
- `query`
- `entity`
- `criteria`
- `enrichments`
- `selectionStrategy?`
- `critique?`

### `research.verifiedCollection`

Collects entities first, then runs deeper research on each selected entity.

Typical args:
- `query`
- `entity`
- `researchPrompt`
- `researchLimit?`
- `researchModel?`
- `researchSchema?`

## Reasoning and Retrieval Workflows

### `adversarial.verify`

Tests a thesis against counter-evidence and can optionally synthesize a balanced verdict.

Typical args:
- `thesis`
- `thesisQuery`
- `antithesisQuery`
- `synthesize?`
- `entity?`
- `enrichments?`

### `research.deep`

Thin wrapper around the Exa Research API for direct deep research tasks.

Typical args:
- `instructions`
- `model?`
- `outputSchema?`

### `retrieval.searchAndRead`

Searches first, then fetches page contents for the search results.

Typical args:
- `query`
- `numResults?`
- `type?`
- `category?`

### `retrieval.expandAndCollect`

Searches for seed results, then expands the set via similarity search.

Typical args:
- `query`
- `numResults?`
- `expandTop?`

### `retrieval.verifiedAnswer`

Generates an answer and validates it against additional sources.

Typical args:
- `query`
- `model?`
- `numValidation?`

## Monitoring-Oriented Workflow

### `semantic.cron`

Runs a higher-level semantic monitoring workflow that evaluates cross-signal conditions over
time. This is more analytical than a simple `monitors.create` schedule.

Typical args:
- `config` — full semantic cron configuration (lenses, shapes, join, signal)
- `variables?` — template variable values (e.g., `{"subject": "Tesla"}`)
- `existingWebsets?` — map of lens ID to webset ID (for re-evaluation)
- `previousSnapshot?` — snapshot from last evaluation (auto-loaded from SQLite if `config.name` is set)
- `timeout?` — max time to wait for searches (default: 300000ms)

New in this version:
- `config.webhookUrl` — when set, auto-registers Exa webhooks pointing at `{webhookUrl}/webhooks/exa`
- `config.name` — when set, snapshots are persisted to SQLite for automatic delta computation
- Snapshots persist to local SQLite store (`data/websets.db`) for cross-run continuity

For deeper prompt and configuration guidance, see
`docs/prompts/semantic-crons.md`.

## Webhook Channel Integration

The server includes a webhook receiver and Claude Code channel bridge for event-driven research.

### Webhook Receiver (built into Express app)

- `POST /webhooks/exa` — receives Exa webhook events, verifies `Exa-Signature` header
- `GET /webhooks/events` — SSE stream for channel bridges
- `GET /webhooks/status` — webhook system health check

Set `EXA_WEBHOOK_SECRET` env var to enable signature verification.

### Channel Bridge (`src/channel.ts`)

A separate stdio MCP server that Claude Code spawns as a subprocess. Subscribes to the
webhook event stream and pushes notifications into the Claude Code session via the
`notifications/claude/channel` protocol.

Start with: `claude --dangerously-load-development-channels server:websets-channel`

### Local Store Operations

The SQLite shadow store (`data/websets.db`) mirrors Webset items and adds an annotation layer:

- `store.annotate` — add judgment, tag, note, or research finding to an item
- `store.getItem` — get item with all annotations
- `store.listUninvestigated` — items without judgment annotations
- `store.query` — read-only SQL against the local store

## Internal / Test Workflow

### `echo`

Minimal workflow used for internal testing and task-store verification.

## Shared Behavior

All workflows share a few implementation patterns:

- They are asynchronous and cancellation-aware.
- They can expose progress through `tasks.get`.
- They may expose partial results before completion.
- They use the same task-store infrastructure under `src/lib/taskStore.ts`.

## Example

```json
{
  "operation": "tasks.create",
  "args": {
    "type": "retrieval.searchAndRead",
    "args": {
      "query": "MCP HTTP transport patterns",
      "numResults": 5
    }
  }
}
```
