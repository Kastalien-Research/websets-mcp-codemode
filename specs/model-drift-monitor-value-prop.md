# Model-Drift Monitor — Value Proposition

A `semantic.cron` configuration that monitors the public discourse around foundation models for a fuzzy event no API can give you: *a foundation model is silently regressing right now, before the provider acknowledges anything.*

## The problem

Every agent in production rides on a foundation model whose behavior the developer does not control. Providers update models silently — sometimes via routine drift, sometimes via undisclosed weight changes, sometimes via inference-stack regressions. By the time the provider's status page acknowledges a problem, the discourse has been talking about it for hours.

There is no API for "is my model regressing right now." Status pages are trailing indicators (and frequently never acknowledge silent regressions at all). Provider blogs ship after the dust settles. The only real-time signal lives in the gap between two streams of public content: casual complaint discourse and skin-in-the-game corroboration.

## The mechanism

Two **asymmetric** lenses — one is the cadence engine, the other is the trust filter:

- **`twitter_complaints`** (cadence) — surfaces Twitter content where someone names a specific LLM model and describes a behavior change with at least one reproducible signal (prompt, code snippet, or specific failure mode). High volume, noisy.
- **`github_issues`** (trust filter) — surfaces GitHub issues on agent-framework and SDK repos (LangChain, LlamaIndex, Cursor, aider, Anthropic/OpenAI SDKs) where the issue names the same model, describes a regression, and was opened in the past 72 hours. Lower volume, higher signal — production developers don't open GitHub issues to vent.

Both lenses ask Exa to extract the **model itself** as the canonical entity (custom entity type with a description: "an LLM model whose behavior is being discussed") *and* carry a per-item `Model name` enrichment that names the specific model the item is about. The join uses `keyEnrichment: "Model name"`, grouping items by the extracted model name string with case-insensitive + Dice-fuzzy matching at threshold 0.6 — so `claude-opus-4-7` matches `Claude Opus 4.7` matches `Opus 4.7` natively. Items missing the `Model name` enrichment are excluded from the join.

Strict shapes do real filtering work: Twitter items must show reproducible evidence (prompt, code snippet, or specific task — not just "feels worse today"); GitHub items must be open issues with a named regression direction.

The signal fires (`requires.type: "all"`) when at least one model name shows up in **both** lenses with shaped evidence — i.e. it has both a complaint cluster on Twitter and a corroborating production issue on GitHub.

## The fire-time predicate

The fire is half the picture. The other half is *whether the provider has admitted anything yet.* Instead of expressing this as a third lens (expensive monitor traffic for low-frequency channels like provider blogs and status pages), the demo executes a synchronous fetch at the moment of fire:

- Provider's status page
- Provider's official X/Twitter account
- Latest changelog or model-card update within window

If all three are silent → tag the fire as **`rumor_window`**. If anything has already been acknowledged → tag as **`confirmed`**. The downstream agent action branches on the tag.

