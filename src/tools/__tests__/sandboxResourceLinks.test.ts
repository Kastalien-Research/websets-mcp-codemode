import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dispatchOperation at the module level so we can fabricate handler
// responses with resource_link blocks without booting the full operations
// registry. Lives in its own file to keep the standard sandbox.test.ts
// running against the real registry.
vi.mock('../operations.js', () => ({
  dispatchOperation: vi.fn(),
}));

import { dispatchOperation } from '../operations.js';
import { executeInSandbox } from '../sandbox.js';

const mockedDispatch = dispatchOperation as unknown as ReturnType<typeof vi.fn>;

function exa(): any {
  return { search: vi.fn(), websets: {} };
}

describe('executeInSandbox — resource_link forwarding', () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
  });

  it('collects resource_link blocks from a single callOperation', async () => {
    mockedDispatch.mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ taskId: 'task_123', status: 'pending' }) },
        {
          type: 'resource_link',
          uri: 'workflow://qd.winnow',
          name: 'Quality-Diversity Winnow',
          mimeType: 'text/markdown',
        },
      ],
    });

    const { result, resourceLinks } = await executeInSandbox(
      `return await callOperation('tasks.create', { type: 'qd.winnow' });`,
      exa(),
    );

    expect(result).toEqual({ taskId: 'task_123', status: 'pending' });
    expect(resourceLinks).toHaveLength(1);
    expect(resourceLinks[0]).toMatchObject({
      type: 'resource_link',
      uri: 'workflow://qd.winnow',
      name: 'Quality-Diversity Winnow',
    });
  });

  it('accumulates resource_link blocks across multiple callOperation invocations', async () => {
    mockedDispatch.mockImplementation(async (op: string) => {
      if (op === 'tasks.create') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ taskId: 't1' }) },
            { type: 'resource_link', uri: 'workflow://echo', name: 'Echo' },
          ],
        };
      }
      if (op === 'websets.create') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ id: 'ws_1' }) },
            { type: 'resource_link', uri: 'workflow://lifecycle.harvest', name: 'Lifecycle Harvest' },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'null' }] };
    });

    const { resourceLinks } = await executeInSandbox(
      `
      await callOperation('tasks.create', { type: 'echo' });
      await callOperation('websets.create', { searchQuery: 'x' });
      await callOperation('items.list', { websetId: 'ws_1' });
      return 'done';
      `,
      exa(),
    );

    const uris = resourceLinks.map(l => l.uri);
    expect(uris).toContain('workflow://echo');
    expect(uris).toContain('workflow://lifecycle.harvest');
    expect(resourceLinks).toHaveLength(2);
  });

  it('returns empty resourceLinks when no operation attached any links', async () => {
    mockedDispatch.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });

    const { result, resourceLinks } = await executeInSandbox(
      `return await callOperation('exa.search', { query: 'x' });`,
      exa(),
    );

    expect(result).toEqual({ ok: true });
    expect(resourceLinks).toEqual([]);
  });

  it('ignores non-resource_link blocks past content[0] (forward-compat)', async () => {
    mockedDispatch.mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ ok: true }) },
        // Hypothetical future content type the sandbox doesn't recognize:
        { type: 'image', data: 'base64...', mimeType: 'image/png' } as any,
        { type: 'resource_link', uri: 'workflow://x', name: 'X' },
      ],
    });

    const { resourceLinks } = await executeInSandbox(
      `return await callOperation('tasks.create', { type: 'x' });`,
      exa(),
    );

    expect(resourceLinks).toHaveLength(1);
    expect(resourceLinks[0].uri).toBe('workflow://x');
  });

  it('handles operations that return only a text block (no extra content)', async () => {
    mockedDispatch.mockResolvedValue({
      content: [{ type: 'text', text: '42' }],
    });

    const { result, resourceLinks } = await executeInSandbox(
      `return await callOperation('whatever', {});`,
      exa(),
    );

    expect(result).toBe(42);
    expect(resourceLinks).toEqual([]);
  });
});
