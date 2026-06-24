import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskStore } from '../../lib/taskStore.js';

// Mock the agentRuns handler so we can control the AgentRun shape returned
// to the workflow without hitting the network. Hoisted by vitest, applied
// before the workflow module is imported.
vi.mock('../../handlers/agentRuns.js', () => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));
// Mock annotateItem so we can assert on the persisted verdict shape without
// touching SQLite. The function is imported directly by verifyItem.ts.
vi.mock('../../store/db.js', () => ({
  annotateItem: vi.fn().mockReturnValue(42),
  upsertItem: vi.fn(),
}));

import * as agentRuns from '../../handlers/agentRuns.js';
import { annotateItem, upsertItem } from '../../store/db.js';
import '../verifyItem.js';
import { workflowRegistry } from '../types.js';

const mockedCreate = agentRuns.create as unknown as ReturnType<typeof vi.fn>;
const mockedAnnotate = annotateItem as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = upsertItem as unknown as ReturnType<typeof vi.fn>;

function fakeAgentRun(structured: Record<string, unknown> | null, runId = 'agent_run_test') {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        id: runId,
        status: 'completed',
        output: structured ? { structured } : {},
        costDollars: { total: 0.0123 },
      }),
    }],
  };
}

describe('agentRuns.verifyItem workflow', () => {
  let store: TaskStore;
  const workflow = workflowRegistry.get('agentRuns.verifyItem')!;

  beforeEach(() => {
    store = new TaskStore();
    mockedCreate.mockReset();
    mockedAnnotate.mockReset();
    mockedAnnotate.mockReturnValue(42);
    mockedUpsert.mockReset();
  });

  it('pre-upserts the item when websetId is supplied (defensive against FK)', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'ok' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_upsert_1', url: 'https://x', name: 'X' },
      websetId: 'webset_owner',
    });

    await workflow(task.id, task.args, {} as any, store);

    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'witem_upsert_1',
        websetId: 'webset_owner',
        url: 'https://x',
        name: 'X',
      }),
    );
    store.dispose();
  });

  it('skips upsert when websetId is omitted (production path: item already in store)', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'ok' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_no_upsert' },
    });

    await workflow(task.id, task.args, {} as any, store);

    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(mockedAnnotate).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('is registered', () => {
    expect(workflow).toBeDefined();
  });

  it('rejects when args.item is missing', async () => {
    const task = store.create('agentRuns.verifyItem', {});
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /args\.item/,
    );
    store.dispose();
  });

  it('rejects when args.item lacks an id', async () => {
    const task = store.create('agentRuns.verifyItem', { item: { url: 'https://x' } });
    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /args\.item/,
    );
    store.dispose();
  });

  it('passes verified+relevant verdict through to the annotation store', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'URL resolves; content matches.' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_1', url: 'https://example.com', name: 'Example' },
      originalQuery: 'official documentation sites',
    });

    const result = await workflow(task.id, task.args, {} as any, store) as Record<string, unknown>;

    expect(result.itemId).toBe('witem_1');
    const verdict = result.verdict as Record<string, unknown>;
    expect(verdict.verified).toBe(true);
    expect(verdict.relevant).toBe(true);
    expect(verdict.reasoning).toBe('URL resolves; content matches.');
    expect(verdict.runId).toBe('agent_run_test');
    expect(verdict.cost).toBe(0.0123);

    // annotateItem called once with the right shape
    expect(mockedAnnotate).toHaveBeenCalledTimes(1);
    const [itemId, type, value, source] = mockedAnnotate.mock.calls[0];
    expect(itemId).toBe('witem_1');
    expect(type).toBe('verification');
    expect(source).toBe('agentRuns.verifyItem');
    const persistedVerdict = JSON.parse(value as string);
    expect(persistedVerdict.verified).toBe(true);
    expect(persistedVerdict.relevant).toBe(true);
    store.dispose();
  });

  it('persists a verified=false verdict (does not gate on the verdict)', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: false, relevant: false, reasoning: '404 not found.' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_2' },
    });

    const result = await workflow(task.id, task.args, {} as any, store) as Record<string, unknown>;
    const verdict = result.verdict as Record<string, unknown>;
    expect(verdict.verified).toBe(false);
    expect(verdict.relevant).toBe(false);
    // Still annotated — failed verifications are valuable signal for Stage-3
    expect(mockedAnnotate).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('uses annotationType override when provided', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'ok' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_3' },
      annotationType: 'verification.v2',
    });

    await workflow(task.id, task.args, {} as any, store);
    const [, type] = mockedAnnotate.mock.calls[0];
    expect(type).toBe('verification.v2');
    store.dispose();
  });

  it('uses custom verificationPrompt when provided', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'ok' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_4' },
      verificationPrompt: 'CUSTOM: please verify this exhaustively.',
    });

    await workflow(task.id, task.args, {} as any, store);
    const call = mockedCreate.mock.calls[0];
    const passedArgs = call[0] as Record<string, unknown>;
    expect(passedArgs.query).toBe('CUSTOM: please verify this exhaustively.');
    store.dispose();
  });

  it('uses default effort=low and passes outputSchema with verified+relevant+reasoning', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'ok' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: { id: 'witem_5' },
    });

    await workflow(task.id, task.args, {} as any, store);
    const passedArgs = mockedCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(passedArgs.effort).toBe('low');
    const schema = passedArgs.outputSchema as Record<string, any>;
    expect(schema.required).toContain('verified');
    expect(schema.required).toContain('relevant');
    expect(schema.required).toContain('reasoning');
    store.dispose();
  });

  it('throws recoverable WorkflowError when agentRuns.create returns an error result', async () => {
    mockedCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Error in agentRuns.create: 429 concurrency cap' }],
      isError: true,
    });
    const task = store.create('agentRuns.verifyItem', { item: { id: 'witem_6' } });

    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /agentRuns\.create failed/,
    );
    expect(mockedAnnotate).not.toHaveBeenCalled();
    store.dispose();
  });

  it('throws non-recoverable WorkflowError when agent_run completes without structured output', async () => {
    mockedCreate.mockResolvedValue(fakeAgentRun(null)); // no structured field
    const task = store.create('agentRuns.verifyItem', { item: { id: 'witem_7' } });

    await expect(workflow(task.id, task.args, {} as any, store)).rejects.toThrow(
      /without structured output/,
    );
    expect(mockedAnnotate).not.toHaveBeenCalled();
    store.dispose();
  });

  it('default prompt embeds the item URL and originalQuery when both provided', async () => {
    mockedCreate.mockResolvedValue(
      fakeAgentRun({ verified: true, relevant: true, reasoning: 'ok' }),
    );
    const task = store.create('agentRuns.verifyItem', {
      item: {
        id: 'witem_8',
        url: 'https://docs.example.com/build',
        name: 'Example Build Docs',
        evaluations: [{ criterion: 'is official docs', satisfied: 'yes' }],
      },
      originalQuery: 'Official docs for build tools',
    });

    await workflow(task.id, task.args, {} as any, store);
    const prompt = (mockedCreate.mock.calls[0][0] as Record<string, unknown>).query as string;
    expect(prompt).toContain('https://docs.example.com/build');
    expect(prompt).toContain('Example Build Docs');
    expect(prompt).toContain('Official docs for build tools');
    expect(prompt).toContain('is official docs');
    store.dispose();
  });
});
