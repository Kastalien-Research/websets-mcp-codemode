import { describe, it, expect } from 'vitest';
import type { Exa } from 'exa-js';
import * as websets from '../websets.js';
import * as searches from '../searches.js';
import * as items from '../items.js';
import * as enrichments from '../enrichments.js';
import * as monitors from '../monitors.js';
import * as webhooks from '../webhooks.js';
import * as imports from '../imports.js';
import * as events from '../events.js';
import type { ToolResult } from '../types.js';

// Dummy Exa — validation fires before any SDK call, so no real client needed
const exa = {} as Exa;

function expectMissingParams(result: ToolResult, operation: string, ...params: string[]) {
  expect(result.isError).toBe(true);
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected leading TextContent');
  expect(first.text).toContain(`Missing required parameter(s) for ${operation}`);
  for (const p of params) {
    expect(first.text).toContain(p);
  }
}

describe('Required parameter guards', () => {
  // Websets domain
  it('websets.get requires id', async () => {
    expectMissingParams(await websets.get({}, exa), 'websets.get', 'id');
  });

  it('websets.update requires id', async () => {
    expectMissingParams(await websets.update({}, exa), 'websets.update', 'id');
  });

  it('websets.delete requires id', async () => {
    expectMissingParams(await websets.del({}, exa), 'websets.delete', 'id');
  });

  it('websets.cancel requires id', async () => {
    expectMissingParams(await websets.cancel({}, exa), 'websets.cancel', 'id');
  });

  it('websets.waitUntilIdle requires id', async () => {
    expectMissingParams(await websets.waitUntilIdle({}, exa), 'websets.waitUntilIdle', 'id');
  });

  it('websets.preview requires query', async () => {
    expectMissingParams(await websets.preview({}, exa), 'websets.preview', 'query');
  });

  // Searches domain
  it('searches.create requires websetId, query', async () => {
    expectMissingParams(await searches.create({}, exa), 'searches.create', 'websetId', 'query');
  });

  it('searches.get requires websetId, searchId', async () => {
    expectMissingParams(await searches.get({}, exa), 'searches.get', 'websetId', 'searchId');
  });

  it('searches.cancel requires websetId, searchId', async () => {
    expectMissingParams(await searches.cancel({}, exa), 'searches.cancel', 'websetId', 'searchId');
  });

  // Items domain
  it('items.list requires websetId', async () => {
    expectMissingParams(await items.list({}, exa), 'items.list', 'websetId');
  });

  it('items.get requires websetId, itemId', async () => {
    expectMissingParams(await items.get({}, exa), 'items.get', 'websetId', 'itemId');
  });

  it('items.getAll requires websetId', async () => {
    expectMissingParams(await items.getAll({}, exa), 'items.getAll', 'websetId');
  });

  it('items.delete requires websetId, itemId', async () => {
    expectMissingParams(await items.del({}, exa), 'items.delete', 'websetId', 'itemId');
  });

  // Enrichments domain
  it('enrichments.create requires websetId, description', async () => {
    expectMissingParams(await enrichments.create({}, exa), 'enrichments.create', 'websetId', 'description');
  });

  it('enrichments.get requires websetId, enrichmentId', async () => {
    expectMissingParams(await enrichments.get({}, exa), 'enrichments.get', 'websetId', 'enrichmentId');
  });

  it('enrichments.cancel requires websetId, enrichmentId', async () => {
    expectMissingParams(await enrichments.cancel({}, exa), 'enrichments.cancel', 'websetId', 'enrichmentId');
  });

  it('enrichments.update requires websetId, enrichmentId', async () => {
    expectMissingParams(await enrichments.update({}, exa), 'enrichments.update', 'websetId', 'enrichmentId');
  });

  it('enrichments.delete requires websetId, enrichmentId', async () => {
    expectMissingParams(await enrichments.del({}, exa), 'enrichments.delete', 'websetId', 'enrichmentId');
  });

  // Monitors domain
  it('monitors.create requires websetId, cron', async () => {
    expectMissingParams(await monitors.create({}, exa), 'monitors.create', 'websetId', 'cron');
  });

  it('monitors.get requires id', async () => {
    expectMissingParams(await monitors.get({}, exa), 'monitors.get', 'id');
  });

  it('monitors.update requires id', async () => {
    expectMissingParams(await monitors.update({}, exa), 'monitors.update', 'id');
  });

  it('monitors.delete requires id', async () => {
    expectMissingParams(await monitors.del({}, exa), 'monitors.delete', 'id');
  });

  it('monitors.runs.list requires monitorId', async () => {
    expectMissingParams(await monitors.runsList({}, exa), 'monitors.runs.list', 'monitorId');
  });

  it('monitors.runs.get requires monitorId, runId', async () => {
    expectMissingParams(await monitors.runsGet({}, exa), 'monitors.runs.get', 'monitorId', 'runId');
  });

  // Webhooks domain
  it('webhooks.create requires url, events', async () => {
    expectMissingParams(await webhooks.create({}, exa), 'webhooks.create', 'url', 'events');
  });

  it('webhooks.get requires id', async () => {
    expectMissingParams(await webhooks.get({}, exa), 'webhooks.get', 'id');
  });

  it('webhooks.update requires id', async () => {
    expectMissingParams(await webhooks.update({}, exa), 'webhooks.update', 'id');
  });

  it('webhooks.delete requires id', async () => {
    expectMissingParams(await webhooks.del({}, exa), 'webhooks.delete', 'id');
  });

  it('webhooks.list_attempts requires id', async () => {
    expectMissingParams(await webhooks.listAttempts({}, exa), 'webhooks.list_attempts', 'id');
  });

  it('webhooks.getAllAttempts requires id', async () => {
    expectMissingParams(await webhooks.getAllAttempts({}, exa), 'webhooks.getAllAttempts', 'id');
  });

  // Imports domain
  it('imports.create requires format, entity, count, size', async () => {
    expectMissingParams(await imports.create({}, exa), 'imports.create', 'format', 'entity', 'count', 'size');
  });

  it('imports.get requires id', async () => {
    expectMissingParams(await imports.get({}, exa), 'imports.get', 'id');
  });

  it('imports.update requires id', async () => {
    expectMissingParams(await imports.update({}, exa), 'imports.update', 'id');
  });

  it('imports.delete requires id', async () => {
    expectMissingParams(await imports.del({}, exa), 'imports.delete', 'id');
  });

  it('imports.waitUntilCompleted requires id', async () => {
    expectMissingParams(await imports.waitUntilCompleted({}, exa), 'imports.waitUntilCompleted', 'id');
  });

  // Events domain
  it('events.get requires id', async () => {
    expectMissingParams(await events.get({}, exa), 'events.get', 'id');
  });
});
