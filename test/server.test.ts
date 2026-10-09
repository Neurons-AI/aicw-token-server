import { afterEach, describe, expect, it } from 'vitest';
import { formatReport, runConformance } from '../src/check/suite.ts';
import { balanceHeader, generateSigner, signedRequest, validateConfig, WELL_KNOWN_PATH } from '../src/index.ts';
import { BASE, harness, sampleConfig, upstream } from './helpers.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
const sse = (objs: unknown[]) => [...objs.map((o) => `data: ${JSON.stringify(o)}\n\n`), 'data: [DONE]\n\n'];

describe('conformance', () => {
  it('a server built on the library passes every check', async () => {
    const h = await harness();
    const report = await runConformance({ url: BASE, signer: h.signer, fetch: h.f, pollMs: 150 });
    expect(report.results.filter((r) => !r.ok), formatReport(report)).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(35);
  });
  it('skips the model types a server does not declare', async () => {
    const h = await harness({ buckets: { llm_tokens: { label: 'LLM tokens' } }, models: [{ id: 'chat-1', type: 'chat', bucket: 'llm_tokens', adapter: 'mock' }] });
    const report = await runConformance({ url: BASE, signer: h.signer, fetch: h.f, pollMs: 150 });
    expect(report.ok, formatReport(report)).toBe(true);
    expect(report.results.find((r) => r.id === 'video')?.skipped).toBe(true);
  });
  it('fails a server that does not trust the checking key', async () => {
    const h = await harness();
    const report = await runConformance({ url: BASE, signer: await generateSigner(), fetch: h.f });
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.id === 'key-issue')?.ok).toBe(false);
  });
});

describe('config', () => {
  it('names every problem in a broken config', () => {
    const { problems } = validateConfig({ name: '', providerId: 'Bad Id', keyPrefix: 'X', publicUrl: 'ftp://x', buckets: {}, adapters: { a: { kind: 'nope' } }, models: [{ id: 'm', type: 'chat', bucket: 'b', adapter: 'zz' }] });
    expect(problems.join('\n')).toMatch(/name:/);
    expect(problems.join('\n')).toMatch(/providerId:/);
    expect(problems.join('\n')).toMatch(/keyPrefix:/);
    expect(problems.join('\n')).toMatch(/publicUrl:/);
    expect(problems.join('\n')).toMatch(/buckets:/);
    expect(problems.join('\n')).toMatch(/adapters\.a\.kind/);
    expect(problems.join('\n')).toMatch(/models\[0\]\.bucket/);
    expect(problems.join('\n')).toMatch(/models\[0\]\.adapter/);
  });
  it('accepts the sample', () => {
    expect(validateConfig(sampleConfig()).problems).toEqual([]);
  });
});

describe('the manifest and the provider descriptor', () => {
  it('describe the same models', async () => {
    const h = await harness();
    const manifest = await (await h.f(BASE + WELL_KNOWN_PATH)).json();
    expect(manifest).toMatchObject({ protocol: 1, providerId: 'test-tokens', baseUrl: BASE + '/v1' });
    const issued = await h.store.issueKey('acct-zzzzzz', 'device-zzzzzz');
    expect(issued.provider).toEqual({ id: 'test-tokens', name: 'Test Tokens', baseUrl: BASE + '/v1', models: manifest.models });
    expect(issued.key).toMatch(/^sk-test-[0-9A-Za-z]{40}$/);
  });
  it('never exposes adapters, upstream names or prices', async () => {
    const h = await harness({ models: [{ id: 'chat-1', type: 'chat', bucket: 'llm_tokens', adapter: 'mock', upstreamModel: 'secret-upstream-name', price: { input: 3 } }] });
    const text = await (await h.f(BASE + WELL_KNOWN_PATH)).text();
    expect(text).not.toContain('secret-upstream-name');
    expect(text).not.toContain('adapter');
  });
});

