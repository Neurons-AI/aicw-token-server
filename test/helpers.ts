import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTokenServer, generateSigner, migrate, storeClient, type TokenServerConfig } from '../src/index.ts';
import { sqliteStorage } from '../src/storage-sqlite.ts';

export const BASE = 'http://tokens.test';
export function sampleConfig(over: Partial<TokenServerConfig> = {}): TokenServerConfig {
  return {
    name: 'Test Tokens',
    providerId: 'test-tokens',
    keyPrefix: 'sk-test',
    publicUrl: BASE,
    trustedStoreKeys: [],
    buckets: { llm_tokens: { label: 'LLM tokens', topup: 'aicoworker://store/skills/topup-llm' }, image_tokens: { label: 'image tokens' }, video_tokens: { label: 'video tokens' }, voice_tokens: { label: 'voice tokens' } },
    adapters: { mock: { kind: 'mock' } },
    models: [
      { id: 'chat-1', type: 'chat', bucket: 'llm_tokens', adapter: 'mock' },
      { id: 'image-1', type: 'image', bucket: 'image_tokens', adapter: 'mock' },
      { id: 'video-1', type: 'video', bucket: 'video_tokens', adapter: 'mock' },
      { id: 'voice-1', type: 'tts', bucket: 'voice_tokens', adapter: 'mock' },
      { id: 'hear-1', type: 'stt', bucket: 'voice_tokens', adapter: 'mock' },
      { id: 'embed-1', type: 'embedding', bucket: 'llm_tokens', adapter: 'mock' },
      { id: 'music-1', type: 'other', bucket: 'voice_tokens', adapter: 'mock', price: { perRequest: 5 } },
    ],
    ...over,
  };
}
export async function harness(over: Partial<TokenServerConfig> = {}, env: Record<string, string> = {}) {
  const signer = await generateSigner();
  const storage = sqliteStorage(':memory:');
  await migrate(storage);
  const config = sampleConfig(over);
  const server = createTokenServer({ config: { ...config, trustedStoreKeys: [signer.publicKey] }, storage, env });
  const f = ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(server.app.request(String(input).replace(BASE, ''), init))) as typeof fetch;
  const store = storeClient(BASE, signer, f);
  const api = (key: string, path: string, body?: unknown, init: RequestInit = {}) =>
    f(BASE + '/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  let n = 0;
  /** A funded, non-test account with one device key. */
  const account = async (grants: Record<string, number> = { llm_tokens: 100_000, image_tokens: 100, video_tokens: 100, voice_tokens: 100 }, test = false) => {
    const accountRef = `acct-${++n}-${Date.now()}`;
    const receiptId = `rcpt-${n}-${Date.now()}`;
    if (Object.keys(grants).length) await store.fulfill({ receiptId, accountRef, sku: 'pack', quantity: 1, grants: Object.entries(grants).map(([bucket, amount]) => ({ bucket, amount })), orderRef: 'ORD-1', paidAt: new Date().toISOString(), ...(test ? { test: true } : {}) });
    const { key } = await store.issueKey(accountRef, `device-${n}-000`, test);
    const wallet = async () => (await (await api(key, '/me/balance')).json()) as { balances: Record<string, number>; held: Record<string, number> };
    return { accountRef, receiptId, key, wallet };
  };
  return { signer, storage, server, config, f, store, api, account };
}

/** A local HTTP server standing in for an upstream provider. */
export async function upstream(handler: (req: IncomingMessage, body: Buffer) => { status?: number; headers?: Record<string, string>; body: string | Buffer | string[] } | Promise<{ status?: number; headers?: Record<string, string>; body: string | Buffer | string[] }>) {
  const calls: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    calls.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
    const out = await handler(req, body);
    res.writeHead(out.status ?? 200, out.headers ?? { 'content-type': 'application/json' });
    if (Array.isArray(out.body)) {
      for (const part of out.body) {
        res.write(part);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.end();
    } else res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
