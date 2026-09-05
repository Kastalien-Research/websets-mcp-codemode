import { describe, it, expect, afterEach, vi } from 'vitest';
import { TaskStore } from '../taskStore.js';

describe('TaskStore', () => {
  let store: TaskStore;

  afterEach(() => {
    store?.dispose();
    vi.useRealTimers();
  });

  it('creates and retrieves a task', () => {
    store = new TaskStore();
    const task = store.create('echo', { message: 'hello' });
    expect(task.id).toMatch(/^task_/);
    expect(task.type).toBe('echo');
    expect(task.status).toBe('pending');
    expect(task.args).toEqual({ message: 'hello' });

    const retrieved = store.get(task.id);
    expect(retrieved).toBe(task);
  });

  it('returns undefined for unknown id', () => {
    store = new TaskStore();
    expect(store.get('task_nonexistent')).toBeUndefined();
  });

  it('lists all tasks', () => {
    store = new TaskStore();
    store.create('echo', {});
    store.create('echo', {});
    expect(store.list()).toHaveLength(2);
  });

  it('lists filtered by status', () => {
    store = new TaskStore();
    const t1 = store.create('echo', {});
    store.create('echo', {});
    store.setResult(t1.id, { done: true });

    expect(store.list('completed')).toHaveLength(1);
    expect(store.list('pending')).toHaveLength(1);
  });

  it('updateProgress sets status to working', () => {
    store = new TaskStore();
    const task = store.create('echo', {});
    store.updateProgress(task.id, { step: 'processing', completed: 1, total: 3 });

    const updated = store.get(task.id)!;
    expect(updated.status).toBe('working');
    expect(updated.progress).toEqual({ step: 'processing', completed: 1, total: 3 });
  });

  it('setResult transitions to completed', () => {
    store = new TaskStore();
    const task = store.create('echo', {});
    store.setResult(task.id, { echo: 'hello' });

    const updated = store.get(task.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toEqual({ echo: 'hello' });
    expect(updated.expiresAt).not.toBe('');
  });

  it('setError transitions to failed', () => {
    store = new TaskStore();
    const task = store.create('echo', {});
    store.setError(task.id, { step: 'init', message: 'boom', recoverable: false });

    const updated = store.get(task.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toEqual({ step: 'init', message: 'boom', recoverable: false });
    expect(updated.expiresAt).not.toBe('');
  });

  it('cancel transitions to cancelled', () => {
    store = new TaskStore();
    const task = store.create('echo', {});
    const result = store.cancel(task.id);

    expect(result).toBe(true);
    expect(store.get(task.id)!.status).toBe('cancelled');
  });

  it('cancel returns false for completed tasks', () => {
    store = new TaskStore();
    const task = store.create('echo', {});
    store.setResult(task.id, {});
    expect(store.cancel(task.id)).toBe(false);
  });

  it('cancel returns false for unknown id', () => {
    store = new TaskStore();
    expect(store.cancel('task_nope')).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('keeps %s tasks immutable through every late writer', status => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    store = new TaskStore();
    const task = store.create('echo', {});
    store.setPartialResult(task.id, { receipt: 'keep' });
    if (status === 'completed') store.setResult(task.id, { original: true });
    if (status === 'failed') store.setError(task.id, { step: 'original', message: 'failure', recoverable: false });
    if (status === 'cancelled') store.cancel(task.id);
    const before = structuredClone(store.get(task.id));
    vi.advanceTimersByTime(1000);
    store.updateProgress(task.id, { step: 'late', completed: 1, total: 1 });
    store.setPartialResult(task.id, { receipt: 'overwrite' });
    store.setResult(task.id, { late: true });
    store.setError(task.id, { step: 'late', message: 'failure', recoverable: true });
    expect(store.cancel(task.id)).toBe(false);
    expect(store.get(task.id)).toEqual(before);
  });

  it('setPartialResult stores intermediate data', () => {
    store = new TaskStore();
    const task = store.create('echo', {});
    store.setPartialResult(task.id, { partial: true });

    expect(store.get(task.id)!.partialResult).toEqual({ partial: true });
  });

  it('cleanup removes expired tasks', async () => {
    store = new TaskStore(1); // 1ms TTL
    const task = store.create('echo', {});
    store.setResult(task.id, {});

    // Wait for the 1ms TTL to expire
    await new Promise(r => setTimeout(r, 10));
    const removed = store.cleanup();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(store.get(task.id)).toBeUndefined();
  });

  it('cleanup does not remove active tasks', () => {
    store = new TaskStore(1);
    store.create('echo', {}); // pending, no expiresAt
    expect(store.cleanup()).toBe(0);
  });

  it('enforces max concurrent limit', () => {
    store = new TaskStore();
    for (let i = 0; i < 20; i++) {
      store.create('echo', { i });
    }
    expect(() => store.create('echo', { i: 20 })).toThrow(/Max concurrent tasks/);
  });

  it('max concurrent considers only active tasks', () => {
    store = new TaskStore();
    for (let i = 0; i < 20; i++) {
      store.create('echo', { i });
    }
    // Complete one, freeing a slot
    const first = store.list()[0];
    store.setResult(first.id, {});

    expect(() => store.create('echo', { i: 20 })).not.toThrow();
  });
});
