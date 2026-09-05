import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Exa } from 'exa-js';
import { create, get, result, list, cancel } from '../tasks.js';

// We need the echo workflow registered
import '../../workflows/echo.js';

// Access the taskStore to reset between tests
import { TaskStore } from '../../lib/taskStore.js';

// Replace the singleton for test isolation
// We do this by mocking the module
vi.mock('../../lib/taskStore.js', async (importOriginal) => {
  const mod = await importOriginal() as any;
  const testStore = new mod.TaskStore();
  return { ...mod, taskStore: testStore, _testStore: testStore };
});

// Get reference to the test store
import { taskStore } from '../../lib/taskStore.js';

function mockExa(): Exa {
  return {} as unknown as Exa;
}

describe('tasks handlers', () => {
  afterEach(() => {
    // Clean up tasks between tests
    (taskStore as any).tasks?.clear?.();
  });

  describe('create', () => {
    it('requires type parameter', async () => {
      const res = await create({}, mockExa());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('type');
    });

    it('rejects unknown task type', async () => {
      const res = await create({ type: 'nonexistent' }, mockExa());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Unknown task type');
      expect(res.content[0].text).toContain('echo');
    });

    it('creates an echo task and returns taskId', async () => {
      const res = await create({ type: 'echo', args: { message: 'hi' } }, mockExa());
      expect(res.isError).toBeUndefined();
      const data = JSON.parse(res.content[0].text);
      expect(data.taskId).toMatch(/^task_/);
      expect(data.status).toBe('pending');
    });
  });

  describe('get', () => {
    it('requires taskId parameter', async () => {
      const res = await get({}, mockExa());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('taskId');
    });

    it('returns error for unknown taskId', async () => {
      const res = await get({ taskId: 'task_nope' }, mockExa());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('not found');
    });

    it('returns task state', async () => {
      const createRes = await create({ type: 'echo', args: { message: 'hi' } }, mockExa());
      const { taskId } = JSON.parse(createRes.content[0].text);

      const res = await get({ taskId }, mockExa());
      expect(res.isError).toBeUndefined();
      const data = JSON.parse(res.content[0].text);
      expect(data.id).toBe(taskId);
      expect(data.type).toBe('echo');
    });
  });

  describe('result', () => {
    it('requires taskId', async () => {
      const res = await result({}, mockExa());
      expect(res.isError).toBe(true);
    });

    it('returns still running for pending task', async () => {
      const createRes = await create({ type: 'echo', args: { message: 'hi', delayMs: 5000 } }, mockExa());
      const { taskId } = JSON.parse(createRes.content[0].text);

      const res = await result({ taskId }, mockExa());
      const data = JSON.parse(res.content[0].text);
      expect(['pending', 'working']).toContain(data.status);
      expect(data.message).toBe('Task is still running');
    });

    it('returns result for completed task', async () => {
      const createRes = await create({ type: 'echo', args: { message: 'hi', delayMs: 1 } }, mockExa());
      const { taskId } = JSON.parse(createRes.content[0].text);

      // Wait for the echo workflow to complete
      await new Promise(r => setTimeout(r, 50));

      const res = await result({ taskId }, mockExa());
      const data = JSON.parse(res.content[0].text);
      expect(data.status).toBe('completed');
      expect(data.result.echo).toBe('hi');
    });
  });

  describe('list', () => {
    it.each(['working', 'running'])('finds an active task using %s', async status => {
      const task = taskStore.create('echo', {});
      taskStore.updateProgress(task.id, { step: 'waiting', completed: 0, total: 1 });
      const response = await list({ status }, mockExa());
      const data = JSON.parse(response.content[0].text);
      expect(data.count).toBe(1);
      expect(data.tasks[0]).toMatchObject({ id: task.id, status: 'working' });
    });
    it('returns empty list initially', async () => {
      const res = await list({}, mockExa());
      const data = JSON.parse(res.content[0].text);
      expect(data.tasks).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('returns created tasks', async () => {
      await create({ type: 'echo', args: { message: 'a' } }, mockExa());
      await create({ type: 'echo', args: { message: 'b' } }, mockExa());

      const res = await list({}, mockExa());
      const data = JSON.parse(res.content[0].text);
      expect(data.count).toBe(2);
    });

    it('filters by status', async () => {
      const createRes = await create({ type: 'echo', args: { message: 'a', delayMs: 1 } }, mockExa());
      await create({ type: 'echo', args: { message: 'b', delayMs: 5000 } }, mockExa());

      await new Promise(r => setTimeout(r, 50));

      const res = await list({ status: 'completed' }, mockExa());
      const data = JSON.parse(res.content[0].text);
      expect(data.count).toBe(1);
    });
  });

  describe('cancel', () => {
    it('stays cancelled when the workflow later resolves', async () => {
      const res = await create({ type: 'echo', args: { message: 'late', delayMs: 1 } }, mockExa());
      const { taskId } = JSON.parse(res.content[0].text);
      await cancel({ taskId }, mockExa());
      const snapshot = structuredClone(taskStore.get(taskId));
      await new Promise(r => setTimeout(r, 20));
      expect(taskStore.get(taskId)).toEqual(snapshot);
    });
    it('requires taskId', async () => {
      const res = await cancel({}, mockExa());
      expect(res.isError).toBe(true);
    });

    it('cancels a pending task', async () => {
      const createRes = await create({ type: 'echo', args: { message: 'a', delayMs: 5000 } }, mockExa());
      const { taskId } = JSON.parse(createRes.content[0].text);

      const res = await cancel({ taskId }, mockExa());
      expect(res.isError).toBeUndefined();
      const data = JSON.parse(res.content[0].text);
      expect(data.status).toBe('cancelled');
    });

    it('fails for unknown taskId', async () => {
      const res = await cancel({ taskId: 'task_nope' }, mockExa());
      expect(res.isError).toBe(true);
    });
  });
});
