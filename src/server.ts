/**
 * The token server: one Hono app.
 *
 *   /v1/*      OpenAI-compatible API for an AI Coworker app holding a device key.
 *   /aicw/*    Ed25519-signed calls from the AICW Store (grant, refund, key, balance).
 *
 * It runs unchanged on Cloudflare Workers (D1) and on Node (SQLite file): everything it
 * needs from the outside comes in through `TokenServerDeps`.
 */
import { Hono, type Context } from 'hono';
import { buildAdapters, UpstreamError, upstreamModel, type Adapter, type AdapterFactory } from './adapters/index.ts';
import { mockAdapter } from './adapters/mock.ts';
import { DEFAULT_LIMITS, type ModelConfig, type TokenServerConfig } from './config.ts';
import { keyId, randomId, unb64, verifySignature } from './crypto.ts';
import { issueKey, listKeys, revokeKeys, verifyKey, type KeyRecord } from './keys.ts';
import { checkEstimate, checkPrice, fullPrice, liveCatalog, overrideLog, readOverrides, writeOverride, type LiveCatalog } from './prices.ts';
import { chargeForChat, estimateTokens, holdForChat, readChatUsage, tokensForImages, tokensForSpeech, tokensForVideo, tokensPerRequest, videoSeconds } from './pricing.ts';
import {
  balanceHeader,
  quotaHeader,
  KEY_ID_HEADER,
  MAX_CLOCK_SKEW_MS,
  PROTOCOL_VERSION,
  SIGNATURE_HEADER,
  WELL_KNOWN_PATH,
  type AdjustRequest,
  type ApiError,
  type BalanceRequest,
  type PricesResponse,
  type PublicBucket,
  type SetEstimateRequest,
  type SetPriceRequest,
  type FulfillRequest,
  type KeyRequest,
  type KeyRevokeRequest,
  type ModelType,
  type ProviderDescriptor,
  type PublicModel,
  type RefundRequest,
  type ServerManifest,
  type VideoJob,
} from './protocol.ts';
import type { Storage } from './storage.ts';
import { adjust, balances, ensureAccount, grantReceipt, hold, isTestAccount, refundReceipt, release, settle, usageSummary, WalletError } from './wallet.ts';

export const LIBRARY = { name: 'aicw-token-server', version: '0.8.0' };

export interface TokenServerDeps {
  config: TokenServerConfig;
  storage: Storage;
  /** Where upstream keys are read from (process.env, or a Worker's env). */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Adapter kinds of your own, next to the built-in `openai`, `byteplus`, `mock`. */
  adapters?: Record<string, AdapterFactory>;
  log?: (event: string, data: Record<string, unknown>) => void;
}
type Vars = { key: KeyRecord; test: boolean };
type C = Context<{ Variables: Vars }>;

class HttpError extends Error {
  status: number;
  body: ApiError;
  constructor(status: number, code: string, message: string, extra: Partial<ApiError['error']> = {}) {
    super(message);
    this.status = status;
    this.body = { error: { message, type: status >= 500 ? 'server_error' : status === 402 ? 'insufficient_tokens' : 'invalid_request_error', code, ...extra } };
  }
}
const bad = (message: string, code = 'invalid_request') => new HttpError(400, code, message);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const nowIso = () => new Date().toISOString();

