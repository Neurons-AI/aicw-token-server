/**
 * The conformance check: does this URL behave like an AICW token server?
 *
 * It talks to the server only over HTTP, the way the Store and an app do, with a throwaway
 * "test" account. A server built on this library answers test accounts from its mock adapter,
 * so a check costs nothing upstream. A server written from scratch must do the same:
 *
 *   - an account created with `test: true` never reaches a real model;
 *   - for such an account, a prompt containing `[[fail]]` fails like a broken upstream (5xx)
 *     and one containing `[[refuse]]` is refused (400) — and neither is charged.
 *
 * The AICW Store runs this when a developer registers a server and again every week.
 */
import type { Signer } from '../crypto.ts';
import { balanceHeader, KEY_ID_HEADER, PROTOCOL_VERSION, SIGNATURE_HEADER, WELL_KNOWN_PATH, type MeBalance, type PublicModel, type ServerManifest } from '../protocol.ts';
import { signedRequest } from '../store-client.ts';

export interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
}
export interface CheckReport {
  ok: boolean;
  url: string;
  passed: number;
  failed: number;
  skipped: number;
  results: CheckResult[];
  manifest: ServerManifest | null;
  ranAt: string;
}
export interface CheckOptions {
  url: string;
  /** A key the server trusts (the Store's, or a test key the developer added). */
  signer: Signer;
  fetch?: typeof fetch;
  /** Milliseconds between video status polls (default 400). */
  pollMs?: number;
}
class Skip extends Error {}
const rand = () => Math.random().toString(36).slice(2, 12);

