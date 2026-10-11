/**
 * Run the token server on Cloudflare Workers + D1 (what `aicw-token-server deploy cloudflare` deploys).
 *
 *   import { createWorker } from 'aicw-token-server/worker';
 *   import config from './token-server.json';
 *   export default createWorker(config);
 *
 * Bindings: `DB` (a D1 database). Upstream keys are Worker secrets named like each adapter's
 * `apiKeyEnv`. The tables are created on the first request (the schema upgrades itself), so a
 * fresh database needs no migration step. A cron trigger runs the housekeeping sweep.
 */
import { validateConfig } from './config.ts';
import { createTokenServer } from './server.ts';
import { d1Storage, type D1Like } from './storage-d1.ts';
import { migrate } from './storage.ts';

export interface WorkerEnv {
  DB: D1Like;
  /** Comma-separated extra trusted Store keys: only for a conformance check, never in production. */
  AICW_EXTRA_STORE_KEYS?: string;
  [secret: string]: unknown;
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export function createWorker(raw: unknown) {
  const { config, problems } = validateConfig(raw);
  if (problems.length) throw new Error(`token-server.json has problems:\n  - ${problems.join('\n  - ')}`);
  let cached: { env: WorkerEnv; server: ReturnType<typeof createTokenServer>; ready: Promise<void> } | null = null;
  const serverFor = (env: WorkerEnv) => {
    if (cached?.env !== env) {
      const storage = d1Storage(env.DB);
      const extra = String(env.AICW_EXTRA_STORE_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      cached = {
        env,
        server: createTokenServer({
          config: { ...config, trustedStoreKeys: [...config.trustedStoreKeys, ...extra] },
          storage,
          env: env as unknown as Record<string, string | undefined>,
          log: (event, data) => console.log(JSON.stringify({ event, ...data })),
        }),
        ready: migrate(storage),
      };
    }
    return cached;
  };
  return {
    async fetch(request: Request, env: WorkerEnv, ctx: Ctx): Promise<Response> {
      const s = serverFor(env);
      await s.ready;
      return s.server.app.fetch(request, env, ctx as never);
    },
    async scheduled(_event: unknown, env: WorkerEnv, ctx: Ctx): Promise<void> {
      const s = serverFor(env);
      ctx.waitUntil(s.ready.then(() => s.server.sweep()));
    },
  };
}
