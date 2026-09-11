import { createClient } from '@libsql/client/web';
import { createApp, gameSummary } from './app.ts';

const TAGLINE = 'Rock paper scissors for people who are never online at the same time.';

function setContent(value: string) {
  return { element: (el: Element) => { el.setAttribute('content', value); } };
}

function withPreview(page: Response, url: URL, game: { player_count: number; best_of: number } | null) {
  const title = 'You have been invited to play async rock paper scissors';
  const description = (game ? `Best of ${game.best_of} with ${game.player_count} players. ` : '') + TAGLINE;
  const headers = new Headers(page.headers);
  headers.delete('etag');
  headers.set('cache-control', 'no-store');
  return new HTMLRewriter()
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(`${url.origin}${url.pathname}`))
    .on('meta[property="og:image"]', setContent(`${url.origin}/og.png`))
    .transform(new Response(page.body, { status: page.status, headers }));
}

let cached: { key: string; app: ReturnType<typeof createApp> } | undefined;

function appFor(env: Env) {
  const key = `${env.TURSO_DATABASE_URL}\n${env.TURSO_AUTH_TOKEN ?? ''}`;
  if (cached?.key !== key) {
    const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN || undefined });
    const app = createApp(db);
    app.get('/g/:code', async (c) => {
      const url = new URL(c.req.url);
      const [page, game] = await Promise.all([
        env.ASSETS.fetch(new Request(new URL('/', url))),
        gameSummary(db, c.req.param('code').toUpperCase()).catch(() => null),
      ]);
      return withPreview(page, url, game);
    });
    app.all('*', (c) => env.ASSETS.fetch(c.req.raw));
    cached = { key, app };
  }
  return cached.app;
}

export default {
  fetch(request, env, ctx) {
    return appFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
