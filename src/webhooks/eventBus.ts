// In-memory pub/sub that decouples webhook ingestion from SSE delivery.
// Also writes to SQLite for persistence.

import crypto from 'node:crypto';
import { upsertItem, insertEvent } from '../store/db.js';

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
              acc[e.description as string] = (e.result as unknown[])[0];
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
    } catch {
      // SQLite errors are non-fatal — don't block event delivery
    }

    // Broadcast to SSE subscribers
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // Individual subscriber errors are non-fatal
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
