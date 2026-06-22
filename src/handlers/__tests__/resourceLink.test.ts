import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Exa } from 'exa-js';
import { create } from '../tasks.js';
import { successResultWithLinks, type ResourceLinkContent } from '../types.js';

// Echo (no metadata) covers the "unknown metadata" path; lifecycle.harvest
// (has metadata) covers the resource_link-emitting path.
import '../../workflows/echo.js';
import '../../workflows/lifecycle.js';
import { workflowMetadata } from '../../workflows/types.js';

vi.mock('../../lib/taskStore.js', async (importOriginal) => {
  const mod = await importOriginal() as any;
  const testStore = new mod.TaskStore();
  return { ...mod, taskStore: testStore };
});

import { taskStore } from '../../lib/taskStore.js';

function mockExa(): Exa {
  return {} as unknown as Exa;
}

describe('resource_link enrichment', () => {
  afterEach(() => {
    (taskStore as any).tasks?.clear?.();
  });

  describe('tasks.create', () => {
    it('attaches a resource_link for workflows with metadata', async () => {
      // lifecycle.harvest is registered with WorkflowMeta — see src/workflows/lifecycle.ts
      const meta = workflowMetadata.get('lifecycle.harvest');
      expect(meta).toBeDefined();

      const res = await create({ type: 'lifecycle.harvest', args: {} }, mockExa());
      expect(res.isError).toBeUndefined();

      // First block: JSON payload
      const first = res.content[0];
      expect(first.type).toBe('text');
      if (first.type !== 'text') throw new Error('unreachable');
      const data = JSON.parse(first.text);
      expect(data.taskId).toMatch(/^task_/);
      expect(data.status).toBe('pending');

      // Second block: resource_link to workflow://<type>
      expect(res.content).toHaveLength(2);
      const second = res.content[1];
      expect(second.type).toBe('resource_link');
      if (second.type !== 'resource_link') throw new Error('unreachable');
      expect(second.uri).toBe('workflow://lifecycle.harvest');
      expect(second.name).toBe(meta!.title);
      expect(second.mimeType).toBe('text/markdown');
      expect(second.description).toBeDefined();
    });

    it('omits the resource_link when the workflow has no metadata', async () => {
      // echo is registered without metadata — see src/workflows/echo.ts
      expect(workflowMetadata.has('echo')).toBe(false);

      const res = await create({ type: 'echo', args: { message: 'hi' } }, mockExa());
      expect(res.isError).toBeUndefined();
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe('text');
    });
  });

  describe('successResultWithLinks helper', () => {
    it('emits only the text block when links is empty', () => {
      const res = successResultWithLinks({ ok: true }, []);
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe('text');
      // Sanity: no trailing undefined / placeholder entries
      expect(res.content.every(c => c.type === 'text' || c.type === 'resource_link')).toBe(true);
    });

    it('appends each provided resource_link after the text block', () => {
      const links: ResourceLinkContent[] = [
        { type: 'resource_link', uri: 'workflow://a', name: 'A', mimeType: 'text/markdown' },
        { type: 'resource_link', uri: 'workflow://b', name: 'B' },
      ];
      const res = successResultWithLinks({ ok: true }, links);
      expect(res.content).toHaveLength(3);
      expect(res.content[0].type).toBe('text');
      expect(res.content[1]).toEqual(links[0]);
      expect(res.content[2]).toEqual(links[1]);
    });
  });

  describe('search-tool workflow domain enrichment', () => {
    // We don't boot the MCP server; instead exercise the same projection
    // logic the search tool uses: when a catalog entry's name begins with
    // `workflow.`, derive the matching `workflow://<key>` resource_link.
    it('derives a resource_link per workflow-domain catalog hit', async () => {
      const { searchCatalog, resetCatalog } = await import('../../tools/catalog.js');
      resetCatalog();
      const result = searchCatalog('lifecycle', { domain: 'workflow', detail: 'brief', limit: 5 });
      const workflowHits = result.results.filter(r => typeof r.name === 'string' && (r.name as string).startsWith('workflow.'));
      expect(workflowHits.length).toBeGreaterThan(0);

      const links: ResourceLinkContent[] = [];
      for (const entry of result.results) {
        const name = entry.name as string;
        if (!name.startsWith('workflow.')) continue;
        const key = name.slice('workflow.'.length);
        const meta = workflowMetadata.get(key);
        if (!meta) continue;
        links.push({
          type: 'resource_link',
          uri: `workflow://${key}`,
          name: meta.title,
          mimeType: 'text/markdown',
          description: meta.description.split('.')[0],
        });
      }
      const harvestLink = links.find(l => l.uri === 'workflow://lifecycle.harvest');
      expect(harvestLink).toBeDefined();
      expect(harvestLink!.mimeType).toBe('text/markdown');
    });
  });
});
