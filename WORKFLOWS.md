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
- `config`
- `subject?`
- `window?`

For deeper prompt and configuration guidance, see
`docs/prompts/semantic-crons.md`.

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
