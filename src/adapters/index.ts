import type { TokenServerConfig } from '../config.ts';
import { byteplusAdapter } from './byteplus.ts';
import { elevenlabsAdapter } from './elevenlabs.ts';
import { mockAdapter } from './mock.ts';
import { openaiAdapter } from './openai.ts';
import type { Adapter, AdapterDeps } from './types.ts';

export type AdapterFactory = (deps: AdapterDeps) => Adapter;
export const BUILTIN_ADAPTERS: Record<string, AdapterFactory> = { openai: openaiAdapter, byteplus: byteplusAdapter, elevenlabs: elevenlabsAdapter, mock: () => mockAdapter() };

export function buildAdapters(config: TokenServerConfig, env: Record<string, string | undefined>, fetchImpl: typeof fetch, extra: Record<string, AdapterFactory> = {}): Record<string, Adapter> {
  const out: Record<string, Adapter> = {};
  // Adapters call `deps.fetch(…)`: on Cloudflare Workers the global fetch called with any other
  // `this` throws "Illegal invocation" (Node does not care), so hand them a free function.
  const free: typeof fetch = (input, init) => fetchImpl(input, init);
  for (const [name, cfg] of Object.entries(config.adapters)) {
    const factory = extra[cfg.kind] ?? BUILTIN_ADAPTERS[cfg.kind];
    if (!factory) throw new Error(`adapter "${name}": unknown kind "${cfg.kind}"`);
    out[name] = factory({ config: cfg, env, fetch: free });
  }
  return out;
}
export * from './types.ts';
