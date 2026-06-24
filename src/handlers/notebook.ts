// notebook.* operations — a first-class Code Mode domain for thesis notebooks.
//
// A thesis is a durable, re-runnable `.src.md` notebook (see src/notebook/).
// A code cell's `source` is Code Mode: notebook.runCell executes it through the
// same sandbox the `execute` tool uses, so a notebook is the persisted form of
// an execute session.

import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult, requireParams } from './types.js';
import {
  createNotebook,
  readNotebook,
  renderNotebook,
  appendCell,
  appendRun,
  listNotebookIndex,
  type NotebookRun,
} from '../notebook/store.js';
import type { Cell } from '../notebook/srcmd.js';
import { executeInSandbox } from '../tools/sandbox.js';

export const Schemas = {
  create: z.object({
    thesis: z.string().describe('The thesis statement to investigate'),
    slug: z.string().optional().describe('Optional explicit slug; derived from the thesis otherwise'),
  }),
  get: z.object({
    slug: z.string(),
  }),
  appendCell: z.object({
    slug: z.string(),
    cell: z.object({
      type: z.enum(['markdown', 'code']),
      text: z.string().optional(),
      filename: z.string().optional(),
      source: z.string().optional(),
    }),
  }),
  appendRun: z.object({
    slug: z.string(),
    run: z.object({
      timestamp: z.string().optional(),
      verdict: z.string(),
      confidence: z.number(),
      evidenceFor: z.array(z.string()).optional(),
      evidenceAgainst: z.array(z.string()).optional(),
      blindSpots: z.array(z.string()).optional(),
      websetIds: z.array(z.string()).optional(),
    }),
  }),
  runCell: z.object({
    slug: z.string(),
    cellId: z.union([z.string(), z.number()]).describe('Code cell index, or its filename'),
  }),
  list: z.object({
    verdict: z.string().optional(),
  }),
  render: z.object({
    slug: z.string(),
  }),
};

/** Attach a stable id (index) to each cell for the response surface. */
function withIds(cells: Cell[]): Array<Cell & { id: number }> {
  return cells.map((c, i) => ({ ...c, id: i }));
}

export const create: OperationHandler = async (args) => {
  const guard = requireParams('notebook.create', args, 'thesis');
  if (guard) return guard;
  try {
    const nb = createNotebook({ thesis: args.thesis as string, slug: args.slug as string | undefined });
    return successResult({ slug: nb.slug, title: (nb.cells[0] as any)?.text, created: true });
  } catch (error) {
    return errorResult('notebook.create', error);
  }
};

export const get: OperationHandler = async (args) => {
  const guard = requireParams('notebook.get', args, 'slug');
  if (guard) return guard;
  try {
    const nb = readNotebook(args.slug as string);
    return successResult({
      slug: nb.slug,
      meta: nb.meta,
      manifest: nb.manifest,
      cells: withIds(nb.cells),
      runs: nb.runs,
    });
  } catch (error) {
    return errorResult('notebook.get', error);
  }
};

export const appendCellOp: OperationHandler = async (args) => {
  const guard = requireParams('notebook.appendCell', args, 'slug', 'cell');
  if (guard) return guard;
  try {
    const input = args.cell as { type: 'markdown' | 'code'; text?: string; filename?: string; source?: string };
    let cell: Cell;
    if (input.type === 'code') {
      if (!input.filename || input.source === undefined) {
        return errorResult('notebook.appendCell', new Error('code cells require filename and source'));
      }
      cell = { type: 'code', filename: input.filename, source: input.source };
    } else {
      if (input.text === undefined) {
        return errorResult('notebook.appendCell', new Error('markdown cells require text'));
      }
      cell = { type: 'markdown', text: input.text };
    }
    const nb = appendCell(args.slug as string, cell);
    return successResult({ slug: nb.slug, cellCount: nb.cells.length, appended: cell });
  } catch (error) {
    return errorResult('notebook.appendCell', error);
  }
};

export const appendRunOp: OperationHandler = async (args) => {
  const guard = requireParams('notebook.appendRun', args, 'slug', 'run');
  if (guard) return guard;
  try {
    const input = args.run as Partial<NotebookRun> & { verdict: string; confidence: number };
    const run: NotebookRun = {
      timestamp: input.timestamp ?? new Date().toISOString(),
      verdict: input.verdict,
      confidence: input.confidence,
      evidenceFor: input.evidenceFor ?? [],
      evidenceAgainst: input.evidenceAgainst ?? [],
      blindSpots: input.blindSpots,
      websetIds: input.websetIds,
    };
    const nb = appendRun(args.slug as string, run);
    return successResult({ slug: nb.slug, runCount: nb.runs.length, verdict: run.verdict, confidence: run.confidence });
  } catch (error) {
    return errorResult('notebook.appendRun', error);
  }
};

export const runCell: OperationHandler = async (args, exa, ctx) => {
  const guard = requireParams('notebook.runCell', args, 'slug', 'cellId');
  if (guard) return guard;
  try {
    const slug = args.slug as string;
    const cellId = args.cellId as string | number;
    const nb = readNotebook(slug);

    // Resolve the target cell by numeric index or by code-cell filename.
    let target: Cell | undefined;
    const asNum = typeof cellId === 'number' ? cellId : Number(cellId);
    if (Number.isInteger(asNum) && String(asNum) === String(cellId)) {
      target = nb.cells[asNum];
    } else {
      target = nb.cells.find(c => c.type === 'code' && c.filename === cellId);
    }
    if (!target) {
      return errorResult('notebook.runCell', new Error(`Cell not found: ${cellId}`));
    }
    if (target.type !== 'code') {
      return errorResult('notebook.runCell', new Error(`Cell ${cellId} is not a code cell`));
    }

    const sandboxResult = await executeInSandbox(target.source, exa, { ctx });

    const resultJson = JSON.stringify(sandboxResult.result, null, 2);
    const logsBlock = sandboxResult.logs.length
      ? `\n\n**Logs:**\n${sandboxResult.logs.map(l => `- ${l}`).join('\n')}`
      : '';
    const resultCell: Cell = {
      type: 'markdown',
      text:
        `### Result of ${target.filename} @ ${new Date().toISOString()}\n\n` +
        '```json\n' +
        `${resultJson}\n` +
        '```' +
        logsBlock,
    };
    const updated = appendCell(slug, resultCell);

    return successResult({
      slug,
      cell: target.filename,
      result: sandboxResult.result,
      logs: sandboxResult.logs,
      cellCount: updated.cells.length,
    });
  } catch (error) {
    return errorResult('notebook.runCell', error);
  }
};

export const list: OperationHandler = async (args) => {
  try {
    const rows = listNotebookIndex(args.verdict as string | undefined);
    return successResult({ notebooks: rows, count: rows.length });
  } catch (error) {
    return errorResult('notebook.list', error);
  }
};

export const render: OperationHandler = async (args) => {
  const guard = requireParams('notebook.render', args, 'slug');
  if (guard) return guard;
  try {
    const text = renderNotebook(args.slug as string);
    return successResult({ slug: args.slug, srcmd: text });
  } catch (error) {
    return errorResult('notebook.render', error);
  }
};
