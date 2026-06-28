// Dev/test affordance: inject a synthetic webhook event into the live event
// bus from inside the server. Mirrors semantic.cron.replay — it exists so
// item/idle events are reachable for deterministic, on-demand testing and
// demos via the `execute` tool (tasks.create), since the HTTP /webhooks/exa
// path is not reachable from every environment.
//
// The injected event flows through webhookEventBus.publish() exactly as a real
// webhook would: it is persisted, item events upsert into the shadow store and
// run the receiver rules (candidate emission), and it is broadcast over SSE to
// channel bridges. Detection is synthetic; the ingestion + action layers run live.

import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { registerDevWorkflow, type WorkflowMeta } from './types.js';
import { WorkflowError, withSummary } from './helpers.js';
import { webhookEventBus, createEvent } from '../webhooks/eventBus.js';

async function webhookInjectWorkflow(
  _taskId: string,
  args: Record<string, unknown>,
  _exa: Exa,
  _store: TaskStore,
): Promise<unknown> {
  const event = args.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new WorkflowError(
      'webhook.inject requires args.event with a string `type`, e.g. ' +
        '{ event: { type: "webset.item.enriched", data: { id, websetId, properties, enrichments, evaluations } } }',
      'validate',
    );
  }

  // createEvent treats the passed object AS the webhook payload (same as the
  // receiver does with req.body): payload.type/id drive the event, and
  // payload.data carries the item for the upsert/format path.
  const created = createEvent(event);
  webhookEventBus.publish(created);

  return withSummary(
    {
      injected: true,
      eventId: created.id,
      type: created.type,
    },
    `injected synthetic ${created.type} event (${created.id}) into the webhook bus`,
  );
}

const meta: WorkflowMeta = {
  title: 'Webhook Inject (dev/test)',
  description:
    'Publish a synthetic webhook event to the live event bus from inside the server. The event flows through the same path as a real Exa webhook (persist → item upsert → receiver rules → SSE broadcast to channel bridges). Use for deterministic, on-demand testing and demos of item/idle/candidate notifications when the HTTP /webhooks/exa path is not reachable.',
  category: 'dev',
  parameters: [
    {
      name: 'event',
      type: 'object',
      required: true,
      description:
        'The webhook payload to inject. Must have a string `type` (e.g. "webset.item.created", "webset.item.enriched", "webset.idle"). For item events, include `data: { id, websetId, properties, enrichments, evaluations }`.',
    },
  ],
  steps: [
    'Validate the event payload has a string type',
    'Wrap it via createEvent and publish to webhookEventBus (persist + upsert + receiver rules + SSE broadcast)',
  ],
  output: 'Confirmation with the generated eventId and type.',
  example: `await callOperation('tasks.create', {\n  type: 'webhook.inject',\n  args: { event: { type: 'webset.item.enriched', data: { id: 'witem_x', websetId: 'webset_y', properties: { person: { name: 'Ada' }, url: 'https://x', type: 'person' }, enrichments: [{ status: 'completed', enrichmentId: 'wenrich_1', result: ['v'] }], evaluations: [{ criterion: 'c', satisfied: 'yes' }] } } },\n});`,
  relatedWorkflows: ['semantic.cron.replay'],
  tags: ['dev', 'test', 'webhook', 'inject', 'demo'],
};

registerDevWorkflow('webhook.inject', webhookInjectWorkflow, meta);
