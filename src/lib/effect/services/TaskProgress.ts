/**
 * `TaskProgress`: Effect-typed service for reporting workflow progress
 * back to the synchronous `TaskStore`. The store itself is Promise-free,
 * so this service is a thin Effect wrapper over `taskStore.updateProgress`
 * and a cancellation-poll over `taskStore.get(...).status`. Workflows
 * interact only with this interface, never with `TaskStore` directly.
 *
 * @since 0.1.0
 */

import { Context, Effect, Layer } from "effect"
import type { TaskStore } from "../../taskStore.js"

/**
 * @since 0.1.0
 * @category models
 */
export interface ProgressUpdate {
  readonly step: string
  readonly completed: number
  readonly total: number
  readonly message?: string
}

/**
 * @since 0.1.0
 * @category models
 */
export interface TaskProgressImpl {
  readonly update: (p: ProgressUpdate) => Effect.Effect<void>
  readonly isCancelled: Effect.Effect<boolean>
}

/**
 * Service tag for {@link TaskProgressImpl}.
 *
 * @since 0.1.0
 * @category services
 */
export class TaskProgress extends Context.Tag("TaskProgress")<
  TaskProgress,
  TaskProgressImpl
>() {}

/**
 * Live layer. Captures a `taskId` and `TaskStore` reference at construction
 * time; each `update` call delegates to the synchronous store. No Promise
 * boundary involved.
 *
 * @since 0.1.0
 * @category layers
 */
export const TaskProgressLive = (
  taskId: string,
  store: TaskStore,
): Layer.Layer<TaskProgress> =>
  Layer.succeed(TaskProgress, {
    update: (p) => Effect.sync(() => store.updateProgress(taskId, p)),
    isCancelled: Effect.sync(() => {
      const task = store.get(taskId)
      return task?.status === "cancelled"
    }),
  })

/**
 * Test layer. Records updates into an array the test can inspect; the
 * `cancelled` flag is read by `isCancelled` and held constant for the
 * duration of the test.
 *
 * @since 0.1.0
 * @category layers
 */
export const TaskProgressTest = (
  recorded: ProgressUpdate[] = [],
  cancelled = false,
): Layer.Layer<TaskProgress> =>
  Layer.succeed(TaskProgress, {
    update: (p) =>
      Effect.sync(() => {
        recorded.push(p)
      }),
    isCancelled: Effect.succeed(cancelled),
  })
