// echo.effect — Effect-typed parity of the existing `echo` workflow.
// Used as a smoke test for the Effect scaffolding: validates that the
// runner bridge, layer provision, TaskProgress service, and tagged-error
// path all wire together without exercising any Exa-side calls.

import { Effect } from "effect"
import { registerEffectWorkflow, type WorkflowMeta } from "./types.js"
import { TaskProgress } from "../lib/effect/services/TaskProgress.js"
import { ValidationError } from "../lib/effect/errors.js"

interface EchoArgs {
  readonly message?: string
  readonly delayMs?: number
}

const echoEffect = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const a = args as EchoArgs
    if (typeof a.message !== "string" || a.message.length === 0) {
      return yield* Effect.fail(
        new ValidationError({
          field: "message",
          message: "must be a non-empty string",
        }),
      )
    }

    const delayMs = a.delayMs ?? 100
    const progress = yield* TaskProgress

    yield* progress.update({ step: "starting", completed: 0, total: 2 })
    yield* Effect.sleep(`${delayMs} millis`)
    yield* progress.update({ step: "echoing", completed: 1, total: 2 })

    return {
      echo: a.message,
      delayMs,
      timestamp: new Date().toISOString(),
      via: "effect",
    }
  })

const meta: WorkflowMeta = {
  title: "Echo (Effect)",
  description:
    "Effect-typed echo. Smoke test for the Effect runtime — validates layer provision, TaskProgress service, and the runner bridge without making any external API calls.",
  category: "testing",
  parameters: [
    { name: "message", type: "string", required: true, description: "Message to echo back" },
    { name: "delayMs", type: "number", required: false, description: "Delay before echoing", default: 100 },
  ],
  steps: ["Validate input", "Sleep for delayMs", "Return echo with timestamp"],
  output: "{ echo, delayMs, timestamp, via: 'effect' }",
  example: `await callOperation('tasks.create', { type: 'echo.effect', args: { message: 'hi' } });`,
  tags: ["echo", "smoke-test", "effect", "test"],
}

registerEffectWorkflow("echo.effect", echoEffect, meta)
