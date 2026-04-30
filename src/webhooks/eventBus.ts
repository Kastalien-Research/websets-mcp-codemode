// In-memory pub/sub that decouples webhook ingestion from SSE delivery.
// Also writes to SQLite for persistence.

import crypto from 'node:crypto';
import { upsertItem, insertEvent } from '../store/db.js';
import { processWebhookItem } from './receiverRules.js';

/** Maps webset IDs to lens IDs for the design-partner radar. */
let websetLensMap = new Map<string, string>();

export function setWebsetLensMap(map: Map<string, string>): void {
  websetLensMap = map;
}

export function getWebsetLensMap(): Map<string, string> {
  return websetLensMap;
}

export interface WebhookEvent {
  id: string;
  type: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

type Subscriber = (event: WebhookEvent) => void;

class WebhookEventBus {
  private subscribers = new Set<Subscriber>();

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  publish(event: WebhookEvent): void {
    // Persist to SQLite
    try {
      insertEvent({
        id: event.id,
        type: event.type,
        websetId: extractWebsetId(event),
        payload: event.payload,
      });

      // For item events, upsert into items table
      if (event.type === 'webset.item.created' || event.type === 'webset.item.enriched') {
        const data = event.payload.data as Record<string, unknown> | undefined;
        if (data?.id) {
          const props = (data.properties ?? {}) as Record<string, unknown>;
          const company = props.company as Record<string, unknown> | undefined;
          const person = props.person as Record<string, unknown> | undefined;
          const article = props.article as Record<string, unknown> | undefined;
          const custom = props.custom as Record<string, unknown> | undefined;

          const name = (
            company?.name ?? person?.name ?? article?.title ??
            custom?.title ?? props.description ?? ''
          ) as string;

          const enrichments = (data.enrichments as Array<Record<string, unknown>> | undefined)
            ?.filter((e) => e.status === 'completed' && (e.result as unknown[] | null)?.length)
            ?.reduce((acc, e) => {
              // Webhook payloads have enrichmentId but not description;
              // description is only on the webset definition, not on item results
              const key = (e.description ?? e.enrichmentId ?? 'unknown') as string;
              acc[key] = (e.result as unknown[])[0];
              return acc;
            }, {} as Record<string, unknown>);

          upsertItem({
            id: data.id as string,
            websetId: (data.websetId ?? extractWebsetId(event) ?? '') as string,
            name: name || undefined,
            url: ((props.url ?? '') as string) || undefined,
            entityType: ((props.type ?? 'unknown') as string) || undefined,
            enrichments,
            evaluations: data.evaluations as unknown[] | undefined,
            raw: data,
            createdAt: data.createdAt as string | undefined,
          });
        }
      }
      // Process through receiver rules for item events
      if (event.type === 'webset.item.created' || event.type === 'webset.item.enriched') {
        try {
          const candidate = processWebhookItem(event, websetLensMap);
          if (candidate) {
            // Emit a synthetic event for the candidate
            const candidateEvent: WebhookEvent = {
              id: `${event.id}_candidate`,
              type: 'NEW_OPPORTUNITY_CANDIDATE',
              receivedAt: new Date().toISOString(),
              payload: { candidate },
            };
            // Persist the candidate event
            insertEvent({
              id: candidateEvent.id,
              type: candidateEvent.type,
              payload: candidateEvent.payload,
            });
            // Broadcast candidate event after the original
            for (const cb of this.subscribers) {
              try { cb(candidateEvent); } catch { /* non-fatal */ }
            }
          }
        } catch (err) {
          console.error(
            `[webhookEventBus] receiver-rule error for event ${event.id} `
            + `(type=${event.type}):`,
            err,
          );
        }
      }
    } catch (err) {
      console.error(
        `[webhookEventBus] SQLite persist failed for event ${event.id} `
        + `(type=${event.type}). Event will still be broadcast over SSE but `
        + `will not appear in the shadow store.`,
        err,
      );
    }

    // Broadcast to SSE subscribers
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch (err) {
        console.error(
          `[webhookEventBus] subscriber callback threw for event ${event.id} `
          + `(type=${event.type}). Other subscribers will still receive the event.`,
          err,
        );
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

function extractWebsetId(event: WebhookEvent): string | undefined {
  const data = event.payload.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  // Item events have websetId on the item
  if (data.websetId) return data.websetId as string;
  // Webset events have id on the webset itself
  if (event.type.startsWith('webset.') && !event.type.includes('item') && data.id) {
    return data.id as string;
  }
  return undefined;
}

export function createEvent(payload: Record<string, unknown>): WebhookEvent {
  return {
    id: (payload.id as string) ?? crypto.randomUUID(),
    type: (payload.type as string) ?? 'unknown',
    receivedAt: new Date().toISOString(),
    payload,
  };
}

export const webhookEventBus = new WebhookEventBus();