describe('signed Store calls', () => {
  it('refuse a body whose time is far in the future', async () => {
    const h = await harness();
    const req = await signedRequest(h.signer, { accountRef: 'acct-aaaaaa' }, new Date(Date.now() + 3600_000));
    expect((await h.f(BASE + '/aicw/balance', { method: 'POST', headers: req.headers, body: req.body })).status).toBe(401);
  });
  it('adjust is off unless the operator allows it', async () => {
    const off = await harness();
    await expect(off.store.adjust({ accountRef: 'acct-aaaaaa', bucket: 'llm_tokens', delta: 5, ref: 'adj-000001' })).rejects.toMatchObject({ status: 403 });
    const on = await harness({ allowStoreAdjust: true });
    expect((await on.store.adjust({ accountRef: 'acct-aaaaaa', bucket: 'llm_tokens', delta: 5, ref: 'adj-000001' })).balances.llm_tokens).toBe(5);
    expect((await on.store.adjust({ accountRef: 'acct-aaaaaa', bucket: 'llm_tokens', delta: 5, ref: 'adj-000001' })).balances.llm_tokens).toBe(5);
  });
  it('the Store sees usage per model', async () => {
    const h = await harness();
    const a = await h.account();
    await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'x', quality: 'high' });
    const b = await h.store.balance(a.accountRef);
    expect(b.usage).toEqual([{ bucket: 'image_tokens', model: 'image-1', requests: 1, charged: 4 }]);
    expect(b.balances.image_tokens).toBe(96);
    expect(b.keys[0]).toMatchObject({ status: 'active', deviceRef: expect.stringContaining('device-') });
  });
});

