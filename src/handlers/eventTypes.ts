import { z } from 'zod';

/**
 * Canonical EventType enum from the Exa spec (May 2026, 19 values).
 *
 * Shared by:
 *   - events.list / events.getAll (`types` filter)
 *   - webhooks.create / webhooks.update (`events` subscription)
 *   - webhooks.listAttempts / webhooks.getAllAttempts (`eventType` filter)
 *
 * NOTE: spec code samples occasionally reference `webset.completed` and
 * `enrichment.completed` — these are NOT in the formal enum and should be
 * rejected at validation.
 */
export const EVENT_TYPES = [
  'webset.created',
  'webset.deleted',
  'webset.paused',
  'webset.idle',
  'webset.search.created',
  'webset.search.canceled',
  'webset.search.completed',
  'webset.search.updated',
  'import.created',
  'import.completed',
  'webset.item.created',
  'webset.item.enriched',
  'monitor.created',
  'monitor.updated',
  'monitor.deleted',
  'monitor.run.created',
  'monitor.run.completed',
  'webset.export.created',
  'webset.export.completed',
] as const;

export const EventTypeEnum = z.enum(EVENT_TYPES);

export type EventType = (typeof EVENT_TYPES)[number];
