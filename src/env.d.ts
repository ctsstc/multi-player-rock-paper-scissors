// Secrets set with `wrangler secret put` are not in the generated Env type.
interface Env {
  TURSO_AUTH_TOKEN?: string;
}