describe('a real (non-test) account goes to the configured upstream', () => {
  const withUpstream = async (handler: Parameters<typeof upstream>[0], models = sampleConfig().models) => {
    const up = await upstream(handler);
    closers.push(up.close);
    const h = await harness({ adapters: { up: { kind: 'openai', baseUrl: up.url + '/v1', apiKeyEnv: 'UP_KEY' }, mock: { kind: 'mock' } }, models: models.map((m) => ({ ...m, adapter: 'up' })) }, { UP_KEY: 'upstream-secret' });
    return { up, h };
  };

  it('chat: sends the upstream key and model, charges the reported usage', async () => {
    const { up, h } = await withUpstream(() => ({ body: JSON.stringify({ id: 'x', model: 'gpt-real', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } } }) }), [
      { id: 'chat-1', type: 'chat', bucket: 'llm_tokens', adapter: 'up', upstreamModel: 'gpt-real' },
    ]);
    const a = await h.account();
    const res = await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get(balanceHeader('llm_tokens'))).toBe('99880');
    const data = await res.json();
    expect(data.model).toBe('chat-1');
    const sent = JSON.parse(up.calls[0].body.toString());
    expect(up.calls[0].url).toBe('/v1/chat/completions');
    expect(up.calls[0].headers.authorization).toBe('Bearer upstream-secret');
    expect(sent.model).toBe('gpt-real');
    expect(sent.max_completion_tokens).toBeGreaterThan(0);
    expect((await a.wallet()).held.llm_tokens).toBe(0);
  });
  it('chat: weights turn model tokens into wallet tokens', async () => {
    const { h } = await withUpstream(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } }) }), [
      { id: 'chat-1', type: 'chat', bucket: 'llm_tokens', adapter: 'up', price: { input: 1, cacheRead: 0.1, output: 5 } },
    ]);
    const a = await h.account();
    await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'x' }] });
    // 60 fresh + 40 cached × 0.1 + 10 out × 5 = 114
    expect((await a.wallet()).balances.llm_tokens).toBe(100_000 - 114);
  });
  it('chat stream: asks the upstream for usage, passes chunks through, settles at the end', async () => {
    const { up, h } = await withUpstream(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: sse([{ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }]),
    }));
    const a = await h.account();
    const res = await h.api(a.key, '/chat/completions', { model: 'chat-1', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"content":"Hel"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(JSON.parse(up.calls[0].body.toString()).stream_options).toEqual({ include_usage: true });
    expect(await a.wallet()).toMatchObject({ balances: { llm_tokens: 100_000 - 11 }, held: { llm_tokens: 0 } });
  });
  it('chat stream: an upstream that reports no usage is charged an estimate, not nothing', async () => {
    const { h } = await withUpstream(() => ({ headers: { 'content-type': 'text/event-stream' }, body: sse([{ choices: [{ delta: { content: 'x'.repeat(400) } }] }]) }));
    const a = await h.account();
    await (await h.api(a.key, '/chat/completions', { model: 'chat-1', stream: true, messages: [{ role: 'user', content: 'hello' }] })).text();
    const w = await a.wallet();
    expect(w.held.llm_tokens).toBe(0);
    expect(100_000 - w.balances.llm_tokens).toBeGreaterThanOrEqual(100);
    expect(100_000 - w.balances.llm_tokens).toBeLessThan(200);
  });
  it('chat stream: a client that walks away is still settled', async () => {
    const { h } = await withUpstream(() => ({ headers: { 'content-type': 'text/event-stream' }, body: sse([{ choices: [{ delta: { content: 'a'.repeat(40) } }] }, { choices: [{ delta: { content: 'b'.repeat(40) } }] }, { choices: [], usage: { total_tokens: 50, prompt_tokens: 30, completion_tokens: 20 } }]) }));
    const a = await h.account();
    const res = await h.api(a.key, '/chat/completions', { model: 'chat-1', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const w = await a.wallet();
    expect(w.held.llm_tokens).toBe(0);
    expect(w.balances.llm_tokens).toBeLessThan(100_000);
  });
  it('chat: a small balance caps what the model may write', async () => {
    const { up, h } = await withUpstream(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) }));
    const a = await h.account({ llm_tokens: 300 });
    await h.api(a.key, '/chat/completions', { model: 'chat-1', max_tokens: 9000, messages: [{ role: 'user', content: 'hello' }] });
    const sent = JSON.parse(up.calls[0].body.toString());
    expect(sent.max_tokens).toBeLessThanOrEqual(300);
    expect(sent.max_completion_tokens).toBeUndefined();
  });
  it('responses API: usage in input/output tokens is charged', async () => {
    const { up, h } = await withUpstream(() => ({ body: JSON.stringify({ id: 'r', status: 'completed', output: [], usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 } }) }));
    const a = await h.account();
    const res = await h.api(a.key, '/responses', { model: 'chat-1', input: 'hello' });
    expect(res.status).toBe(200);
    expect(up.calls[0].url).toBe('/v1/responses');
    expect((await a.wallet()).balances.llm_tokens).toBe(100_000 - 42);
  });
  it('upstream 401/500 become "unavailable" and cost nothing; the upstream text never leaks', async () => {
    for (const status of [401, 500]) {
      const { h } = await withUpstream(() => ({ status, body: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-upstream-leak' } }) }));
      const a = await h.account();
      const res = await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'x' }] });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('upstream_unavailable');
      expect(text).not.toContain('sk-upstream-leak');
      expect(await a.wallet()).toMatchObject({ balances: { llm_tokens: 100_000 }, held: { llm_tokens: 0 } });
    }
  });
  it('an upstream rate limit is a 503, a refusal is a 400 with the reason', async () => {
    const limited = await withUpstream(() => ({ status: 429, body: '{}' }));
    const a = await limited.h.account();
    expect((await limited.h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [] })).status).toBe(503);
    const refused = await withUpstream(() => ({ status: 400, body: JSON.stringify({ error: { message: 'Your request was rejected by the safety system.', code: 'moderation_blocked' } }) }));
    const b = await refused.h.account();
    const res = await refused.h.api(b.key, '/images/generations', { model: 'image-1', prompt: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' });
    expect((await b.wallet()).balances.image_tokens).toBe(100);
  });
  it('a server with no upstream key says so with a 503 and charges nothing', async () => {
    const up = await upstream(() => ({ body: '{}' }));
    closers.push(up.close);
    const h = await harness({ adapters: { up: { kind: 'openai', baseUrl: up.url, apiKeyEnv: 'MISSING' } }, models: [{ id: 'chat-1', type: 'chat', bucket: 'llm_tokens', adapter: 'up' }] });
    const a = await h.account({ llm_tokens: 1000 });
    const res = await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'x' }] });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('upstream_not_configured');
    expect(up.calls).toHaveLength(0);
    expect((await a.wallet()).balances.llm_tokens).toBe(1000);
  });
  it('images: charged by quality and by how many came back', async () => {
    const { up, h } = await withUpstream((_req, body) => ({ body: JSON.stringify({ data: Array.from({ length: JSON.parse(body.toString()).n === 3 ? 2 : 1 }, () => ({ b64_json: 'AAAA' })) }) }));
    const a = await h.account();
    await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'a cat', quality: 'high' });
    expect((await a.wallet()).balances.image_tokens).toBe(96);
    // Asked for 3, the upstream made 2: pay for 2.
    const res = await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'a cat', n: 3 });
    expect(res.headers.get(balanceHeader('image_tokens'))).toBe('94');
    expect(JSON.parse(up.calls[1].body.toString())).toMatchObject({ model: 'image-1', n: 3 });
    expect((await a.wallet()).held.image_tokens).toBe(0);
  });
  it('images: an answer with no image costs nothing', async () => {
    const { h } = await withUpstream(() => ({ body: JSON.stringify({ data: [] }) }));
    const a = await h.account();
    const res = await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'a cat' });
    expect(res.status).toBe(502);
    expect((await a.wallet()).balances.image_tokens).toBe(100);
  });
  it('image edits: the form reaches the upstream with the files, and costs one more', async () => {
    const { up, h } = await withUpstream(() => ({ body: JSON.stringify({ data: [{ b64_json: 'AAAA' }] }) }), [{ id: 'image-1', type: 'image', bucket: 'image_tokens', adapter: 'up', upstreamModel: 'gpt-image-2', price: { quality: { low: 1, medium: 1, high: 4, auto: 1 }, edit: 1 } }]);
    const a = await h.account();
    const form = new FormData();
    form.set('model', 'image-1');
    form.set('prompt', 'add a hat');
    form.append('image[]', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
    const res = await h.api(a.key, '/images/edits', form);
    expect(res.status).toBe(200);
    const sent = up.calls[0].body.toString('latin1');
    expect(up.calls[0].headers['content-type']).toContain('multipart/form-data');
    expect(sent).toContain('gpt-image-2');
    expect(sent).toContain('a.png');
    expect((await a.wallet()).balances.image_tokens).toBe(98);
  });
  it('speech is charged per thousand characters; transcription per request', async () => {
    const { h } = await withUpstream((req) => (req.url!.includes('speech') ? { headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from([1, 2, 3, 4]) } : { body: JSON.stringify({ text: 'hello' }) }));
    const a = await h.account();
    const speech = await h.api(a.key, '/audio/speech', { model: 'voice-1', input: 'x'.repeat(2500), voice: 'alloy' });
    expect(speech.headers.get('content-type')).toBe('audio/mpeg');
    expect((await speech.arrayBuffer()).byteLength).toBe(4);
    expect((await a.wallet()).balances.voice_tokens).toBe(97);
    const form = new FormData();
    form.set('model', 'hear-1');
    form.set('file', new Blob([new Uint8Array([1])]), 'a.wav');
    expect(await (await h.api(a.key, '/audio/transcriptions', form)).json()).toEqual({ text: 'hello' });
    expect((await a.wallet()).balances.voice_tokens).toBe(96);
  });
  it('video through an OpenAI-style job API: held at creation, charged once when done', async () => {
    let polls = 0;
    const { up, h } = await withUpstream((req) => {
      if (req.method === 'POST') return { body: JSON.stringify({ id: 'vid_1', status: 'queued' }) };
      if (req.url!.endsWith('/content')) return { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('MP4DATA') };
      return { body: JSON.stringify({ id: 'vid_1', status: ++polls >= 2 ? 'completed' : 'in_progress', progress: 40 }) };
    });
    const a = await h.account();
    const job = await (await h.api(a.key, '/videos', { model: 'video-1', prompt: 'a pan', resolution: '720p', duration: 5 })).json();
    expect(job).toMatchObject({ object: 'video', status: 'queued', model: 'video-1' });
    expect(await a.wallet()).toMatchObject({ balances: { video_tokens: 90 }, held: { video_tokens: 10 } });
    expect((await (await h.api(a.key, `/videos/${job.id}`)).json()).status).toBe('in_progress');
    expect((await h.api(a.key, `/videos/${job.id}/content`)).status).toBe(409);
    const done = await (await h.api(a.key, `/videos/${job.id}`)).json();
    expect(done).toMatchObject({ status: 'completed', url: `${BASE}/v1/videos/${job.id}/content` });
    await h.api(a.key, `/videos/${job.id}`);
    expect(await a.wallet()).toMatchObject({ balances: { video_tokens: 90 }, held: { video_tokens: 0 } });
    const file = await h.api(a.key, `/videos/${job.id}/content`);
    expect(await file.text()).toBe('MP4DATA');
    expect(up.calls[0].headers['content-type']).toContain('multipart/form-data');
    const other = await h.account();
    expect((await h.api(other.key, `/videos/${job.id}`)).status).toBe(404);
    expect((await h.api(other.key, `/videos/${job.id}/content`)).status).toBe(404);
  });
  it('video through BytePlus Seedance: the task shape, the hidden file URL, a failed task is free', async () => {
    let fail = false;
    const up = await upstream((req, body) => {
      if (req.url === '/file.mp4') return { headers: { 'content-type': 'video/mp4' }, body: Buffer.from('SEEDANCE') };
      if (req.method === 'POST') {
        fail = JSON.parse(body.toString()).content[0].text.includes('boom');
        return { body: JSON.stringify({ id: 'cgt-1' }) };
      }
      return { body: JSON.stringify(fail ? { id: 'cgt-1', status: 'failed', error: { message: 'sensitive content' } } : { id: 'cgt-1', status: 'succeeded', content: { video_url: `http://${req.headers.host}/file.mp4` } }) };
    });
    closers.push(up.close);
    const h = await harness({ adapters: { ark: { kind: 'byteplus', baseUrl: up.url, apiKeyEnv: 'ARK' } }, models: [{ id: 'seedance-2.5', type: 'video', bucket: 'video_tokens', adapter: 'ark', upstreamModel: 'dreamina-seedance-2-5-260628', price: { resolution: { '480p': 1, '720p': 2 }, minSeconds: 4, maxSeconds: 12 } }] }, { ARK: 'ark-secret' });
    const a = await h.account();
    const job = await (await h.api(a.key, '/videos', { model: 'seedance-2.5', prompt: 'a pan', resolution: '720p', duration: 30, images: ['https://example.test/a.png'], ratio: '9:16' })).json();
    const sent = JSON.parse(up.calls[0].body.toString());
    expect(up.calls[0].url).toBe('/contents/generations/tasks');
    expect(up.calls[0].headers.authorization).toBe('Bearer ark-secret');
    expect(sent).toMatchObject({ model: 'dreamina-seedance-2-5-260628', resolution: '720p', duration: 12, ratio: '9:16' });
    expect(sent.content).toEqual([{ type: 'text', text: 'a pan' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png' }, role: 'first_frame' }]);
    expect((await a.wallet()).held.video_tokens).toBe(24);
    const done = await (await h.api(a.key, `/videos/${job.id}`)).json();
    expect(done.status).toBe('completed');
    expect(JSON.stringify(done)).not.toContain('file.mp4');
    expect(await (await h.api(a.key, `/videos/${job.id}/content`)).text()).toBe('SEEDANCE');
    expect((await a.wallet()).balances.video_tokens).toBe(76);
    const bad = await (await h.api(a.key, '/videos', { model: 'seedance-2.5', prompt: 'boom', resolution: '480p', duration: 4 })).json();
    const failed = await (await h.api(a.key, `/videos/${bad.id}`)).json();
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'video_failed' } });
    expect(failed.error.message).toContain('sensitive content');
    expect(await a.wallet()).toMatchObject({ balances: { video_tokens: 76 }, held: { video_tokens: 0 } });
    expect((await h.api(a.key, '/videos', { model: 'seedance-2.5', prompt: 'x', resolution: '4k' })).status).toBe(400);
  });
  it('a test account never reaches the upstream', async () => {
    const { up, h } = await withUpstream(() => ({ body: '{}' }));
    const a = await h.account(undefined, true);
    expect((await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200);
    expect(up.calls).toHaveLength(0);
  });
});