This predicate is implemented as a cell on the Websets server (see [Out of scope](#out-of-scope)). For the de-risk run, the fire is reported untagged.

## What firing means

Two clean meanings, one per tag:

1. **`rumor_window` fire.** Community-corroborated regression signal exists; provider hasn't acknowledged. *Headline demo moment:* the agent caught it before the status page admitted anything. Highest-urgency action — pin to last-good model version, route critical workloads to a backup, page the on-call developer with the assembled evidence.
2. **`confirmed` fire.** Community signal AND provider has already acknowledged. *Steady-state value:* the developer already knows; the agent's job is to execute the rollback playbook on its own — pin to last-good version, file an internal ticket linking the provider's acknowledgment, mark affected workflows for review.

Both are useful; only the first is dramatic. A demo recording will show whichever fires; the spec is configured to tolerate both gracefully.

## Why DeepAgents users care

Every developer building an agent on top of a foundation model has experienced silent drift and felt powerless. The agent runtime depends on an upstream substrate that can change without warning. The `model-drift-monitor` is the thing that makes that substrate *legible* — your agent can monitor itself, in a real sense, by watching the public discourse about the model it runs on.

Concrete agent actions enabled by a fire:

- **Pin to a previous model version** automatically while the regression is confirmed.
- **Route flaky workflows to a backup model** until the rumor window closes.
- **Open an internal ticket** with the assembled evidence — Twitter posts, GitHub issues, provider acknowledgment status — formatted for human review.
- **Pause or queue** any pipeline that currently depends on the affected model.

The agent isn't doing anything magical. It runs the cron, listens for the fire, executes the closed loop. That is the DeepAgents pitch made concrete on the most visceral pain point in the audience.

## The Harrison-tweet payoff

> *"new idea: semantic crons — when {xyz fuzzy event that doesn't live as a structured metric anywhere} happens, do this"*

"A foundation model is silently regressing right now, ahead of provider acknowledgment" is exactly the canonical fuzzy event Harrison described. No API returns it. No structured database has a column for it. It exists only as the intersection of casual-complaint discourse and skin-in-the-game corroboration, and the value is in making the gap between those streams and provider acknowledgment observable, decidable, and actionable in a closed loop.

## A note on the entity-type choice and the join key

The previous version of this monitor (eval-company-monitor) used `entity: { type: "company" }` and learned the hard way that Exa extracts the *publishing company* — not the thing being discussed inside the content. We now use Exa's custom entity type so the canonical entity is the model itself:

```jsonc
"entity": {
  "type": "custom",
  "description": "An LLM model whose behavior is being discussed (e.g. claude-opus-4-7, gpt-5, gemini-3-pro). The specific model the content is about."
}
```

The de-risk run showed custom-entity extraction is partially-reliable — about half the items return a clean model-name entity, the rest return repo+issue identifiers or verbose phrases. So the join *does not* rely on the canonical entity. Instead each item carries a dedicated `Model name` text enrichment, and the join engine groups by that enrichment value via `keyEnrichment: "Model name"`. This makes the join axis explicit at config time and resilient to noisy entity extraction.

## Canonical configuration

```jsonc
{
  "name": "model-drift-monitor",
  "lenses": [
    {
      "id": "twitter_complaints",
      "source": {
        "query": "named LLM model behavior change regression last 72 hours twitter complaint reproducible example",
        "entity": {
          "type": "custom",
          "description": "An LLM model whose behavior is being discussed (e.g. claude-opus-4-7, gpt-5, gemini-3-pro). The specific model the tweet is complaining about."
        },
        "criteria": [
          { "description": "Tweet names a specific LLM model and describes a behavior change with at least one reproducible signal (example prompt, sample output, code snippet, or specific failure mode)." }
        ],
        "enrichments": [
          { "description": "Model name", "format": "text" },
          { "description": "Regression direction", "format": "options", "options": [
            { "label": "worse-quality" }, { "label": "different-style" },
            { "label": "tool-use-broken" }, { "label": "longer-output" },
            { "label": "shorter-output" }, { "label": "refuses-more" }
          ]},
          { "description": "Has reproducible evidence", "format": "options", "options": [
            { "label": "prompt-included" }, { "label": "code-snippet" },
            { "label": "specific-task" }, { "label": "no-evidence" }
          ]},
          { "description": "Author production context", "format": "options", "options": [
            { "label": "uses-in-production" }, { "label": "evaluating" },
            { "label": "casual-user" }, { "label": "unclear" }
          ]}
        ],
        "count": 50
      }
    },
    {
      "id": "github_issues",
      "source": {
        "query": "github issue agent framework named LLM model regression behavior change opened past 72 hours langchain llamaindex cursor aider anthropic openai sdk",
        "entity": {
          "type": "custom",
          "description": "An LLM model whose behavior is being discussed (e.g. claude-opus-4-7, gpt-5, gemini-3-pro). The specific model the GitHub issue is reporting a regression about."
        },
        "criteria": [
          { "description": "GitHub issue on an agent-framework or LLM SDK repository names a specific model and describes a recent regression or behavior change. Issue must be open and recently filed." }
        ],
        "enrichments": [
          { "description": "Model name", "format": "text" },
          { "description": "Repo", "format": "text" },
          { "description": "Regression direction", "format": "options", "options": [
            { "label": "worse-quality" }, { "label": "different-style" },
            { "label": "tool-use-broken" }, { "label": "longer-output" },
            { "label": "shorter-output" }, { "label": "refuses-more" }
          ]},
          { "description": "Issue state", "format": "options", "options": [
            { "label": "open" }, { "label": "closed-fixed" },
            { "label": "closed-cant-repro" }, { "label": "closed-other" }
          ]}
        ],
        "count": 50
      }
    }
  ],
  "shapes": [
    {
      "lensId": "twitter_complaints",
      "conditions": [
        { "enrichment": "Model name", "operator": "exists" },
        { "enrichment": "Has reproducible evidence", "operator": "oneOf",
          "value": ["prompt-included", "code-snippet", "specific-task"] },
        { "enrichment": "Regression direction", "operator": "exists" }
      ],
      "logic": "all"
    },
    {
      "lensId": "github_issues",
      "conditions": [
        { "enrichment": "Model name", "operator": "exists" },
        { "enrichment": "Repo", "operator": "exists" },
        { "enrichment": "Regression direction", "operator": "exists" },
        { "enrichment": "Issue state", "operator": "oneOf",
          "value": ["open"] }
      ],
      "logic": "all"
    }
  ],
  "join": {
    "by": "entity",
    "keyEnrichment": "Model name",
    "entityMatch": { "method": "fuzzy", "nameThreshold": 0.6 },
    "minLensOverlap": 2
  },
  "signal": { "requires": { "type": "all" } }
}
```

## Out of scope

Items needed for the full demo, tracked separately:

1. **Webhook emission default** — `process.env.WEBSETS_PUBLIC_URL` fallback in `semanticCron.ts:842` so callers don't need to pass `webhookUrl` per invocation.
2. **Cell + thought infrastructure** on the Websets server — host for the fire-time predicate cell, the deterministic GitHub-API validator cell, and gated action cells.
3. **Inbound generic webhook receiver + route registry** on the Websets server — the broader closed-loop work.
