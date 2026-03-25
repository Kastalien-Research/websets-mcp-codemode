import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult, requireParams } from './types.js';
import { taskStore } from '../lib/taskStore.js';
import { workflowRegistry } from '../workflows/types.js';
import { WorkflowError } from '../workflows/helpers.js';

export const Schemas = {
  create: z.object({
    type: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  }).catchall(z.unknown()), // Allow flattened arguments
  get: z.object({
    taskId: z.string(),
  }),
  result: z.object({
    taskId: z.string(),
  }),
  list: z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  }),
  cancel: z.object({
    taskId: z.string(),
  }),
};

export const create: OperationHandler = async (args, exa) => {

  const guard = requireParams('tasks.create', args, 'type');
  if (guard) return guard;

  const type = args.type as string;
  const workflow = workflowRegistry.get(type);
  if (!workflow) {
    const available = [...workflowRegistry.keys()].join(', ') || '(none)';
    return errorResult('tasks.create', `Unknown task type: "${type}". Available: ${available}`);
  }

  try {
    const { type: _type, args: _args, ...rest } = args;
    const taskArgs = (_args as Record<string, unknown>) ?? rest;
    const task = taskStore.create(type, taskArgs);


    void workflow(task.id, taskArgs, exa, taskStore)
      .then(result => taskStore.setResult(task.id, result))
      .catch(err => taskStore.setError(task.id, {
        step: err instanceof WorkflowError ? err.step : 'unknown',
        message: err instanceof Error ? err.message : String(err),
        recoverable: err instanceof WorkflowError ? err.recoverable : false,
      }));

    return successResult({ taskId: task.id, status: 'pending' });
  } catch (error) {
    return errorResult('tasks.create', error, 'Ensure task type is valid (use tasks.list to see running tasks). Task args should match the workflow schema — use the search tool to discover required parameters.');
  }
};

export const get: OperationHandler = async (args) => {
  const guard = requireParams('tasks.get', args, 'taskId');
  if (guard) return guard;

  const task = taskStore.get(args.taskId as string);
  if (!task) {
    return errorResult('tasks.get', `Task not found: ${args.taskId}`, 'Task IDs are ephemeral and only valid for the current server session. Use tasks.list to find active tasks.');
  }
  return successResult(task);
};

export const result: OperationHandler = async (args) => {
  const guard = requireParams('tasks.result', args, 'taskId');
  if (guard) return guard;

  const task = taskStore.get(args.taskId as string);
  if (!task) {
    return errorResult('tasks.result', `Task not found: ${args.taskId}`);
  }

  if (task.status === 'completed') {
    return successResult({ status: 'completed', result: task.result });
  }
  if (task.status === 'failed') {
    return successResult({ status: 'failed', error: task.error });
  }
  if (task.status === 'cancelled') {
    return successResult({ status: 'cancelled' });
  }
  return successResult({
    status: task.status,
    message: 'Task is still running',
    progress: task.progress,
    partialResult: task.partialResult,
  });
};

export const list: OperationHandler = async (args) => {
  const status = args.status as string | undefined;
  const tasks = taskStore.list(status as any);
  return successResult({
    tasks: tasks.map(t => ({
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    count: tasks.length,
  });
};

export const cancel: OperationHandler = async (args) => {
  const guard = requireParams('tasks.cancel', args, 'taskId');
  if (guard) return guard;

  const cancelled = taskStore.cancel(args.taskId as string);
  if (!cancelled) {
    return errorResult('tasks.cancel', `Cannot cancel task ${args.taskId} (not found or already finished)`);
  }
  return successResult({ taskId: args.taskId, status: 'cancelled' });
};