export async function runConformance(opts: CheckOptions): Promise<CheckReport> {
  const f = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, '');
  const results: CheckResult[] = [];
  const run = Date.now().toString(36) + rand();
  const accountRef = `check-acct-${run}`;
  const deviceA = `check-dev-a-${run}`;
  const deviceB = `check-dev-b-${run}`;
  const receipt = `check-rcpt-${run}`;
  let manifest: ServerManifest | null = null;
  let keyA = '';
  let keyB = '';

  const step = async (id: string, title: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      results.push({ id, title, ok: true, ...(detail ? { detail } : {}) });
    } catch (e) {
      if (e instanceof Skip) results.push({ id, title, ok: true, skipped: true, detail: e.message });
      else results.push({ id, title, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  const expect = (cond: unknown, message: string) => {
    if (!cond) throw new Error(message);
  };
  const call = (path: string, init: RequestInit = {}) => f(base + path, { ...init, signal: AbortSignal.timeout(30_000) });
  const signed = async (path: string, body: Record<string, unknown>, at?: Date) => {
    const req = await signedRequest(opts.signer, body, at);
    return call(path, { method: 'POST', headers: req.headers, body: req.body });
  };
  const api = (path: string, key: string, init: RequestInit = {}) => call('/v1' + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${key}` } });
  const post = (path: string, key: string, body: unknown) => api(path, key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = async (res: Response) => (await res.json().catch(() => ({}))) as Record<string, any>;
  const wallet = async (): Promise<MeBalance> => (await (await api('/me/balance', keyA)).json()) as MeBalance;
  const first = (type: PublicModel['type']) => manifest?.models.find((m) => m.type === type);
  const need = (type: PublicModel['type']): PublicModel => {
    const m = first(type);
    if (!m) throw new Skip(`the server declares no ${type} model`);
    if (!keyA) throw new Error('no device key (an earlier check failed)');
    return m;
  };
  /** Run a call that must be charged: the bucket goes down and nothing stays reserved. */
  const charged = async (bucket: string, fn: () => Promise<string | void>) => {
    const before = await wallet();
    const detail = await fn();
    const after = await wallet();
    expect((after.balances[bucket] ?? 0) < (before.balances[bucket] ?? 0), `the call was not charged (${bucket} stayed at ${after.balances[bucket]})`);
    expect((after.held[bucket] ?? 0) === 0, `${after.held[bucket]} ${bucket} are still reserved after the call ended`);
    return `${detail ? detail + '; ' : ''}charged ${(before.balances[bucket] ?? 0) - (after.balances[bucket] ?? 0)}`;
  };
  /** Run a call that must fail and must cost nothing. */
  const free = async (bucket: string, fn: () => Promise<void>) => {
    const before = await wallet();
    await fn();
    const after = await wallet();
    expect((after.balances[bucket] ?? 0) === (before.balances[bucket] ?? 0), `a failed call was charged (${bucket}: ${before.balances[bucket]} → ${after.balances[bucket]})`);
    expect((after.held[bucket] ?? 0) === 0, `${after.held[bucket]} ${bucket} are still reserved after a failed call`);
  };

  await step('manifest', 'The server describes itself', async () => {
    const res = await call(WELL_KNOWN_PATH);
    expect(res.ok, `GET ${WELL_KNOWN_PATH} answered ${res.status}`);
    const m = (await res.json()) as ServerManifest;
    expect(m.protocol === PROTOCOL_VERSION, `protocol is ${m.protocol}, expected ${PROTOCOL_VERSION}`);
    expect(typeof m.name === 'string' && m.name.trim(), 'name is missing');
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(m.providerId)), 'providerId must be lowercase letters, digits and dashes');
    expect(/^https?:\/\/.+\/v1$/.test(String(m.baseUrl)), 'baseUrl must be an http(s) URL ending in /v1');
    expect(Array.isArray(m.buckets) && m.buckets.length, 'no buckets declared');
    expect(Array.isArray(m.models) && m.models.length, 'no models declared');
    const buckets = new Set(m.buckets.map((b) => b.id));
    for (const model of m.models) expect(buckets.has(model.bucket), `model "${model.id}" spends bucket "${model.bucket}", which is not declared`);
    manifest = m;
    return `${m.models.length} model(s), ${m.buckets.length} bucket(s)`;
  });
  await step('health', 'The health route answers', async () => {
    const res = await call('/healthz');
    expect(res.ok, `GET /healthz answered ${res.status}`);
  });
  await step('sig-missing', 'An unsigned Store call is refused', async () => {
    const res = await call('/aicw/fulfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receiptId: receipt, ts: new Date().toISOString() }) });
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });
  await step('sig-tampered', 'A Store call changed after signing is refused', async () => {
    const req = await signedRequest(opts.signer, { accountRef, deviceRef: deviceA, test: true });
    const res = await call('/aicw/keys', { method: 'POST', headers: req.headers, body: req.body.replace(accountRef, accountRef + 'x') });
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });
  await step('sig-wrong-key', 'A Store call with an unknown key id is refused', async () => {
    const req = await signedRequest(opts.signer, { accountRef, deviceRef: deviceA, test: true });
    const res = await call('/aicw/keys', { method: 'POST', headers: { ...req.headers, [KEY_ID_HEADER]: '00000000', [SIGNATURE_HEADER]: req.headers[SIGNATURE_HEADER] }, body: req.body });
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });
  await step('sig-stale', 'A signed call from ten minutes ago is refused', async () => {
    const res = await signed('/aicw/keys', { accountRef, deviceRef: deviceA, test: true }, new Date(Date.now() - 10 * 60_000));
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });
  await step('key-issue', 'The Store can get a device key', async () => {
    const res = await signed('/aicw/keys', { accountRef, deviceRef: deviceA, test: true });
    const data = await json(res);
    expect(res.ok, `POST /aicw/keys answered ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    expect(typeof data.key === 'string' && data.key.length >= 24, 'the answer carries no key');
    expect(data.provider?.id === manifest?.providerId, 'provider.id differs from the manifest');
    expect(data.provider?.baseUrl === manifest?.baseUrl, 'provider.baseUrl differs from the manifest');
    expect(Array.isArray(data.provider?.models) && data.provider.models.length === manifest?.models.length, 'provider.models differs from the manifest');
    keyA = data.key;
  });
  await step('auth-none', 'The API refuses a call with no key', async () => {
    const res = await call('/v1/models');
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });
  await step('auth-bad', 'The API refuses an unknown key', async () => {
    const res = await api('/models', 'sk-not-a-real-key-000000000000000000000000');
    expect(res.status === 401, `expected 401, got ${res.status}`);
    expect((await json(res)).error?.code, 'the error body has no error.code');
  });
  await step('models', 'The key lists the models', async () => {
    const res = await api('/models', keyA);
    expect(res.ok, `GET /v1/models answered ${res.status}`);
    const ids = new Set(((await json(res)).data ?? []).map((m: { id: string }) => m.id));
    for (const m of manifest?.models ?? []) expect(ids.has(m.id), `"${m.id}" is in the manifest but not in /v1/models`);
  });
  await step('balance-empty', 'A new account starts with nothing', async () => {
    const b = await wallet();
    for (const bucket of manifest?.buckets ?? []) expect((b.balances[bucket.id] ?? 0) === 0, `${bucket.id} starts at ${b.balances[bucket.id]}`);
  });
  await step('no-tokens', 'A call without tokens is refused with 402 and says which bucket', async () => {
    const m = manifest?.models[0];
    expect(m && keyA, 'no model or key');
    const res =
      m!.type === 'chat'
        ? await post('/chat/completions', keyA, { model: m!.id, messages: [{ role: 'user', content: 'hi' }] })
        : m!.type === 'image'
          ? await post('/images/generations', keyA, { model: m!.id, prompt: 'a dot' })
          : m!.type === 'video'
            ? await post('/videos', keyA, { model: m!.id, prompt: 'a dot' })
            : m!.type === 'tts'
              ? await post('/audio/speech', keyA, { model: m!.id, input: 'hi', voice: 'alloy' })
              : m!.type === 'embedding'
                ? await post('/embeddings', keyA, { model: m!.id, input: 'hi' })
                : m!.type === 'other'
                  ? await post('/generate', keyA, { model: m!.id })
                  : null;
    if (!res) throw new Skip('the first model is speech-to-text');
    expect(res.status === 402, `expected 402, got ${res.status}`);
    const err = (await json(res)).error ?? {};
    expect(err.code === 'insufficient_tokens', `error.code is "${err.code}", expected "insufficient_tokens"`);
    expect(err.bucket === m!.bucket, `error.bucket is "${err.bucket}", expected "${m!.bucket}"`);
  });
  const grants = () => (manifest?.buckets ?? []).map((b) => ({ bucket: b.id, amount: 100_000 }));
  await step('fulfill', 'A paid receipt adds tokens', async () => {
    const res = await signed('/aicw/fulfill', { receiptId: receipt, accountRef, sku: 'conformance-check', quantity: 1, grants: grants(), orderRef: `check-${run}`, paidAt: new Date().toISOString(), test: true });
    const data = await json(res);
    expect(res.ok, `POST /aicw/fulfill answered ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    expect(data.applied === true, 'applied should be true the first time');
    for (const g of grants()) expect(data.balances?.[g.bucket] === g.amount, `${g.bucket} is ${data.balances?.[g.bucket]}, expected ${g.amount}`);
  });
  await step('fulfill-replay', 'The same receipt delivered twice adds tokens once', async () => {
    const res = await signed('/aicw/fulfill', { receiptId: receipt, accountRef, sku: 'conformance-check', quantity: 1, grants: grants(), orderRef: `check-${run}`, paidAt: new Date().toISOString(), test: true });
    expect(res.ok, `the replay answered ${res.status} (it must succeed without changing anything)`);
    const data = await json(res);
    expect(data.applied === false, 'applied should be false on a replay');
    for (const g of grants()) expect(data.balances?.[g.bucket] === g.amount, `${g.bucket} became ${data.balances?.[g.bucket]} after a replay`);
  });
  await step('fulfill-unknown-bucket', 'A receipt for a bucket the server does not have is refused', async () => {
    const res = await signed('/aicw/fulfill', { receiptId: receipt + '-x', accountRef, sku: 'conformance-check', quantity: 1, grants: [{ bucket: 'no_such_bucket_zz', amount: 5 }], orderRef: `check-${run}`, paidAt: new Date().toISOString(), test: true });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });
  await step('unknown-model', 'An unknown model is a 404', async () => {
    const res = await post('/chat/completions', keyA, { model: 'no-such-model-zz', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });

  await step('chat', 'Chat: a plain answer, with usage, is charged', async () => {
    const m = need('chat');
    return charged(m.bucket, async () => {
      const res = await post('/chat/completions', keyA, { model: m.id, messages: [{ role: 'user', content: 'Say hello.' }] });
      expect(res.ok, `answered ${res.status}: ${JSON.stringify(await json(res.clone())).slice(0, 200)}`);
      expect(res.headers.get(balanceHeader(m.bucket)) !== null, `the answer has no ${balanceHeader(m.bucket)} header`);
      const data = await json(res);
      expect(typeof data.choices?.[0]?.message?.content === 'string', 'choices[0].message.content is missing');
      expect(Number(data.usage?.total_tokens) > 0, 'usage.total_tokens is missing');
    });
  });
  await step('chat-stream', 'Chat: a streamed answer ends with usage and [DONE], and is charged', async () => {
    const m = need('chat');
    return charged(m.bucket, async () => {
      const res = await post('/chat/completions', keyA, { model: m.id, stream: true, messages: [{ role: 'user', content: 'Say hello.' }] });
      expect(res.ok, `answered ${res.status}`);
      expect((res.headers.get('content-type') || '').includes('text/event-stream'), `content-type is ${res.headers.get('content-type')}`);
      const text = await res.text();
      expect(text.includes('data: [DONE]'), 'the stream does not end with "data: [DONE]"');
      expect(/"usage"\s*:\s*\{/.test(text), 'no chunk carries usage (set stream_options.include_usage upstream)');
      expect(/"delta"/.test(text), 'no chunk carries a delta');
    });
  });
  await step('chat-fail', 'Chat: a broken upstream costs nothing', async () => {
    const m = need('chat');
    await free(m.bucket, async () => {
      const res = await post('/chat/completions', keyA, { model: m.id, messages: [{ role: 'user', content: '[[fail]]' }] });
      expect(res.status >= 500, `expected a 5xx, got ${res.status}`);
      expect((await json(res)).error?.code, 'the error body has no error.code');
    });
  });
  await step('chat-refuse', 'Chat: a refused prompt is a 400 and costs nothing', async () => {
    const m = need('chat');
    await free(m.bucket, async () => {
      const res = await post('/chat/completions', keyA, { model: m.id, messages: [{ role: 'user', content: '[[refuse]]' }] });
      expect(res.status === 400, `expected 400, got ${res.status}`);
    });
  });
  await step('wrong-type', 'A model on the wrong endpoint is a 400', async () => {
    const chat = need('chat');
    const res = await post('/images/generations', keyA, { model: chat.id, prompt: 'a dot' });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });
  await step('image', 'Image: returns base64 image data and is charged', async () => {
    const m = need('image');
    return charged(m.bucket, async () => {
      const res = await post('/images/generations', keyA, { model: m.id, prompt: 'a red dot' });
      expect(res.ok, `answered ${res.status}: ${JSON.stringify(await json(res.clone())).slice(0, 200)}`);
      const data = await json(res);
      expect(typeof data.data?.[0]?.b64_json === 'string' || typeof data.data?.[0]?.url === 'string', 'data[0] has neither b64_json nor url');
    });
  });
  await step('image-refuse', 'Image: a refused prompt costs nothing', async () => {
    const m = need('image');
    await free(m.bucket, async () => {
      const res = await post('/images/generations', keyA, { model: m.id, prompt: '[[refuse]]' });
      expect(res.status === 400, `expected 400, got ${res.status}`);
    });
  });
  await step('video', 'Video: a job that finishes, can be downloaded, and is charged once', async () => {
    const m = need('video');
    return charged(m.bucket, async () => {
      const res = await post('/videos', keyA, { model: m.id, prompt: 'a slow pan over hills', resolution: '480p', duration: 4 });
      expect(res.ok, `POST /v1/videos answered ${res.status}: ${JSON.stringify(await json(res.clone())).slice(0, 200)}`);
      const job = await json(res);
      expect(typeof job.id === 'string' && job.id, 'the job has no id');
      expect(['queued', 'in_progress', 'completed'].includes(job.status), `unexpected status "${job.status}"`);
      let state = job;
      for (let i = 0; i < 20 && state.status !== 'completed' && state.status !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
        state = await json(await api(`/videos/${job.id}`, keyA));
      }
      expect(state.status === 'completed', `the job ended as "${state.status}"`);
      expect(typeof state.url === 'string' && state.url.endsWith(`/videos/${job.id}/content`), 'a completed job must carry url = …/v1/videos/{id}/content');
      const file = await api(`/videos/${job.id}/content`, keyA);
      expect(file.ok, `the file answered ${file.status}`);
      expect((await file.arrayBuffer()).byteLength > 0, 'the file is empty');
      // Polling again must not charge again.
      await api(`/videos/${job.id}`, keyA);
    });
  });
  await step('video-fail', 'Video: a job that fails costs nothing', async () => {
    const m = need('video');
    await free(m.bucket, async () => {
      const res = await post('/videos', keyA, { model: m.id, prompt: '[[fail]] a pan', resolution: '480p', duration: 4 });
      if (res.status >= 400) return;
      const job = await json(res);
      let state = job;
      for (let i = 0; i < 20 && state.status !== 'completed' && state.status !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
        state = await json(await api(`/videos/${job.id}`, keyA));
      }
      expect(state.status === 'failed', `the job ended as "${state.status}"`);
    });
  });
  await step('video-private', 'Video: another account cannot read the job', async () => {
    need('video');
    const res = await api('/videos/00000000-0000-4000-8000-000000000000', keyA);
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });
  await step('tts', 'Speech: returns audio and is charged', async () => {
    const m = need('tts');
    return charged(m.bucket, async () => {
      const res = await post('/audio/speech', keyA, { model: m.id, input: 'Hello there.', voice: 'alloy' });
      expect(res.ok, `answered ${res.status}`);
      expect((await res.arrayBuffer()).byteLength > 0, 'the audio is empty');
    });
  });
  await step('stt', 'Transcription: returns text and is charged', async () => {
    const m = need('stt');
    return charged(m.bucket, async () => {
      const form = new FormData();
      form.set('model', m.id);
      form.set('file', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }), 'a.wav');
      const res = await api('/audio/transcriptions', keyA, { method: 'POST', body: form });
      expect(res.ok, `answered ${res.status}`);
      expect((await res.text()).length > 0, 'the transcription is empty');
    });
  });
  await step('embedding', 'Embeddings: returns vectors and is charged', async () => {
    const m = need('embedding');
    return charged(m.bucket, async () => {
      const res = await post('/embeddings', keyA, { model: m.id, input: 'hello world' });
      expect(res.ok, `answered ${res.status}`);
      expect(Array.isArray((await json(res)).data?.[0]?.embedding), 'data[0].embedding is missing');
    });
  });
  await step('other', 'Other models: one call, charged per request', async () => {
    const m = need('other');
    return charged(m.bucket, async () => {
      const res = await post('/generate', keyA, { model: m.id, input: { prompt: 'a short tune' } });
      expect(res.ok, `answered ${res.status}`);
    });
  });

  await step('store-balance', 'The Store reads the same balance the app sees', async () => {
    const res = await signed('/aicw/balance', { accountRef });
    expect(res.ok, `POST /aicw/balance answered ${res.status}`);
    const data = await json(res);
    const mine = await wallet();
    for (const b of manifest?.buckets ?? []) expect(data.balances?.[b.id] === mine.balances[b.id], `${b.id}: the Store sees ${data.balances?.[b.id]}, the app sees ${mine.balances[b.id]}`);
    expect(Array.isArray(data.keys) && data.keys.length >= 1, 'keys are missing from the balance answer');
  });
  await step('key-second-device', 'A second device gets its own key and the first keeps working', async () => {
    const res = await signed('/aicw/keys', { accountRef, deviceRef: deviceB, test: true });
    expect(res.ok, `answered ${res.status}`);
    keyB = (await json(res)).key;
    expect(keyB && keyB !== keyA, 'the second device got the same key');
    expect((await api('/models', keyA)).ok, 'the first device key stopped working');
    expect((await api('/models', keyB)).ok, 'the second device key does not work');
  });
  await step('key-reissue', 'Asking again for a device replaces its key', async () => {
    const res = await signed('/aicw/keys', { accountRef, deviceRef: deviceB, test: true });
    expect(res.ok, `answered ${res.status}`);
    const fresh = (await json(res)).key;
    expect((await api('/models', keyB)).status === 401, 'the replaced key still works');
    expect((await api('/models', fresh)).ok, 'the new key does not work');
    keyB = fresh;
  });
  await step('refund', 'A refund takes back only what is unused', async () => {
    const before = await wallet();
    const res = await signed('/aicw/refund', { receiptId: receipt });
    expect(res.ok, `POST /aicw/refund answered ${res.status}`);
    const data = await json(res);
    expect(data.applied === true, 'applied should be true the first time');
    const after = await wallet();
    for (const g of grants()) {
      const took = (data.refunded ?? []).find((r: { bucket: string }) => r.bucket === g.bucket)?.amount ?? 0;
      expect(took <= g.amount, `${g.bucket}: refunded ${took}, more than the receipt granted`);
      expect(took === Math.min(g.amount, Math.max(before.balances[g.bucket] ?? 0, 0)), `${g.bucket}: refunded ${took}, expected the unused ${before.balances[g.bucket]}`);
      expect((after.balances[g.bucket] ?? 0) === (before.balances[g.bucket] ?? 0) - took, `${g.bucket}: balance is ${after.balances[g.bucket]} after the refund`);
    }
  });
  await step('refund-replay', 'A refund delivered twice happens once', async () => {
    const before = await wallet();
    const res = await signed('/aicw/refund', { receiptId: receipt });
    expect(res.ok, `the replay answered ${res.status}`);
    expect((await json(res)).applied === false, 'applied should be false on a replay');
    const after = await wallet();
    for (const b of manifest?.buckets ?? []) expect(after.balances[b.id] === before.balances[b.id], `${b.id} changed on a refund replay`);
  });
  await step('refund-unknown', 'A refund for a receipt the server never saw is a 404', async () => {
    const res = await signed('/aicw/refund', { receiptId: receipt + '-never' });
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });
  await step('revoke', 'A revoked account cannot call the API', async () => {
    const res = await signed('/aicw/keys/revoke', { accountRef });
    expect(res.ok, `POST /aicw/keys/revoke answered ${res.status}`);
    expect((await api('/models', keyA)).status === 401, 'the first key still works after revoke');
    expect((await api('/models', keyB)).status === 401, 'the second key still works after revoke');
  });

  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  return { ok: failed === 0, url: base, passed: results.length - failed - skipped, failed, skipped, results, manifest, ranAt: new Date().toISOString() };
}

export function formatReport(report: CheckReport): string {
  const lines = report.results.map((r) => `${r.skipped ? '–' : r.ok ? '✓' : '✗'} ${r.title}${r.detail ? `  (${r.detail})` : ''}`);
  lines.push('', `${report.ok ? 'PASS' : 'FAIL'}: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped — ${report.url}`);
  return lines.join('\n');
}
