import { describe, it, expect } from 'vitest';

// We test the OPERATIONS registry by importing the handler modules directly.
// Since the registry is defined in operations.ts, we verify coverage by counting handler exports.

import * as websets from '../websets.js';
import * as searches from '../searches.js';
import * as items from '../items.js';
import * as enrichments from '../enrichments.js';
import * as monitors from '../monitors.js';
import * as webhooks from '../webhooks.js';
import * as imports from '../imports.js';
import * as events from '../events.js';
import * as tasks from '../tasks.js';
import * as research from '../research.js';
import * as exaSearch from '../exa.js';

describe('Handler modules export expected operations', () => {
  it('websets exports 9 handlers', () => {
    expect(typeof websets.create).toBe('function');
    expect(typeof websets.get).toBe('function');
    expect(typeof websets.list).toBe('function');
    expect(typeof websets.update).toBe('function');
    expect(typeof websets.del).toBe('function');
    expect(typeof websets.cancel).toBe('function');
    expect(typeof websets.preview).toBe('function');
    expect(typeof websets.waitUntilIdle).toBe('function');
    expect(typeof websets.getAll).toBe('function');
  });

  it('searches exports 3 handlers', () => {
    expect(typeof searches.create).toBe('function');
    expect(typeof searches.get).toBe('function');
    expect(typeof searches.cancel).toBe('function');
  });

  it('items exports 4 handlers', () => {
    expect(typeof items.list).toBe('function');
    expect(typeof items.get).toBe('function');
    expect(typeof items.del).toBe('function');
    expect(typeof items.getAll).toBe('function');
  });

  it('enrichments exports 5 handlers', () => {
    expect(typeof enrichments.create).toBe('function');
    expect(typeof enrichments.get).toBe('function');
    expect(typeof enrichments.cancel).toBe('function');
    expect(typeof enrichments.update).toBe('function');
    expect(typeof enrichments.del).toBe('function');
  });

  it('monitors exports 8 handlers', () => {
    expect(typeof monitors.create).toBe('function');
    expect(typeof monitors.get).toBe('function');
    expect(typeof monitors.list).toBe('function');
    expect(typeof monitors.update).toBe('function');
    expect(typeof monitors.del).toBe('function');
    expect(typeof monitors.runsList).toBe('function');
    expect(typeof monitors.runsGet).toBe('function');
    expect(typeof monitors.getAll).toBe('function');
  });

  it('webhooks exports 8 handlers', () => {
    expect(typeof webhooks.create).toBe('function');
    expect(typeof webhooks.get).toBe('function');
    expect(typeof webhooks.list).toBe('function');
    expect(typeof webhooks.update).toBe('function');
    expect(typeof webhooks.del).toBe('function');
    expect(typeof webhooks.listAttempts).toBe('function');
    expect(typeof webhooks.getAll).toBe('function');
    expect(typeof webhooks.getAllAttempts).toBe('function');
  });

  it('imports exports 7 handlers', () => {
    expect(typeof imports.create).toBe('function');
    expect(typeof imports.get).toBe('function');
    expect(typeof imports.list).toBe('function');
    expect(typeof imports.update).toBe('function');
    expect(typeof imports.del).toBe('function');
    expect(typeof imports.waitUntilCompleted).toBe('function');
    expect(typeof imports.getAll).toBe('function');
  });

  it('events exports 3 handlers', () => {
    expect(typeof events.list).toBe('function');
    expect(typeof events.get).toBe('function');
    expect(typeof events.getAll).toBe('function');
  });

  it('tasks exports 5 handlers', () => {
    expect(typeof tasks.create).toBe('function');
    expect(typeof tasks.get).toBe('function');
    expect(typeof tasks.result).toBe('function');
    expect(typeof tasks.list).toBe('function');
    expect(typeof tasks.cancel).toBe('function');
  });

  it('research exports 4 handlers', () => {
    expect(typeof research.create).toBe('function');
    expect(typeof research.get).toBe('function');
    expect(typeof research.list).toBe('function');
    expect(typeof research.pollUntilFinished).toBe('function');
  });

  it('exa exports 4 handlers', () => {
    expect(typeof exaSearch.search).toBe('function');
    expect(typeof exaSearch.findSimilar).toBe('function');
    expect(typeof exaSearch.getContents).toBe('function');
    expect(typeof exaSearch.answer).toBe('function');
  });

  it('total operation count is 71 (60 handlers + 11 schema objects)', () => {
    const handlerCount =
      Object.keys(websets).length +     // 10 (9 + 1)
      Object.keys(searches).length +    // 4  (3 + 1)
      Object.keys(items).length +       // 5  (4 + 1)
      Object.keys(enrichments).length + // 6  (5 + 1)
      Object.keys(monitors).length +    // 9  (8 + 1)
      Object.keys(webhooks).length +    // 9  (8 + 1)
      Object.keys(imports).length +     // 8  (7 + 1)
      Object.keys(events).length +      // 4  (3 + 1)
      Object.keys(tasks).length +      // 6  (5 + 1)
      Object.keys(research).length +   // 5  (4 + 1)
      Object.keys(exaSearch).length;   // 5  (4 + 1)
    expect(handlerCount).toBe(71);
  });
});
