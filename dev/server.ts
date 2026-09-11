// Local mode with no Turso account: `pnpm dev:local` serves public/ and the API from a local SQLite file.
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createClient } from '@libsql/client';
import { createApp } from '../src/app.ts';

const db = createClient({ url: `file:${process.env.RPS_DB ?? 'local.db'}` });
await db.executeMultiple(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

const app = createApp(db);
app.use('*', serveStatic({ root: './public' }));
app.get('/g/:code', serveStatic({ path: './public/index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`http://localhost:${port}`));
