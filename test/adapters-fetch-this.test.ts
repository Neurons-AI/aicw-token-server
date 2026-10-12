/** Cloudflare Workers: the global fetch throws "Illegal invocation" when called with another `this`. */
import { describe, expect, it } from 'vitest';
import { buildAdapters } from '../src/adapters/index.ts';
import type { TokenServerConfig } from '../src/config.ts';

// Behaves like the Workers fetch: only a plain call (this = undefined or globalThis) is allowed.
function strictFetch(calls: string[]): typeof fetch {
  return function (this: unknown, input: RequestInfo | URL) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    calls.push(String(input));
    const url = String(input);
    if (url.endsWith('/contents/generations/tasks')) return Promise.resolve(Response.json({ id: 'cgt-1' }));
    if (url.endsWith('/text-to-speech/Voice12345?output_format=mp3_44100_128')) return Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }));
    return Promise.resolve(Response.json({ ok: true }));
  } as typeof fetch;
}

describe('adapters on Cloudflare Workers', () => {
  it('call fetch as a free function (byteplus, openai, elevenlabs)', async () => {
    const calls: string[] = [];
    const config = {
      adapters: {
        ark: { kind: 'byteplus', baseUrl: 'https://ark.test/api/v3', apiKeyEnv: 'BP' },
        oai: { kind: 'openai', baseUrl: 'https://oai.test/v1', apiKeyEnv: 'OA' },
        el: { kind: 'elevenlabs', baseUrl: 'https://el.test', apiKeyEnv: 'EL', voice: 'Voice12345' },
      },
    } as unknown as TokenServerConfig;
    const a = buildAdapters(config, { BP: 'k', OA: 'k', EL: 'k' }, strictFetch(calls));
    expect(await a.ark.video!.create({ model: 'seedance', prompt: 'a cat', images: [], resolution: '720p', seconds: 5 })).toEqual({ id: 'cgt-1' });
    expect((await a.oai.forward('/chat/completions', { method: 'POST', body: '{}', headers: {} } as never)).status).toBe(200);
    expect((await a.el.forward('/audio/speech', { method: 'POST', body: JSON.stringify({ model: 'm', input: 'hi' }) } as never)).status).toBe(200);
    expect(calls).toHaveLength(3);
  });
});
