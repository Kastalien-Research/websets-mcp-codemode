// retrieval.expandAndCollect (Effect-typed)
//
// Initial Exa search → parallel findSimilar expansion of top-N results
// (concurrency-capped) → URL dedup → projected results.
//
// Effect rewrite of the previous Promise version. Behavior is preserved:
// same args, same return shape (with _summary, counts, duration, results
// with source-tracking), same cancellation semantics ("returns null when
// cancelled mid-flight").

import { Effect } from "effect"
import { registerEffectWorkflow, type WorkflowMeta } from "./types.js"
import { withSummary } from "./helpers.js"
import { ExaClient, type SearchResult } from "../lib/effect/services/ExaClient.js"
import { TaskProgress } from "../lib/effect/services/TaskProgress.js"
import { ValidationError } from "../lib/effect/errors.js"

interface Args {
  readonly query?: unknown
  readonly numResults?: unknown
  readonly expandTop?: unknown
  readonly category?: unknown
  readonly startPublishedDate?: unknown
  readonly endPublishedDate?: unknown
}

const checkCancelled = Effect.gen(function* () {
  const progress = yield* TaskProgress
  const cancelled = yield* progress.isCancelled
  if (cancelled) {
    return yield* Effect.interrupt
  }
})

const expandAndCollectEffect = (rawArgs: Record<string, unknown>) =>
  Effect.gen(function* () {
    const startTime = Date.now()
    const args = rawArgs as Args

    if (typeof args.query !== "string" || args.query.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ field: "query", message: "query is required" }),
      )
    }

    const exa = yield* ExaClient
    const progress = yield* TaskProgress

    const query = args.query
    const numResults = (args.numResults as number | undefined) ?? 5
    const expandTop = (args.expandTop as number | undefined) ?? 3

    const searchOpts = {
      numResults,
      ...(args.category !== undefined ? { category: args.category as string } : {}),
      ...(args.startPublishedDate !== undefined
        ? { startPublishedDate: args.startPublishedDate as string }
        : {}),
      ...(args.endPublishedDate !== undefined
        ? { endPublishedDate: args.endPublishedDate as string }
        : {}),
    }

    // Pessimistic step total — refined after we see the actual initial count
    const guessedTotal = 2 + expandTop + 1
    yield* progress.update({ step: "searching", completed: 1, total: guessedTotal })
    const initial = yield* exa.search(query, searchOpts)
    yield* checkCancelled

    const targets = initial.slice(0, Math.min(expandTop, initial.length)).filter((r) => r.url)
    const totalSteps = 2 + targets.length + 1

    // Parallel expansion. Replaces the previous sequential `for` loop.
    const expanded = yield* Effect.forEach(
      targets,
      (target, i) =>
        Effect.gen(function* () {
          yield* progress.update({
            step: `expanding ${i + 1}/${targets.length}`,
            completed: 2 + i,
            total: totalSteps,
            message: `findSimilar on ${target.url}`,
          })
          const similar = yield* exa.findSimilar(target.url, { numResults })
          yield* checkCancelled
          return similar.map((r) => ({ ...r, source: `expanded-from-${i}` as const }))
        }),
      { concurrency: 3 },
    )

    yield* progress.update({
      step: "deduplicating",
      completed: totalSteps - 1,
      total: totalSteps,
    })

    const seen = new Set<string>()
    const deduplicated: Array<SearchResult & { source: string }> = []

    for (const r of initial) {
      if (r.url && !seen.has(r.url)) {
        seen.add(r.url)
        deduplicated.push({ ...r, source: "initial" })
      }
    }
    for (const batch of expanded) {
      for (const r of batch) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url)
          deduplicated.push(r)
        }
      }
    }

    yield* progress.update({ step: "complete", completed: totalSteps, total: totalSteps })

    const totalExpanded = expanded.reduce((sum, arr) => sum + arr.length, 0)
    const duration = Date.now() - startTime

    return withSummary(
      {
        query,
        initialCount: initial.length,
        expandedCount: totalExpanded,
        deduplicatedCount: deduplicated.length,
        results: deduplicated.map((r) => ({
          title: r.title,
          url: r.url,
          score: r.score,
          source: r.source,
        })),
        duration,
      },
      `"${query}" → ${initial.length} initial + ${totalExpanded} expanded = ${deduplicated.length} unique in ${(duration / 1000).toFixed(1)}s`,
    )
  })

const meta: WorkflowMeta = {
  title: "Expand and Collect",
  description:
    "Start with a search, then expand coverage by finding similar pages for the top results (in parallel, concurrency-capped). Deduplicates by URL. Good for discovering content beyond what a single search query returns.",
  category: "retrieval",
  parameters: [
    { name: "query", type: "string", required: true, description: "Search query string" },
    { name: "numResults", type: "number", required: false, description: "Results per search", default: 5 },
    { name: "expandTop", type: "number", required: false, description: "Number of top results to expand via findSimilar (parallel, capped at concurrency 3)", default: 3 },
    { name: "category", type: "string", required: false, description: "Content category filter" },
    { name: "startPublishedDate", type: "string", required: false, description: "Only include pages published after this date" },
    { name: "endPublishedDate", type: "string", required: false, description: "Only include pages published before this date" },
  ],
  steps: [
    "Run initial Exa search with query and filters",
    "For each of the top N results (in parallel), run findSimilar to discover related pages",
    "Deduplicate all results by URL",
  ],
  output: "Deduplicated results with title, URL, score, and source tracking (initial vs expanded-from-N).",
  example: `await callOperation('tasks.create', {\n  type: 'retrieval.expandAndCollect',\n  args: {\n    query: 'MCP server implementations',\n    numResults: 5,\n    expandTop: 3,\n  }\n});`,
  relatedWorkflows: ["retrieval.searchAndRead"],
  tags: ["search", "expand", "similar", "discover", "breadth", "dedup", "effect"],
}

registerEffectWorkflow("retrieval.expandAndCollect", expandAndCollectEffect, meta)