describe('limits and housekeeping', () => {
  it('402 names the bucket, the balance, what is needed and where to top up', async () => {
    const h = await harness();
    const a = await h.account({ llm_tokens: 1, image_tokens: 3 });
    const res = await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'x', quality: 'high' });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatchObject({ code: 'insufficient_tokens', type: 'insufficient_tokens', bucket: 'image_tokens', balance: 3, needed: 4 });
    const none = await h.account({});
    const chat = await (await h.api(none.key, '/chat/completions', { model: 'chat-1', messages: [] })).json();
    expect(chat.error).toMatchObject({ bucket: 'llm_tokens', balance: 0, topup: 'aicoworker://store/skills/topup-llm' });
  });
  it('rate limits one key without touching another', async () => {
    const h = await harness({ limits: { requestsPerMinute: 3 } });
    const a = await h.account();
    const b = await h.account();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await h.api(a.key, '/models')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await h.api(b.key, '/models')).status).toBe(200);
  });
  it('limits how many videos one account makes at a time', async () => {
    const h = await harness({ limits: { maxOpenVideos: 1 } });
    const a = await h.account();
    expect((await h.api(a.key, '/videos', { model: 'video-1', prompt: 'a' })).status).toBe(200);
    const res = await h.api(a.key, '/videos', { model: 'video-1', prompt: 'b' });
    expect(res.status).toBe(429);
    expect((await a.wallet()).held.video_tokens).toBe(10);
  });
  it('refuses an oversized body before reading it', async () => {
    const h = await harness({ limits: { maxBodyBytes: 100 } });
    const a = await h.account();
    const res = await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'x'.repeat(500) }] }, { headers: { 'content-length': '600' } });
    expect(res.status).toBe(413);
  });
  it('the sweep finishes a video nobody polled and frees calls that died', async () => {
    const h = await harness();
    const a = await h.account();
    const job = await (await h.api(a.key, '/videos', { model: 'video-1', prompt: 'a pan', resolution: '480p', duration: 4 })).json();
    await h.storage.run("INSERT INTO ts_requests(id,account_ref,key_id,kind,model,bucket,status,hold,created_at) VALUES('dead-1',?,?,'chat','chat-1','llm_tokens','held',500,?)", a.accountRef, 'k', new Date(Date.now() - 3600_000).toISOString());
    await h.storage.run("UPDATE ts_wallets SET balance=balance-500,held=held+500 WHERE account_ref=? AND bucket='llm_tokens'", a.accountRef);
    await h.storage.run('UPDATE ts_requests SET created_at=? WHERE id=?', new Date(Date.now() - 120_000).toISOString(), job.id);
    await new Promise((r) => setTimeout(r, 350));
    expect(await h.server.sweep()).toEqual({ videos: 1, released: 1 });
    expect(await a.wallet()).toMatchObject({ balances: { video_tokens: 96, llm_tokens: 100_000 }, held: { video_tokens: 0, llm_tokens: 0 } });
  });
});
