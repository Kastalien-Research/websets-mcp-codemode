# websets-webhook-buffer (Cloudflare Worker)

Durable buffer for Exa webhook deliveries. See `src/index.ts` for the design
rationale (the Worker never sees the webhook secret).

## First-time setup

The D1 database referenced in `wrangler.toml` (`database_id`) must exist and
have the `events` table applied before the first webhook delivery arrives —
`wrangler deploy` does not run migrations for you.

```bash
npm install
npm run migrate:remote   # applies worker/migrations/*.sql to the remote D1 database
npm run deploy
```

Use `npm run migrate:local` against `wrangler dev`'s local D1 emulation.

## Adding a migration

```bash
npx wrangler d1 migrations create websets-webhook-buffer <name>
```

then apply it with `npm run migrate:remote` (or `migrate:local`) before
deploying code that depends on it.
