import { describe, it, expect, vi } from 'vitest';
import { create, update } from '../enrichments.js';
import type { Exa } from 'exa-js';

function mockExa(): Exa {
  return {
    websets: {
      enrichments: {
        create: vi.fn().mockResolvedValue({ id: 'enr_123', status: 'running' }),
      },
    },
  } as unknown as Exa;
}

describe('enrichments.create validation', () => {
  it('rejects options format without options array', async () => {
    const exa = mockExa();
    const result = await create(
      { websetId: 'ws_1', description: 'test', format: 'options' },
      exa,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('you must provide the options parameter');
  });

  it('rejects options format with empty options array', async () => {
    const exa = mockExa();
    const result = await create(
      { websetId: 'ws_1', description: 'test', format: 'options', options: [] },
      exa,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('you must provide the options parameter');
  });

  it('rejects more than 150 options', async () => {
    const exa = mockExa();
    const options = Array.from({ length: 151 }, (_, i) => ({ label: `opt${i}` }));
    const result = await create(
      { websetId: 'ws_1', description: 'test', format: 'options', options },
      exa,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Too many options: 151');
    expect(result.content[0].text).toContain('Maximum is 150');
  });

  it('accepts valid options format', async () => {
    const exa = mockExa();
    const result = await create(
      {
        websetId: 'ws_1',
        description: 'Company stage',
        format: 'options',
        options: [{ label: 'Seed' }, { label: 'Series A' }],
      },
      exa,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('enr_123');
    expect(parsed.status).toBe('running');
  });

  it('accepts text format without options', async () => {
    const exa = mockExa();
    const result = await create(
      { websetId: 'ws_1', description: 'CEO name', format: 'text' },
      exa,
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('enrichments.update', () => {
  function mockUpdateExa() {
    const updateFn = vi.fn().mockResolvedValue(undefined);
    const getFn = vi.fn().mockResolvedValue({
      id: 'enr_9',
      status: 'completed',
      description: 'Founded year (updated)',
    });
    const exa = {
      websets: { enrichments: { update: updateFn, get: getFn } },
    } as unknown as Exa;
    return { exa, updateFn, getFn };
  }

  it('returns the fetched enrichment after a successful update', async () => {
    const { exa, updateFn, getFn } = mockUpdateExa();
    const result = await update(
      { websetId: 'ws_1', enrichmentId: 'enr_9', description: 'Founded year (updated)' },
      exa,
    );

    expect(result.isError).toBeUndefined();
    // confirmed state is fetched, not synthesized
    expect(updateFn).toHaveBeenCalledWith('ws_1', 'enr_9', { description: 'Founded year (updated)' });
    expect(getFn).toHaveBeenCalledWith('ws_1', 'enr_9');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('enr_9');
    expect(parsed.status).toBe('completed');
    expect(parsed.success).toBeUndefined();
  });

  it('surfaces an error result when the update call throws', async () => {
    const exa = {
      websets: {
        enrichments: {
          update: vi.fn().mockRejectedValue(new Error('boom')),
          get: vi.fn(),
        },
      },
    } as unknown as Exa;
    const result = await update({ websetId: 'ws_1', enrichmentId: 'enr_9' }, exa);
    expect(result.isError).toBe(true);
  });
});
