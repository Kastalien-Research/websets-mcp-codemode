/**
 * Tagged errors for the Effect-based workflow surface. Each error is a
 * `Data.TaggedError` so it can be matched structurally via
 * `Effect.catchTag` / `Effect.catchTags` and surfaced to callers with full
 * type information in the Effect's E channel.
 *
 * @since 0.1.0
 */

import { Data } from "effect"

/**
 * An Exa API call failed. The underlying cause (network error, billing 403,
 * malformed response, etc.) is wrapped opaquely as `error: unknown`.
 *
 * For finer-grained recovery, prefer the more specific subtypes below
 * (currently {@link ExaRateLimit}; more to be added as needs surface).
 *
 * @since 0.1.0
 * @category errors
 */
export class ExaError extends Data.TaggedError("ExaError")<{
  readonly operation: string
  readonly error: unknown
}> {}

/**
 * Exa returned a rate-limit response. `retryAfterMs` is honored by callers
 * that pipe through a `Schedule`; treat undefined as "no Retry-After header".
 *
 * @since 0.1.0
 * @category errors
 */
export class ExaRateLimit extends Data.TaggedError("ExaRateLimit")<{
  readonly operation: string
  readonly retryAfterMs?: number
}> {}

/**
 * Workflow input failed validation before any side-effecting work. Should
 * never reach the Exa API surface.
 *
 * @since 0.1.0
 * @category errors
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string
  readonly message: string
}> {}

/**
 * The recipient (webset / search / item) couldn't be located on Exa's side.
 * Distinct from {@link ExaError} so callers can choose to treat this as a
 * "soft" no-op.
 *
 * @since 0.1.0
 * @category errors
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string
  readonly id: string
}> {}
