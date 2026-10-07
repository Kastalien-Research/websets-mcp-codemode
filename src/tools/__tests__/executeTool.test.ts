import { describe, it, expect, vi } from 'vitest';
import type { Exa } from 'exa-js';
import { executeInputSchema, runExecute } from '../executeTool.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function fakeExa() {
  return {
    search: vi.fn(async () => ({ results: [{ url: 'https://example.com', title: 't' }] })),
    websets: { list: vi.fn(async () => ({ data: [] })) },
  } as unknown as Exa & { search: ReturnType<typeof vi.fn> };
}

const envelope = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse((r.content[0] as { text: string }).text);

describe('execute with asOf', () => {
  it('stamps the pinned instant on the envelope and bounds search through it', async () => {
    const exa = fakeExa();
    const asOf = daysAgo(30);
    const r = await runExecute({ code: "return await callOperation('exa.search', { query: 'q' })", asOf }, exa);
    const out = envelope(r);
    expect(out.asOf).toBe(`${asOf}T00:00:00Z`);
    expect(out.result.temporal).toMatchObject({ snapshotAsOf: out.asOf, discovery: 'current-ranking' });
    expect(exa.search).toHaveBeenCalledWith('q', { contents: { snapshotAsOf: out.asOf } });
  });

  it('refuses operations that cannot be pinned, inside the run', async () => {
    const r = await runExecute({ code: "return await callOperation('websets.list', {})", asOf: daysAgo(30) }, fakeExa());
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('TEMPORAL_BOUNDARY: websets.list cannot run in a run pinned to');
  });

  it('leaves unpinned runs unstamped', async () => {
    const out = envelope(await runExecute({ code: 'return 1' }, fakeExa()));
    expect(out).toEqual({ result: 1 });
  });

  it('rejects malformed, future and out-of-window instants in the input schema', () => {
    for (const asOf of ['yesterday', daysAgo(-2), daysAgo(200)]) {
      expect(executeInputSchema.safeParse({ code: 'return 1', asOf }).success, asOf).toBe(false);
    }
  });
});
