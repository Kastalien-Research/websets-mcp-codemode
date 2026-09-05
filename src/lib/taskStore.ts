import { randomUUID } from 'node:crypto';

export const TASK_STATUSES = ['pending', 'working', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export interface TaskProgress {
  step: string;
  completed: number;
  total: number;
  message?: string;
}

export interface TaskError {
  step: string;
  message: string;
  recoverable: boolean;
}

export interface TaskState<T = unknown> {
  id: string;
  type: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  args: Record<string, unknown>;
  result: T | null;
  error: TaskError | null;
  partialResult: T | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT = 20;

export class TaskStore {
  private tasks = new Map<string, TaskState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  create(type: string, args: Record<string, unknown>): TaskState {
    const activeCount = [...this.tasks.values()].filter(
      t => t.status === 'pending' || t.status === 'working',
    ).length;
    if (activeCount >= MAX_CONCURRENT) {
      throw new Error(`Max concurrent tasks (${MAX_CONCURRENT}) reached. Cancel or wait for existing tasks.`);
    }

    const now = new Date().toISOString();
    const task: TaskState = {
      id: `task_${randomUUID()}`,
      type,
      status: 'pending',
      progress: null,
      args,
      result: null,
      error: null,
      partialResult: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: '', // set on completion
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }

  list(status?: TaskStatus): TaskState[] {
    const all = [...this.tasks.values()];
    if (status) return all.filter(t => t.status === status);
    return all;
  }

  updateProgress(id: string, progress: TaskProgress): void {
    this.updateActive(id, { status: 'working', progress });
  }

  setResult(id: string, result: unknown): void {
    this.updateActive(id, { status: 'completed', result });
  }

  setPartialResult(id: string, partial: unknown): void {
    this.updateActive(id, { partialResult: partial });
  }

  setError(id: string, error: TaskError): void {
    this.updateActive(id, { status: 'failed', error });
  }

  cancel(id: string): boolean {
    return this.updateActive(id, { status: 'cancelled' });
  }

  /** The single write gate: terminal tasks keep their state, receipts, and expiry. */
  private updateActive(id: string, changes: Partial<Pick<TaskState, 'status' | 'progress' | 'result' | 'error' | 'partialResult'>>): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalTaskStatus(task.status)) return false;
    const now = Date.now();
    Object.assign(task, changes, { updatedAt: new Date(now).toISOString() });
    if (isTerminalTaskStatus(task.status)) {
      task.expiresAt = new Date(now + this.ttlMs).toISOString();
    }
    return true;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (task.expiresAt && new Date(task.expiresAt).getTime() <= now) {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.tasks.clear();
  }
}

export const taskStore = new TaskStore();
