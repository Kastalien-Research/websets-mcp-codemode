import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { runEffectWorkflow, type EffectWorkflowFn } from '../lib/effect/runner.js';

export type WorkflowFunction = (
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
) => Promise<unknown>;

export interface ParameterMeta {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: unknown;
  constraints?: string;
}

export interface WorkflowMeta {
  title: string;
  description: string;
  category: string;
  parameters: ParameterMeta[];
  steps: string[];
  output: string;
  example: string;
  relatedWorkflows?: string[];
  tags: string[];
}

export const workflowRegistry = new Map<string, WorkflowFunction>();
export const workflowMetadata = new Map<string, WorkflowMeta>();

export function registerWorkflow(type: string, fn: WorkflowFunction, meta?: WorkflowMeta): void {
  workflowRegistry.set(type, fn);
  if (meta) workflowMetadata.set(type, meta);
}

/**
 * Register an Effect-typed workflow. The Effect body takes a single args
 * object and returns an Effect requiring the standard runtime services
 * (ExaClient, TaskProgress). At registration time, the Effect is wrapped
 * in a Promise-shaped function so the existing tasks.ts dispatcher
 * doesn't need to know which kind of workflow it's running.
 *
 * See src/lib/effect/runner.ts for the bridging semantics (failure mapping,
 * interruption handling, layer provision).
 */
export function registerEffectWorkflow<A>(
  type: string,
  fn: EffectWorkflowFn<Record<string, unknown>, A>,
  meta?: WorkflowMeta,
): void {
  const wrapped: WorkflowFunction = (taskId, args, exa, store) =>
    runEffectWorkflow(taskId, args, exa, store, fn);
  workflowRegistry.set(type, wrapped);
  if (meta) workflowMetadata.set(type, meta);
}
