import { createClient } from '@libsql/client/web';
import { createApp } from './app.ts';

let cached: { key: string; app: ReturnType<typeof createApp> } | undefined;

function appFor(env: Env) {
  const key = `${env.TURSO_DATABASE_URL}\n${env.TURSO_AUTH_TOKEN ?? ''}`;
  if (cached?.key !== key) {
    const app = createApp(createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN || undefined }));
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