export function createTokenServer(deps: TokenServerDeps) {
  const { config, storage: db } = deps;
  const env = deps.env ?? {};
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) };
  const adapters = buildAdapters(config, env, fetchImpl, deps.adapters);
  /** Test accounts (the conformance check) are always answered by this, never by a real upstream. */
  const sandbox = mockAdapter();
  const baseUrl = `${config.publicUrl.replace(/\/+$/, '')}/v1`;
  /** The live catalog: prices the Store replaced (when allowed) over the configured ones, and each bucket's estimate. */
  interface Live {
    catalog: LiveCatalog;
    models: PublicModel[];
    buckets: PublicBucket[];
    provider: ProviderDescriptor;
    manifest: ServerManifest;
  }
  const describe = (catalog: LiveCatalog): Live => {
    const models: PublicModel[] = catalog.models.map((m) => ({ id: m.id, type: m.type, bucket: m.bucket, ...(m.unit ? { unit: m.unit } : {}), ...(m.name ? { name: m.name } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}), ...(m.input ? { input: m.input } : {}), ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}) }));
    const buckets: PublicBucket[] = Object.entries(config.buckets).map(([id, b]) => ({ id, label: b.label, ...(catalog.estimates[id] ? { estimate: catalog.estimates[id] } : {}) }));
    return {
      catalog,
      models,
      buckets,
      provider: { id: config.providerId, name: config.name, baseUrl, models },
      manifest: { protocol: PROTOCOL_VERSION, name: config.name, providerId: config.providerId, baseUrl, buckets, models, library: LIBRARY },
    };
  };
  const configured = describe(liveCatalog(config, { prices: new Map(), estimates: new Map() }));
  /** Read again at most every 15 s per process (other instances pick a change up within that). */
  let live: { at: number; value: Promise<Live> } | null = null;
  const current = (): Promise<Live> => {
    if (!config.allowStorePricing) return Promise.resolve(configured);
    if (!live || Date.now() - live.at > 15_000) {
      const value = readOverrides(db).then((o) => describe(liveCatalog(config, o)), () => configured);
      live = { at: Date.now(), value };
    }
    return live.value;
  };
  const provider = configured.provider;
  const manifest = configured.manifest;
  const trusted = new Map<string, string>();
  const trustedReady = (async () => {
    for (const k of config.trustedStoreKeys) trusted.set(await keyId(unb64(k)), k);
  })();

  const modelOf = async (id: unknown, types: ModelType[]): Promise<ModelConfig> => {
    const name = str(id, 200);
    const m = (await current()).catalog.models.find((x) => x.id === name);
    if (!m) throw new HttpError(404, 'model_not_found', name ? `this server has no model "${name}"` : 'the request names no model');
    if (!types.includes(m.type)) throw bad(`"${m.id}" is a ${m.type} model; this endpoint takes ${types.join(' or ')} models`, 'wrong_model_type');
    return m;
  };
  const adapterFor = (c: C, m: ModelConfig): Adapter => (c.get('test') ? sandbox : adapters[m.adapter]);
  const insufficient = (e: WalletError) =>
    new HttpError(402, 'insufficient_tokens', `your ${config.buckets[e.bucket]?.label || e.bucket} quota is used up for this request; top up in the AICW Store`, {
      bucket: e.bucket,
      balance: e.balance,
      needed: e.needed,
      ...(config.buckets[e.bucket]?.topup ? { topup: config.buckets[e.bucket].topup } : {}),
    });
  const reserve = async (c: C, m: ModelConfig, amount: number, mode: 'exact' | 'upTo', kind: string) => {
    try {
      return await hold(db, { accountRef: c.get('key').account_ref, keyId: c.get('key').id, bucket: m.bucket, amount, mode, kind, model: m.id });
    } catch (e) {
      if (e instanceof WalletError) throw insufficient(e);
      throw e;
    }
  };
  /** An upstream failure, as the caller should see it. A refusal (400) passes through; the rest is "upstream unavailable". */
  const upstreamFailure = async (res: Response): Promise<HttpError> => {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    const message = str(data?.error?.message, 600) || `the model provider answered ${res.status}`;
    if (res.status === 400 || res.status === 422) return new HttpError(400, str(data?.error?.code, 80) || 'upstream_rejected', message);
    log('upstream_failed', { status: res.status, message });
    return new HttpError(res.status === 429 ? 503 : 502, 'upstream_unavailable', res.status === 429 ? 'the model provider is rate limiting this server; try again shortly' : 'the model provider is unavailable; nothing was charged');
  };
  const failure = (e: unknown): HttpError => {
    if (e instanceof HttpError) return e;
    if (e instanceof UpstreamError) return new HttpError(e.status === 400 ? 400 : e.status === 404 ? 404 : e.status === 503 ? 503 : 502, e.code, e.message);
    const anyE = e as { status?: number; code?: string; message?: string };
    if (anyE?.status === 400) return new HttpError(400, anyE.code || 'upstream_rejected', anyE.message || 'the request was refused');
    log('request_failed', { message: e instanceof Error ? e.message : String(e) });
    return new HttpError(502, 'upstream_unavailable', 'the model provider is unavailable; nothing was charged');
  };
  /** The quota of a wallet (never below what it holds, reservations included). */
  const quotaOf = async (accountRef: string, bucket: string) => {
    const w = await db.first<{ balance: number; held: number; quota: number }>('SELECT balance,held,quota FROM ts_wallets WHERE account_ref=? AND bucket=?', accountRef, bucket);
    return w ? Math.max(w.quota ?? 0, w.balance + w.held) : 0;
  };
  const withBalance = async (c: C, res: Response, bucket: string, balance: number | null): Promise<Response> => {
    if (balance === null) return res;
    const headers = new Headers(res.headers);
    headers.set(balanceHeader(bucket), String(balance));
    headers.set(quotaHeader(bucket), String(await quotaOf(c.get('key').account_ref, bucket)));
    return new Response(res.body, { status: res.status, headers });
  };
  const jsonBody = async (c: C): Promise<Record<string, any>> => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('the request body must be a JSON object');
    return body as Record<string, any>;
  };

  const app = new Hono<{ Variables: Vars }>();
  app.onError((e, c) => {
    const err = e instanceof HttpError ? e : failure(e);
    return c.json(err.body, err.status as 400);
  });
  app.notFound((c) => c.json({ error: { message: 'no such route', type: 'invalid_request_error', code: 'not_found' } }, 404));
  app.use('*', async (c, next) => {
    const length = Number(c.req.header('content-length') || 0);
    if (length > limits.maxBodyBytes) throw new HttpError(413, 'request_too_large', `the request is larger than ${limits.maxBodyBytes} bytes`);
    await next();
    c.header('x-content-type-options', 'nosniff');
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
  });

  app.get('/healthz', (c) => c.json({ ok: true, name: config.name, protocol: PROTOCOL_VERSION }));
  app.get(WELL_KNOWN_PATH, async (c) => c.json((await current()).manifest));

  // ───────────────────────────── /v1: device key ─────────────────────────────
  app.use('/v1/*', async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || c.req.header('x-api-key') || '';
    const key = await verifyKey(db, token.trim());
    if (!key) throw new HttpError(401, 'invalid_api_key', 'this key is unknown or was revoked; reinstall the package from the AICW Store to get a new one');
    const bucket = `key:${key.id}:${Math.floor(Date.now() / 60_000)}`;
    const hit = await db.first<{ hits: number }>(
      'INSERT INTO ts_rate(key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits',
      bucket,
      new Date(Date.now() + 120_000).toISOString()
    );
    if ((hit?.hits ?? 0) > limits.requestsPerMinute) throw new HttpError(429, 'rate_limited', `more than ${limits.requestsPerMinute} requests in a minute; slow down`);
    c.set('key', key);
    c.set('test', await isTestAccount(db, key.account_ref));
    await next();
  });

  app.get('/v1/models', async (c) => {
    const data = (await current()).models.map((m) => ({ id: m.id, object: 'model', owned_by: config.providerId, type: m.type, bucket: m.bucket }));
    return c.json({ object: 'list', data, models: data });
  });
  app.get('/v1/me/balance', async (c) => {
    const b = await balances(db, c.get('key').account_ref);
    for (const id of Object.keys(config.buckets)) {
      b.balances[id] ??= 0;
      b.held[id] ??= 0;
      b.quota[id] ??= 0;
    }
    return c.json({ balances: b.balances, held: b.held, quota: b.quota, buckets: (await current()).buckets, updatedAt: b.updatedAt || nowIso() });
  });

  /** Chat Completions and Responses: forward, meter the usage the upstream reports, settle. */
  const chat = (path: '/chat/completions' | '/responses') => async (c: C) => {
    const body = await jsonBody(c);
    const m = await modelOf(body.model, ['chat']);
    const promptChars = JSON.stringify(body.messages ?? body.input ?? '').length + JSON.stringify(body.tools ?? '').length + str(body.instructions, 1_000_000).length;
    const h = await reserve(c, m, holdForChat(m, body, promptChars), 'upTo', path === '/responses' ? 'responses' : 'chat');
    const stream = body.stream === true;
    const send: Record<string, any> = { ...body, ...(m.upstreamBody ?? {}), model: upstreamModel(m) };
    if (stream && path === '/chat/completions') send.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    if (m.promptCache === 'anthropic' && Array.isArray(send.messages)) send.messages = markAnthropicCache(send.messages);
    // Never let one call spend more than was reserved for it.
    const cap = Math.max(1, Math.floor((h.amount - estimateTokens(promptChars) * (m.price?.input ?? 1)) / (m.price?.output ?? 1)));
    const maxField = path === '/responses' ? 'max_output_tokens' : body.max_tokens !== undefined && body.max_completion_tokens === undefined ? 'max_tokens' : 'max_completion_tokens';
    const asked = Number(send[maxField]) || 0;
    if (!asked || asked > cap) send[maxField] = Math.max(16, cap);
    let res: Response;
    try {
      res = await adapterFor(c, m).forward(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(send), signal: c.req.raw.signal });
    } catch (e) {
      await release(db, h.requestId, e instanceof Error ? e.message : String(e));
      throw failure(e);
    }
    if (!res.ok) {
      const err = await upstreamFailure(res);
      await release(db, h.requestId, err.message);
      throw err;
    }
    if (!stream) {
      const data = (await res.json().catch(() => null)) as Record<string, any> | null;
      const usage = readChatUsage(data?.usage);
      if (!data) {
        await release(db, h.requestId, 'unreadable upstream answer');
        throw new HttpError(502, 'upstream_unavailable', 'the model provider sent an unreadable answer; nothing was charged');
      }
      // No usage reported: charge the estimate rather than nothing, or everything.
      const charged = usage ? chargeForChat(m, usage) : estimateTokens(promptChars + JSON.stringify(data.choices ?? data.output ?? '').length);
      const balance = await settle(db, h.requestId, charged, data.usage ?? { estimated: true });
      if (data.model) data.model = m.id;
      return await withBalance(c, Response.json(scrubUpstreamCost(data)), m.bucket, balance);
    }
    // On Workers the isolate may stop once the buyer has the last byte and hangs up: keep it alive
    // until the call is settled, or the hold would be swept back uncharged.
    let settled!: () => void;
    keepAlive(c, new Promise<void>((resolve) => (settled = resolve)));
    return new Response(meterSse(res.body!, async (seen) => {
      try {
        const usage = readChatUsage(seen.usage);
        await settle(db, h.requestId, usage ? chargeForChat(m, usage) : estimateTokens(promptChars + seen.outputChars), seen.usage ?? { estimated: true, aborted: seen.aborted });
      } finally {
        settled();
      }
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', [balanceHeader(m.bucket)]: String(h.balanceAfter), [quotaHeader(m.bucket)]: String(await quotaOf(c.get('key').account_ref, m.bucket)) } });
  };
  app.post('/v1/chat/completions', chat('/chat/completions'));
  app.post('/v1/responses', chat('/responses'));

  app.post('/v1/embeddings', async (c) => {
    const body = await jsonBody(c);
    const m = await modelOf(body.model, ['embedding']);
    const chars = JSON.stringify(body.input ?? '').length;
    const h = await reserve(c, m, Math.ceil(estimateTokens(chars) * 2 * (m.price?.input ?? 1)), 'upTo', 'embedding');
    return guarded(h.requestId, async () => {
      const res = await adapterFor(c, m).forward('/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: upstreamModel(m) }) });
      if (!res.ok) throw await upstreamFailure(res);
      const data = (await res.json()) as Record<string, any>;
      const total = Number(data?.usage?.total_tokens) || estimateTokens(chars);
      const balance = await settle(db, h.requestId, Math.ceil(total * (m.price?.input ?? 1)), data.usage);
      return await withBalance(c, Response.json({ ...data, model: m.id }), m.bucket, balance);
    });
  });

  /** Run a call that either settles itself or, on any failure, gives the hold back. */
  async function guarded(requestId: string, run: () => Promise<Response>): Promise<Response> {
    try {
      return await run();
    } catch (e) {
      const err = failure(e);
      await release(db, requestId, err.message);
      throw err;
    }
  }

  app.post('/v1/images/generations', async (c) => {
    const body = await jsonBody(c);
    const m = await modelOf(body.model, ['image']);
    if (!str(body.prompt, 32_000).trim()) throw bad('an image needs a prompt');
    const n = Math.max(1, Math.min(4, Math.trunc(Number(body.n)) || 1));
    const h = await reserve(c, m, tokensForImages(m, str(body.quality, 20), n, false), 'exact', 'image');
    return guarded(h.requestId, async () => {
      const res = await adapterFor(c, m).forward('/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(m.upstreamBody ?? {}), n, model: upstreamModel(m) }) });
      if (!res.ok) throw await upstreamFailure(res);
      const data = (await res.json()) as Record<string, any>;
      const made = Array.isArray(data?.data) ? data.data.length : 0;
      if (!made) throw new HttpError(502, 'no_image', 'the model returned no image (the prompt may have been refused); nothing was charged');
      const balance = await settle(db, h.requestId, Math.max(tokensForImages(m, str(body.quality, 20), made, false), costFloor(m, data.usage)), { images: made, quality: body.quality ?? 'auto', ...(data.usage?.cost ? { cost: data.usage.cost } : {}) });
      return await withBalance(c, Response.json(scrubUpstreamCost(data)), m.bucket, balance);
    });
  });
  app.post('/v1/images/edits', async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) throw bad('send the edit as multipart/form-data');
    const m = await modelOf(form.get('model'), ['image']);
    if (!str(form.get('prompt'), 32_000).trim()) throw bad('an image edit needs a prompt');
    const n = Math.max(1, Math.min(4, Math.trunc(Number(form.get('n'))) || 1));
    const quality = str(form.get('quality'), 20);
    const h = await reserve(c, m, tokensForImages(m, quality, n, true), 'exact', 'image');
    return guarded(h.requestId, async () => {
      form.set('model', upstreamModel(m));
      form.set('n', String(n));
      const res = await adapterFor(c, m).forward('/images/edits', { method: 'POST', body: form });
      if (!res.ok) throw await upstreamFailure(res);
      const data = (await res.json()) as Record<string, any>;
      const made = Array.isArray(data?.data) ? data.data.length : 0;
      if (!made) throw new HttpError(502, 'no_image', 'the model returned no image (the prompt may have been refused); nothing was charged');
      const balance = await settle(db, h.requestId, Math.max(tokensForImages(m, quality, made, true), costFloor(m, data.usage)), { images: made, quality: quality || 'auto', edit: true, ...(data.usage?.cost ? { cost: data.usage.cost } : {}) });
      return await withBalance(c, Response.json(scrubUpstreamCost(data)), m.bucket, balance);
    });
  });

  app.post('/v1/audio/speech', async (c) => {
    const body = await jsonBody(c);
    const m = await modelOf(body.model, ['tts']);
    const text = str(body.input, 100_000);
    if (!text.trim()) throw bad('speech needs an input text');
    const cost = tokensForSpeech(m, text.length);
    const h = await reserve(c, m, cost, 'exact', 'tts');
    return guarded(h.requestId, async () => {
      const res = await adapterFor(c, m).forward('/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: upstreamModel(m) }) });
      if (!res.ok) throw await upstreamFailure(res);
      const audio = await res.arrayBuffer();
      const balance = await settle(db, h.requestId, cost, { chars: text.length });
      return await withBalance(c, new Response(audio, { headers: { 'content-type': res.headers.get('content-type') || 'audio/mpeg' } }), m.bucket, balance);
    });
  });
  app.post('/v1/audio/transcriptions', async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) throw bad('send the audio as multipart/form-data');
    const m = await modelOf(form.get('model'), ['stt']);
    const cost = tokensPerRequest(m);
    const h = await reserve(c, m, cost, 'exact', 'stt');
    return guarded(h.requestId, async () => {
      form.set('model', upstreamModel(m));
      const res = await adapterFor(c, m).forward('/audio/transcriptions', { method: 'POST', body: form });
      if (!res.ok) throw await upstreamFailure(res);
      const text = await res.text();
      const balance = await settle(db, h.requestId, cost, {});
      return await withBalance(c, new Response(text, { headers: { 'content-type': res.headers.get('content-type') || 'application/json' } }), m.bucket, balance);
    });
  });

  /** Any other model type (music, 3D, …): one JSON call, charged per request. */
  app.post('/v1/generate', async (c) => {
    const body = await jsonBody(c);
    const m = await modelOf(body.model, ['other']);
    const cost = tokensPerRequest(m);
    const h = await reserve(c, m, cost, 'exact', 'other');
    return guarded(h.requestId, async () => {
      const res = await adapterFor(c, m).forward('/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: upstreamModel(m) }) });
      if (!res.ok) throw await upstreamFailure(res);
      const payload = await res.arrayBuffer();
      const balance = await settle(db, h.requestId, cost, {});
      return await withBalance(c, new Response(payload, { headers: { 'content-type': res.headers.get('content-type') || 'application/json' } }), m.bucket, balance);
    });
  });

  // ───────────────────────────── video: a job, not a call ─────────────────────────────
  interface VideoRow {
    id: string;
    account_ref: string;
    model: string;
    bucket: string;
    status: string;
    hold: number;
    upstream_id: string | null;
    upstream_ref: string | null;
    usage_json?: string | null;
    error: string | null;
    created_at: string;
  }
  const videoRow = (id: string) => db.first<VideoRow>("SELECT id,account_ref,model,bucket,status,hold,upstream_id,upstream_ref,error,created_at,usage_json FROM ts_requests WHERE id=? AND kind='video'", id);
  /** Ask the upstream where a job is, and settle or release the hold when it has ended. */
  async function advanceVideo(row: VideoRow, test: boolean): Promise<VideoJob> {
    const job = (status: VideoJob['status'], extra: Partial<VideoJob> = {}): VideoJob => ({ id: row.id, object: 'video', model: row.model, status, ...extra });
    const done = () => job('completed', { progress: 100, url: `${baseUrl}/videos/${row.id}/content` });
    if (row.status === 'done') return done();
    if (row.status === 'released') return job('failed', { error: { message: row.error || 'the video could not be made; nothing was charged', code: 'video_failed' } });
    const m = config.models.find((x) => x.id === row.model);
    const video = (test ? sandbox : m ? adapters[m.adapter] : undefined)?.video;
    if (!video || !row.upstream_id) return job('queued');
    let state;
    try {
      state = await video.status(row.upstream_id);
    } catch (e) {
      log('video_status_failed', { id: row.id, message: e instanceof Error ? e.message : String(e) });
      return job('in_progress');
    }
    if (state.status === 'completed') {
      await db.run('UPDATE ts_requests SET upstream_ref=? WHERE id=?', state.ref ?? null, row.id);
      // Never below what the upstream says the job used (an edit or extension also bills its source video).
      const withVideo = /"withVideo":true/.test(String(row.usage_json ?? ''));
      const perVideo = m?.price?.perMillionUpstreamTokensWithVideo;
      const per = m?.price?.perMillionUpstreamTokens;
      const byTokens = (rate: number | undefined) => (rate && state.usageTokens ? Math.ceil((state.usageTokens / 1_000_000) * rate) : 0);
      // A job with a source video is charged by the tokens reported (its length is known only now);
      // any other job by seconds, and never below the tokens reported.
      const charge = withVideo && perVideo && state.usageTokens ? byTokens(perVideo) : Math.max(row.hold, byTokens(per));
      await settle(db, row.id, charge, { video: true, ...(withVideo ? { withVideo: true } : {}), ...(state.usageTokens ? { upstreamTokens: state.usageTokens } : {}) });
      return done();
    }
    if (state.status === 'failed') {
      await release(db, row.id, state.error || 'the video could not be made');
      return job('failed', { error: { message: `${state.error || 'the video could not be made'}; nothing was charged`, code: 'video_failed' } });
    }
    return job(state.status, { progress: state.progress });
  }

  app.post('/v1/videos', async (c) => {
    const body = await jsonBody(c);
    const m = await modelOf(body.model, ['video']);
    const prompt = str(body.prompt, 8000).trim();
    if (!prompt) throw bad('a video needs a prompt');
    const resolution = str(body.resolution, 10) || '720p';
    if (m.price?.resolution && !(resolution in m.price.resolution)) throw bad(`resolution must be one of ${Object.keys(m.price.resolution).join(', ')}`);
    const seconds = videoSeconds(m, body.duration ?? body.seconds);
    const images = (Array.isArray(body.images) ? body.images : body.image ? [body.image] : []).filter((x: unknown): x is string => typeof x === 'string' && /^(https?:|data:image\/)/.test(x)).slice(0, 4);
    // Videos to edit / extend / follow: an https URL, or the id of a video this account made here
    // (its file stays with the provider for about a day). Audio: https URLs.
    const videos: string[] = [];
    for (const v of (Array.isArray(body.videos) ? body.videos : body.video ? [body.video] : []).slice(0, 3)) {
      const ref = str(v, 2000).trim();
      if (/^https:\/\//.test(ref)) videos.push(ref);
      else if (ref) {
        const own = await videoRow(ref.replace(/^.*\/videos\/([^/]+)(\/content)?$/, '$1'));
        if (!own || own.account_ref !== c.get('key').account_ref || own.status !== 'done' || !own.upstream_ref) throw bad(`video "${ref.slice(0, 80)}": use an https:// address or the id of a finished video you made here (kept about a day)`);
        videos.push(own.upstream_ref);
      }
    }
    const audios = (Array.isArray(body.audios) ? body.audios : []).filter((x: unknown): x is string => typeof x === 'string' && /^https:\/\//.test(x)).slice(0, 3);
    if ((videos.length || audios.length) && adapterFor(c, m).video && config.adapters[m.adapter]?.kind !== 'byteplus' && config.adapters[m.adapter]?.kind !== 'mock') throw bad(`the model "${m.id}" cannot take reference videos or audio`);
    const open = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM ts_requests WHERE account_ref=? AND kind='video' AND status='held'", c.get('key').account_ref);
    if ((open?.n ?? 0) >= limits.maxOpenVideos) throw new HttpError(429, 'too_many_videos', `${limits.maxOpenVideos} videos are already being made; wait for one to finish`);
    const video = adapterFor(c, m).video;
    if (!video) throw new HttpError(503, 'upstream_not_configured', `the "${m.adapter}" adapter cannot make videos`);
    const task = ['auto', 'reference', 'edit', 'extend'].includes(String(body.task)) ? (body.task as 'auto' | 'reference' | 'edit' | 'extend') : undefined;
    // With a source video the length is the provider's (an edit keeps the source's, up to 30 s): hold for the longest.
    const holdSeconds = videos.length ? Math.max(seconds, 30) : seconds;
    const h = await reserve(c, m, tokensForVideo(m, resolution, holdSeconds), 'exact', 'video');
    return guarded(h.requestId, async () => {
      const made = await video.create({ model: upstreamModel(m), prompt, images, ...(videos.length ? { videos } : {}), ...(audios.length ? { audios } : {}), ...(task ? { task } : {}), resolution, seconds, ratio: str(body.ratio ?? body.aspect_ratio, 10) || undefined });
      await db.run('UPDATE ts_requests SET upstream_id=?,usage_json=? WHERE id=?', made.id, JSON.stringify({ resolution, seconds, ...(videos.length ? { withVideo: true } : {}) }), h.requestId);
      const job: VideoJob = { id: h.requestId, object: 'video', model: m.id, status: 'queued' };
      return await withBalance(c, Response.json(job), m.bucket, h.balanceAfter);
    });
  });
  app.get('/v1/videos/:id', async (c) => {
    const row = await videoRow(c.req.param('id'));
    if (!row || row.account_ref !== c.get('key').account_ref) throw new HttpError(404, 'not_found', 'no such video');
    return c.json(await advanceVideo(row, c.get('test')));
  });
  app.get('/v1/videos/:id/content', async (c) => {
    const row = await videoRow(c.req.param('id'));
    if (!row || row.account_ref !== c.get('key').account_ref) throw new HttpError(404, 'not_found', 'no such video');
    if (row.status !== 'done') throw new HttpError(409, 'not_ready', 'the video is not finished yet');
    const m = config.models.find((x) => x.id === row.model);
    const video = (c.get('test') ? sandbox : m ? adapters[m.adapter] : undefined)?.video;
    if (!video) throw new HttpError(404, 'not_found', 'the video is no longer available');
    const res = await video.content(row.upstream_id || '', row.upstream_ref || undefined).catch((e) => {
      throw failure(e);
    });
    if (!res.ok) throw new HttpError(res.status === 404 || res.status === 403 ? 404 : 502, 'not_found', 'the video file is no longer available (files are kept for about a day)');
    return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'video/mp4', ...(res.headers.get('content-length') ? { 'content-length': res.headers.get('content-length')! } : {}) } });
  });

  // ───────────────────────────── /aicw: the Store, signed ─────────────────────────────
  /** Read a signed body. The signature covers the exact bytes sent; `ts` bounds how long it is good for. */
  async function signed<T extends { ts: string }>(c: Context): Promise<T> {
    await trustedReady;
    const raw = await c.req.text();
    const key = trusted.get(c.req.header(KEY_ID_HEADER) || '');
    const signature = c.req.header(SIGNATURE_HEADER) || '';
    if (!key || !signature || !(await verifySignature(key, raw, signature))) throw new HttpError(401, 'bad_signature', 'this request is not signed by a Store this server trusts');
    let body: T;
    try {
      body = JSON.parse(raw) as T;
    } catch {
      throw bad('the signed body must be JSON');
    }
    const at = Date.parse(String(body?.ts));
    if (!Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_CLOCK_SKEW_MS) throw new HttpError(401, 'stale_request', 'the signed request is too old or carries no time');
    return body;
  }
  const ref = (v: unknown, what: string) => {
    const s = str(v, 200);
    if (!/^[A-Za-z0-9._:-]{6,200}$/.test(s)) throw bad(`${what} is missing or malformed`);
    return s;
  };

  app.post('/aicw/fulfill', async (c) => {
    const body = await signed<FulfillRequest>(c);
    const receiptId = ref(body.receiptId, 'receiptId');
    const accountRef = ref(body.accountRef, 'accountRef');
    const grants = Array.isArray(body.grants) ? body.grants : [];
    if (!grants.length) throw bad('the receipt grants nothing');
    for (const g of grants) {
      if (!config.buckets[g?.bucket]) throw bad(`this server has no bucket "${g?.bucket}"`, 'unknown_bucket');
      if (!Number.isInteger(g.amount) || g.amount <= 0 || g.amount > 1e12) throw bad(`the amount for "${g.bucket}" must be a positive whole number`);
    }
    const applied = await grantReceipt(db, { receiptId, accountRef, sku: str(body.sku, 120) || 'unknown', orderRef: str(body.orderRef, 120) || receiptId, grants: grants.map((g) => ({ bucket: g.bucket, amount: g.amount })), test: body.test === true });
    log('fulfill', { receiptId, applied });
    return c.json({ ok: true, applied, balances: (await balances(db, accountRef)).balances });
  });
  app.post('/aicw/refund', async (c) => {
    const body = await signed<RefundRequest>(c);
    const result = await refundReceipt(db, ref(body.receiptId, 'receiptId'));
    if (!result) throw new HttpError(404, 'unknown_receipt', 'this server never fulfilled that receipt');
    log('refund', { receiptId: body.receiptId, applied: result.applied });
    return c.json({ ok: true, ...result });
  });
  app.post('/aicw/keys', async (c) => {
    const body = await signed<KeyRequest>(c);
    const accountRef = ref(body.accountRef, 'accountRef');
    const deviceRef = ref(body.deviceRef, 'deviceRef');
    await ensureAccount(db, accountRef, body.test === true);
    const issued = await issueKey(db, config.keyPrefix, accountRef, deviceRef);
    return c.json({ ok: true, key: issued.key, prefix: issued.prefix, provider: (await current()).provider });
  });
  app.post('/aicw/keys/revoke', async (c) => {
    const body = await signed<KeyRevokeRequest>(c);
    return c.json({ ok: true, revoked: await revokeKeys(db, ref(body.accountRef, 'accountRef'), body.deviceRef ? ref(body.deviceRef, 'deviceRef') : undefined) });
  });
  app.post('/aicw/balance', async (c) => {
    const body = await signed<BalanceRequest>(c);
    const accountRef = ref(body.accountRef, 'accountRef');
    const b = await balances(db, accountRef);
    for (const id of Object.keys(config.buckets)) {
      b.balances[id] ??= 0;
      b.held[id] ??= 0;
      b.quota[id] ??= 0;
    }
    const keys = (await listKeys(db, accountRef)).map((k) => ({ prefix: k.prefix, deviceRef: k.device_ref, status: k.status, createdAt: k.created_at, lastUsedAt: k.last_used_at }));
    const usage = await usageSummary(db, accountRef, new Date(Date.now() - 30 * 86_400_000).toISOString());
    return c.json({ ok: true, balances: b.balances, held: b.held, quota: b.quota, buckets: (await current()).buckets, keys, usage });
  });
  app.post('/aicw/adjust', async (c) => {
    const body = await signed<AdjustRequest>(c);
    if (!config.allowStoreAdjust) throw new HttpError(403, 'adjust_disabled', 'this server does not let the Store correct balances');
    if (!config.buckets[body.bucket]) throw bad(`this server has no bucket "${body.bucket}"`, 'unknown_bucket');
    if (!Number.isInteger(body.delta) || body.delta === 0 || Math.abs(body.delta) > 1e12) throw bad('delta must be a non-zero whole number');
    const applied = await adjust(db, { accountRef: ref(body.accountRef, 'accountRef'), bucket: body.bucket, delta: body.delta, ref: ref(body.ref, 'ref'), note: str(body.note, 300) || undefined });
    return c.json({ ok: true, applied, balances: (await balances(db, body.accountRef)).balances });
  });

  // Prices and estimates: read by any trusted Store, changed only when the operator allows it.
  app.post('/aicw/prices', async (c) => {
    await signed(c);
    // Read straight from the database: the page shows what the next call will be charged.
    const o = config.allowStorePricing ? await readOverrides(db) : { prices: new Map(), estimates: new Map() };
    const catalog = liveCatalog(config, o);
    const body: PricesResponse = {
      ok: true,
      editable: !!config.allowStorePricing,
      models: catalog.models.map((m, i) => ({ id: m.id, type: m.type, bucket: m.bucket, price: fullPrice(m) as Record<string, unknown>, defaultPrice: fullPrice(config.models[i]) as Record<string, unknown>, overridden: o.prices.has(m.id), ...(m.unit ? { unit: m.unit } : {}), updatedAt: o.prices.get(m.id)?.updatedAt ?? null })),
      buckets: Object.entries(config.buckets).filter(([id]) => catalog.estimates[id]).map(([id, b]) => ({ bucket: id, label: b.label, estimate: catalog.estimates[id], profile: catalog.profiles[id] as unknown as Record<string, unknown>, overridden: o.estimates.has(id), updatedAt: o.estimates.get(id)?.updatedAt ?? null })),
      log: config.allowStorePricing ? await overrideLog(db) : [],
    };
    return c.json(body);
  });
  const pricingAllowed = () => {
    if (!config.allowStorePricing) throw new HttpError(403, 'pricing_disabled', 'this server keeps its prices in its configuration file');
  };
  app.post('/aicw/prices/set', async (c) => {
    const body = await signed<SetPriceRequest>(c);
    pricingAllowed();
    const model = config.models.find((m) => m.id === body.model);
    if (!model) throw new HttpError(404, 'model_not_found', `this server has no model "${str(body.model, 200)}"`);
    if (body.price !== null) {
      const problems = checkPrice(model, body.price);
      if (problems.length) throw bad(problems.join('; '), 'invalid_price');
    }
    await writeOverride(db, 'price', model.id, body.price, str(body.note, 300) || null);
    live = null;
    log('price_set', { model: model.id, reset: body.price === null });
    return c.json({ ok: true, manifest: (await current()).manifest });
  });
  app.post('/aicw/estimates/set', async (c) => {
    const body = await signed<SetEstimateRequest>(c);
    pricingAllowed();
    if (!config.buckets[body.bucket]) throw bad(`this server has no bucket "${str(body.bucket, 80)}"`, 'unknown_bucket');
    if (body.estimate !== null) {
      const problems = checkEstimate(config, body.bucket, body.estimate);
      if (problems.length) throw bad(problems.join('; '), 'invalid_estimate');
    }
    await writeOverride(db, 'estimate', body.bucket, body.estimate, str(body.note, 300) || null);
    live = null;
    log('estimate_set', { bucket: body.bucket, reset: body.estimate === null });
    return c.json({ ok: true, manifest: (await current()).manifest });
  });

  /**
   * Housekeeping, to call every few minutes (a cron on Workers, a timer on Node): finish video
   * jobs nobody polled, give back holds of calls that died, drop old rate-limit rows.
   */
  async function sweep(): Promise<{ videos: number; released: number }> {
    let videos = 0;
    let released = 0;
    const stamp = nowIso();
    await db.run('DELETE FROM ts_rate WHERE expires_at<?', stamp);
    const open = await db.all<VideoRow>("SELECT id,account_ref,model,bucket,status,hold,upstream_id,upstream_ref,error,created_at,usage_json FROM ts_requests WHERE kind='video' AND status='held' AND created_at<? LIMIT 50", new Date(Date.now() - 60_000).toISOString());
    for (const row of open) {
      const job = await advanceVideo(row, await isTestAccount(db, row.account_ref));
      if (job.status === 'completed' || job.status === 'failed') videos++;
      else if (Date.parse(row.created_at) < Date.now() - 2 * 3600_000) {
        await release(db, row.id, 'the video did not finish in two hours');
        released++;
      }
    }
    // A chat or image call that never settled (the process died mid-call): 15 minutes is far past any timeout.
    const dead = await db.all<{ id: string }>("SELECT id FROM ts_requests WHERE kind<>'video' AND status='held' AND created_at<? LIMIT 200", new Date(Date.now() - 15 * 60_000).toISOString());
    for (const row of dead) {
      await release(db, row.id, 'the call never finished');
      released++;
    }
    return { videos, released };
  }

  /** The manifest as it is now (prices and estimates the Store set included). */
  const currentManifest = async () => (await current()).manifest;
  return { app, fetch: app.fetch, manifest, provider, currentManifest, sweep };
}

