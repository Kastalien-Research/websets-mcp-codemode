import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  registerDevWorkflow,
  devWorkflowsEnabled,
  workflowRegistry,
} from '../types.js';

const noop = async () => undefined;

describe('registerDevWorkflow gating', () => {
  const original = process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;
  const testType = 'test.dev.gated';

  beforeEach(() => {
    workflowRegistry.delete(testType);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;
    else process.env.WEBSETS_ENABLE_DEV_WORKFLOWS = original;
    workflowRegistry.delete(testType);
  });

  it('registers a dev workflow when WEBSETS_ENABLE_DEV_WORKFLOWS=1', () => {
    process.env.WEBSETS_ENABLE_DEV_WORKFLOWS = '1';
    expect(devWorkflowsEnabled()).toBe(true);
    registerDevWorkflow(testType, noop);
    expect(workflowRegistry.has(testType)).toBe(true);
  });

  it('skips registration when the flag is unset', () => {
    delete process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;
    expect(devWorkflowsEnabled()).toBe(false);
    registerDevWorkflow(testType, noop);
    expect(workflowRegistry.has(testType)).toBe(false);
  });

  it('treats values other than "1" as disabled', () => {
    process.env.WEBSETS_ENABLE_DEV_WORKFLOWS = 'true';
    expect(devWorkflowsEnabled()).toBe(false);
    registerDevWorkflow(testType, noop);
    expect(workflowRegistry.has(testType)).toBe(false);
  });
});

describe('production workflow surface (flag unset by default)', () => {
  it('registers real workflows but gates the dev/demo ones', async () => {
    const original = process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;

    try {
      delete process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;
      await import('../index.js');
    } finally {
      if (original === undefined) delete process.env.WEBSETS_ENABLE_DEV_WORKFLOWS;
      else process.env.WEBSETS_ENABLE_DEV_WORKFLOWS = original;
    }

    expect(workflowRegistry.has('semantic.cron')).toBe(true);
    expect(workflowRegistry.has('webhook.inject')).toBe(false);
    expect(workflowRegistry.has('semantic.cron.replay')).toBe(false);
  });
});
