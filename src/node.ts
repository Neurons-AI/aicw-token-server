/** Running the server on Node: a SQLite file, process.env for upstream keys, a sweep timer. */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { AdapterFactory } from './adapters/index.ts';
import { validateConfig, type TokenServerConfig } from './config.ts';
import { createTokenServer } from './server.ts';
import { migrate } from './storage.ts';
import { sqliteStorage } from './storage-sqlite.ts';

export { sqliteStorage } from './storage-sqlite.ts';

export function loadConfigFile(path: string, extraAdapterKinds: string[] = []): TokenServerConfig {
  const { config, problems } = validateConfig(JSON.parse(readFileSync(path, 'utf8')), extraAdapterKinds);
  if (problems.length) throw new Error(`${path} has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return config;
}
export interface StartOptions {
  config: TokenServerConfig;
  /** SQLite file (default ./token-server.db). */
  database?: string;
  port?: number;
  hostname?: string;
  env?: Record<string, string | undefined>;
  adapters?: Record<string, AdapterFactory>;
  /** Extra trusted Store keys (base64 raw Ed25519), on top of the config's. For local checks. */
  extraStoreKeys?: string[];
  quiet?: boolean;
}
export async function startNodeServer(opts: StartOptions) {
  const storage = sqliteStorage(opts.database ?? 'token-server.db');
  await migrate(storage);
  const config = { ...opts.config, trustedStoreKeys: [...opts.config.trustedStoreKeys, ...(opts.extraStoreKeys ?? [])] };
  const log = opts.quiet ? undefined : (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  const server = createTokenServer({ config, storage, env: opts.env ?? process.env, adapters: opts.adapters, log });
  const http = serve({ fetch: server.fetch, port: opts.port ?? 8787, hostname: opts.hostname ?? '0.0.0.0' });
  await new Promise<void>((resolve) => http.once('listening', () => resolve()));
  const timer = setInterval(() => void server.sweep().catch(() => {}), 60_000);
  timer.unref();
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 8787);
  return {
    port,
    server,
    storage,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>((resolve) => http.close(() => resolve()));
      storage.close();
    },
  };
}