/**
 * Pass an SSE stream through untouched while reading it: the last `usage` object seen and how
 * much text went out. `done` runs exactly once, when the stream ends or the client goes away.
 */
/** `waitUntil` where the runtime has one (Workers); a no-op on Node, where the process stays up. */
function keepAlive(c: { executionCtx?: unknown }, work: Promise<unknown>) {
  try {
    (c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil?.(work);
  } catch {
    /* Node: hono throws "This context has no ExecutionContext" */
  }
}
/**
 * What the upstream charged us and which host served the call are the operator's business, not the
 * buyer's: OpenRouter puts both in every answer (`usage.cost`, `cost_details`, `is_byok`, `provider`).
 */
export function scrubUpstreamCost<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, any>;
  delete d.provider;
  for (const u of [d.usage, d.response?.usage]) {
    if (u && typeof u === 'object') {
      delete u.cost;
      delete u.cost_details;
      delete u.is_byok;
    }
  }
  return data;
}
function scrubSseLine(line: string): string {
  if (!line.startsWith('data:') || !/"(cost|provider|is_byok)"/.test(line)) return line;
  try {
    return 'data: ' + JSON.stringify(scrubUpstreamCost(JSON.parse(line.slice(5).trim())));
  } catch {
    return line;
  }
}
/** Wallet tokens for what the upstream says a call cost (USD), when the model sets `price.perUsd`. */
function costFloor(m: ModelConfig, usage: unknown): number {
  const cost = Number((usage as { cost?: unknown } | null | undefined)?.cost);
  return m.price?.perUsd && Number.isFinite(cost) && cost > 0 ? Math.ceil(cost * m.price.perUsd) : 0;
}
/**
 * Anthropic prompt caching through OpenRouter: a `cache_control` breakpoint on the system prompt and
 * on the last two messages (at most 4 are allowed), so an agent's long, repeated prefix is billed as
 * a cache read on the next turn instead of fresh input.
 */
