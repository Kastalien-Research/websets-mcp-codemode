// Express routes for receiving Exa webhooks and streaming events via SSE.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { verifyExaSignature } from './signature.js';
import { webhookEventBus, createEvent } from './eventBus.js';

export function createWebhookRouter(secret?: string): Router {
  const router = Router();

  // POST /webhooks/exa — receive Exa webhook events
  router.post('/webhooks/exa', (req: Request, res: Response) => {
    // Verify signature if secret is configured
    if (secret) {
      const sigHeader = req.headers['exa-signature'] as string | undefined;
      const rawBody = (req as any).__rawBody as Buffer | undefined;

      if (!sigHeader || !rawBody) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }

      if (!verifyExaSignature(rawBody, sigHeader, secret)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const payload = req.body as Record<string, unknown>;
    const event = createEvent(payload);
    webhookEventBus.publish(event);

    res.status(200).json({ received: true, eventId: event.id });
  });

  // GET /webhooks/events — SSE stream for channel bridges
  router.get('/webhooks/events', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connection message
    res.write(': connected\n\n');

    // Subscribe to events
    const unsubscribe = webhookEventBus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keepalive every 30 seconds
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);

    // Clean up on disconnect
    _req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });
  });

  // GET /webhooks/status — health check for webhook system
  router.get('/webhooks/status', (_req: Request, res: Response) => {
    res.json({
      subscribers: webhookEventBus.subscriberCount,
      signatureVerification: !!secret,
    });
  });

  return router;
}
