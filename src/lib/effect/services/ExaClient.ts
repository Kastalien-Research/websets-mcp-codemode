/**
 * `ExaClient`: Effect-typed service wrapping the Exa API surface used by
 * research workflows. Today's `Live` implementation wraps `exa-js`; the
 * interface is shaped around what an Effect-native client should look like
 * so that the eventual replacement (a fetch-based custom SDK that threads
 * `AbortSignal` through every call) can be swapped in without touching
 * workflows or tests.
 *
 * KNOWN LIMITATION (Promise boundary): `exa-js` methods don't accept an
 * `AbortSignal`, so when an Effect fiber is interrupted mid-flight, the
 * underlying HTTP request keeps running until it resolves and its result
 * is discarded. This is "leaky cancellation": the workflow stops caring,
 * but the work doesn't actually stop. Cost is bounded by Exa's per-call
 * latency (seconds), so it's acceptable for now.
 *
 * @since 0.1.0
 */

import type { Exa } from "exa-js"
import { Context, Effect, Layer } from "effect"
import { ExaError } from "../errors.js"

// --- Types: shape what we actually use, not what exa-js returns ---

/**
 * @since 0.1.0
 * @category models
 */
export interface SearchOpts {
  readonly numResults?: number
  readonly category?: string
  readonly startPublishedDate?: string
  readonly endPublishedDate?: string
}

/**
 * @since 0.1.0
 * @category models
 */
export interface SimilarOpts {
  readonly numResults?: number
}

/**
 * @since 0.1.0
 * @category models
 */
export interface SearchResult {
  readonly title?: string
  readonly url: string
  readonly score?: number
  readonly publishedDate?: string
}

/**
 * The narrow Effect-typed contract the workflows depend on.
 *
 * @since 0.1.0
 * @category models
 */
export interface ExaClientImpl {
  readonly search: (
    query: string,
    opts: SearchOpts,
  ) => Effect.Effect<readonly SearchResult[], ExaError>

  readonly findSimilar: (
    url: string,
    opts: SimilarOpts,
  ) => Effect.Effect<readonly SearchResult[], ExaError>
}

// --- Service Tag ---

/**
 * Service tag for {@link ExaClientImpl}. Workflows ask for it via
 * `yield* ExaClient`; tests provide a layer via {@link ExaClientTest}.
 *
 * @since 0.1.0
 * @category services
 */
export class ExaClient extends Context.Tag("ExaClient")<
  ExaClient,
  ExaClientImpl
>() {}

// --- Live Layer (wraps exa-js) ---

/**
 * Production layer. Threads each call through `Effect.tryPromise` and tags
 * any rejection as an {@link ExaError}. Cancellation is leaky here; see
 * the file-level comment.
 *
 * @since 0.1.0
 * @category layers
 */
export const ExaClientLive = (exa: Exa): Layer.Layer<ExaClient> =>
  Layer.succeed(ExaClient, {
    search: (query, opts) =>
      Effect.tryPromise({
        try: () =>
          exa
            .search(query, opts as never)
            .then((r) => (r.results ?? []) as readonly SearchResult[]),
        catch: (error) => new ExaError({ operation: "exa.search", error }),
      }),

    findSimilar: (url, opts) =>
      Effect.tryPromise({
        try: () =>
          exa
            .findSimilar(url, opts as never)
            .then((r) => (r.results ?? []) as readonly SearchResult[]),
        catch: (error) => new ExaError({ operation: "exa.findSimilar", error }),
      }),
  })

// --- Test layer factory ---

/**
 * Convenience for tests. Pass a partial implementation; defaults to a
 * version that fails loudly (`Effect.die`) if a method is called without
 * being stubbed. Forces tests to declare exactly which methods they
 * exercise.
 *
 * @since 0.1.0
 * @category layers
 */
export const ExaClientTest = (
  overrides: Partial<ExaClientImpl> = {},
): Layer.Layer<ExaClient> =>
  Layer.succeed(ExaClient, {
    search:
      overrides.search ??
      (() => Effect.die(new Error("ExaClientTest: search not stubbed"))),
    findSimilar:
      overrides.findSimilar ??
      (() => Effect.die(new Error("ExaClientTest: findSimilar not stubbed"))),
  })