export function markAnthropicCache(messages: Array<Record<string, any>>): Array<Record<string, any>> {
  const mark = (msg: Record<string, any>) => {
    const parts = typeof msg.content === 'string' ? (msg.content ? [{ type: 'text', text: msg.content }] : []) : Array.isArray(msg.content) ? msg.content.map((p: unknown) => (p && typeof p === 'object' ? { ...(p as object) } : p)) : null;
    if (!parts?.length) return msg;
    const last = parts.length - 1;
    for (let i = last; i >= 0; i--) {
      const part = parts[i] as Record<string, any>;
      if (part && part.type === 'text' && part.text) {
        parts[i] = { ...part, cache_control: { type: 'ephemeral' } };
        return { ...msg, content: parts };
      }
    }
    return msg;
  };
  const out: Array<Record<string, any>> = messages.map((x) => ({ ...x, content: Array.isArray(x.content) ? x.content.map((p: any) => (p && typeof p === 'object' && 'cache_control' in p ? (({ cache_control: _c, ...rest }) => rest)(p) : p)) : x.content }));
  const sys = out.findIndex((x) => x.role === 'system' || x.role === 'developer');
  if (sys >= 0) out[sys] = mark(out[sys]);
  let marked = 0;
  for (let i = out.length - 1; i >= 0 && marked < 2; i--) {
    if (i === sys || out[i].role === 'tool') continue;
    const next = mark(out[i]);
    if (next !== out[i]) {
      out[i] = next;
      marked++;
    }
  }
  return out;
}
export function meterSse(upstream: ReadableStream<Uint8Array>, done: (seen: { usage: unknown; outputChars: number; aborted: boolean }) => Promise<void>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let usage: unknown = null;
  let outputChars = 0;
  let finished = false;
  const finish = async (aborted: boolean) => {
    if (finished) return;
    finished = true;
    try {
      await done({ usage, outputChars, aborted });
    } catch {
      /* the sweep gives the hold back */
    }
  };
  // `[DONE]` is the end: settle there rather than wait for the stream to close (a forwarded body
  // may stay open after it, and the buyer may hang up as soon as they have it).
  let sawDone = false;
  const read = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') sawDone = true;
    if (!data || data === '[DONE]') return;
    try {
      const obj = JSON.parse(data) as Record<string, any>;
      const u = obj.usage ?? obj.response?.usage;
      if (u) usage = u;
      const delta = obj.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') outputChars += delta.content.length;
      if (typeof delta?.reasoning_content === 'string') outputChars += delta.reasoning_content.length;
      if (Array.isArray(delta?.tool_calls)) outputChars += JSON.stringify(delta.tool_calls).length;
      if (typeof obj.delta === 'string') outputChars += obj.delta.length;
    } catch {
      /* not JSON: pass it through, nothing to meter */
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Keep reading until there is a whole line to pass on: a pull that enqueues nothing is not
        // called again (an upstream that splits a line across chunks would stall the stream).
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) {
            if (buffer) {
              read(buffer);
              controller.enqueue(encoder.encode(scrubSseLine(buffer)));
            }
            await finish(false);
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let nl;
          let out = '';
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            read(line.trimEnd());
            out += scrubSseLine(line) + '\n';
            buffer = buffer.slice(nl + 1);
          }
          if (sawDone) await finish(false);
          if (out) {
            controller.enqueue(encoder.encode(out));
            return;
          }
        }
      } catch (e) {
        await finish(true);
        controller.error(e);
      }
    },
    async cancel(reason) {
      await finish(true);
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export const newRequestId = randomId;
