/**
 * Bridges Effect-typed workflows back to the existing Promise-based
 * workflow runner in `src/handlers/tasks.ts`. Effect workflows take a
 * single `args` object and return an `Effect` whose required services
 * are `ExaClient` and `TaskProgress`. The runner provides those layers
 * from the runtime's existing `Exa` client and `TaskStore`, executes the
 * workflow as a Fiber via `runPromiseExit`, and maps the resulting `Exit`
 * back to a resolved value or a rejected `WorkflowError`.
 *
 * @since 0.1.0
 */

import type { Exa } from "exa-js"
import { Cause, Effect, Exit, Layer } from "effect"
import { WorkflowError } from "../../workflows/helpers.js"
import type { TaskStore } from "../taskStore.js"
import { ExaClient, ExaClientLive } from "./services/ExaClient.js"
import { TaskProgress, TaskProgressLive } from "./services/TaskProgress.js"

/**
 * The shape of a workflow body once it's been ported to Effect. Takes a
 * single `args` object; returns an `Effect` requiring `ExaClient` and
 * `TaskProgress` services.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectWorkflowFn<Args = Record<string, unknown>, A = unknown> = (
  args: Args,
) => Effect.Effect<A, unknown, ExaClient | TaskProgress>

/**
 * Run an Effect-typed workflow body against the provided runtime
 * dependencies, returning a Promise that resolves to the workflow's
 * success value or rejects with a `WorkflowError`.
 *
 * Failure mapping:
 * - Tagged errors (with a `_tag` and optional `step`/`message`) are
 *   surfaced as `WorkflowError` with the tag as the step.
 * - Other expected failures become `WorkflowError("unknown")`.
 * - Defects (uncaught exceptions inside the workflow) become
 *   `WorkflowError("defect")` with the underlying error message preserved.
 * - Interruption (`Fiber.interrupt`) resolves to `null`, matching the
 *   cancelled-task convention used by the Promise-based workflows.
 *
 * @since 0.1.0
 * @category runtime
 */
export async function runEffectWorkflow<A>(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
  workflow: EffectWorkflowFn<Record<string, unknown>, A>,
): Promise<A | null> {
  const layers = Layer.mergeAll(
    ExaClientLive(exa),
    TaskProgressLive(taskId, store),
  )

  const provided = workflow(args).pipe(Effect.provide(layers))
  const exit = await Effect.runPromiseExit(provided)

  if (Exit.isSuccess(exit)) return exit.value

  // Failure path. Disentangle expected failure vs interruption vs defect.
  if (Cause.isInterruptedOnly(exit.cause)) return null

  const failureOption = Cause.failureOption(exit.cause)
  if (failureOption._tag === "Some") {
    const err = failureOption.value as { _tag?: string; message?: string; step?: string }
    throw new WorkflowError(
      err.message ?? `Workflow failed (${err._tag ?? "unknown"})`,
      err.step ?? err._tag ?? "unknown",
      false,
    )
  }

  // Defect (uncaught exception). Preserve the original message if we can.
  const defectOption = Cause.dieOption(exit.cause)
  if (defectOption._tag === "Some") {
    const defect = defectOption.value
    const msg = defect instanceof Error ? defect.message : String(defect)
    throw new WorkflowError(`Defect: ${msg}`, "defect", false)
  }

  // Multi-cause or composite failure — fall back to the printable form.
  throw new WorkflowError(Cause.pretty(exit.cause), "unknown", false)
}
