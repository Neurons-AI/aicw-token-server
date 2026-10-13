/** Direct routes: Claude through the Messages API, Gemini (chat thinking, long-context tier, Nano Banana images). */
import { afterEach, describe, expect, it } from 'vitest';
import { fromAnthropic, toAnthropic } from '../src/adapters/anthropic.ts';
import { chargeForChat, readChatUsage } from '../src/pricing.ts';
import { harness, upstream } from './helpers.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Claude Messages API translation', () => {
  it('turns an agent conversation into a cached Messages request', () => {
    const req = toAnthropic({
      model: 'claude-opus-5-5',
      max_completion_tokens: 2000,
      stream: true,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'You are an agent.' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
        { role: 'user', content: 'and now?' },
      ],
    });
    expect(req).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 2000, stream: true, tool_choice: { type: 'auto' } });
    expect(req.system).toEqual([{ type: 'text', text: 'You are an agent.', cache_control: { type: 'ephemeral' } }]);
    expect(req.tools).toEqual([{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
    expect(req.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(req.messages[1].content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' }, cache_control: { type: 'ephemeral' } }]);
    // The tool result and the next user words are one user turn; its last block is cached.
    expect(req.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'hello' }] }, { type: 'text', text: 'and now?', cache_control: { type: 'ephemeral' } }]);
  });
  it('turns the answer back, cache reads and writes included in the usage', () => {
    const out = fromAnthropic({ id: 'msg_1', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'b' } }], usage: { input_tokens: 10, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, output_tokens: 40 } }, 'claude-opus-5.5');
    expect(out.choices[0]).toEqual({ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } }] } });
    expect(readChatUsage(out.usage)).toMatchObject({ input: 3510, output: 40, cacheRead: 3000, cacheWrite: 500 });
  });
  it('streams text and tool calls as chat chunks and charges what the stream reported', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '39' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"c"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ];
    const up = await upstream((req, body) => {
      expect(req.url).toBe('/v1/messages');
      expect(req.headers['x-api-key']).toBe('ant-secret');
      expect(JSON.parse(body.toString()).model).toBe('claude-opus-5-5');
      return { headers: { 'content-type': 'text/event-stream' }, body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`) };
    });
    closers.push(up.close);
    const h = await harness(
      {
        buckets: { claude_tokens: { label: 'Claude' } },
        adapters: { claude: { kind: 'anthropic', baseUrl: up.url, apiKeyEnv: 'ANT' } },
        models: [{ id: 'claude-opus-5.5', type: 'chat', bucket: 'claude_tokens', adapter: 'claude', upstreamModel: 'claude-opus-5-5', price: { input: 0.19, cacheRead: 0.0095, cacheWrite: 0.24, output: 0.95 } }],
      },
      { ANT: 'ant-secret' }
    );
    const a = await h.account({ claude_tokens: 10_000 });
    const res = await h.api(a.key, '/chat/completions', { model: 'claude-opus-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const chunks = (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('391');
    const args = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(args[0]).toMatchObject({ index: 0, id: 'toolu_2', function: { name: 'read' } });
    expect(args.map((t: any) => t.function.arguments).join('')).toBe('{"path":"c"}');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 1020, completion_tokens: 30, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 } });
    // 20 × 0.19 + 1000 × 0.0095 + 30 × 0.95 = 3.8 + 9.5 + 28.5 = 41.8 → 42.
    expect((await a.wallet()).balances.claude_tokens).toBe(10_000 - 42);
  });
});

describe('Gemini direct', () => {
  it('bills the thinking its OpenAI endpoint leaves out of completion_tokens', () => {
    const u = readChatUsage({ prompt_tokens: 19, completion_tokens: 3, total_tokens: 302 })!;
    expect(u.output).toBe(283);
  });
  it('bills a whole call at the long-context tier above 200k prompt tokens', () => {
    const m = { id: 'g', type: 'chat' as const, bucket: 'b', adapter: 'a', price: { input: 0.1, cacheRead: 0.01, output: 0.6, longContext: { above: 200_000, input: 0.2, cacheRead: 0.02, output: 0.9 } } };
    expect(chargeForChat(m, { input: 100_000, output: 1000, cacheRead: 0, total: 101_000 })).toBe(10_600);
    expect(chargeForChat(m, { input: 300_000, output: 1000, cacheRead: 0, total: 301_000 })).toBe(60_900);
  });
  it('makes and edits Nano Banana images with generateContent', async () => {
    const up = await upstream((req, body) => {
      expect(req.url).toBe('/v1beta/models/gemini-3.1-flash-image:generateContent');
      expect(req.headers['x-goog-api-key']).toBe('g-secret');
      const sent = JSON.parse(body.toString());
      expect(sent.generationConfig.responseModalities).toEqual(['IMAGE']);
      return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1120 } }) };
    });
    closers.push(up.close);
    const h = await harness(
      {
        buckets: { image_tokens: { label: 'images' } },
        adapters: { gemini: { kind: 'gemini', baseUrl: up.url + '/v1beta', apiKeyEnv: 'G' } },
        models: [{ id: 'gemini-3.1-flash-image', type: 'image', bucket: 'image_tokens', adapter: 'gemini', price: { quality: { low: 3100, medium: 3100, auto: 3100, high: 4700 }, edit: 100 } }],
      },
      { G: 'g-secret' }
    );
    const a = await h.account({ image_tokens: 20_000 });
    const made = await h.api(a.key, '/images/generations', { model: 'gemini-3.1-flash-image', prompt: 'a cup', size: '1024x1536', quality: 'high' });
    expect(made.status).toBe(200);
    expect(((await made.json()) as any).data[0].b64_json).toBe(PNG);
    expect(JSON.parse(up.calls[0].body.toString()).generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '2:3' });
    const form = new FormData();
    form.set('model', 'gemini-3.1-flash-image');
    form.set('prompt', 'make it red');
    form.set('image', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'a.png');
    expect((await h.api(a.key, '/images/edits', form)).status).toBe(200);
    expect(JSON.parse(up.calls[1].body.toString()).contents[0].parts).toEqual([{ text: 'make it red' }, { inlineData: { mimeType: 'image/png', data: PNG } }]);
    expect((await a.wallet()).balances.image_tokens).toBe(20_000 - 4700 - 3200);
  });
});

describe('settling a stream', () => {
  it('settles at [DONE] even when the upstream never closes the stream', async () => {
    const { meterSse } = await import('../src/server.ts');
    const enc = new TextEncoder();
    // Sends the last chunk and [DONE], then stays open forever (a forwarded body can do that).
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"391"}}],"usage":{"prompt_tokens":18,"completion_tokens":3,"total_tokens":201}}\n\ndata: [DONE]\n\n'));
      },
    });
    let seen: any = null;
    const out = meterSse(upstreamBody, async (s) => {
      seen = s;
    });
    const reader = out.getReader();
    let text = '';
    while (!text.includes('[DONE]')) text += new TextDecoder().decode((await reader.read()).value);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toMatchObject({ aborted: false, usage: { total_tokens: 201 } });
  });
});

describe('a stream split mid-line', () => {
  it('passes it on whole and settles (no stall when a chunk holds no complete line)', async () => {
    const { meterSse } = await import('../src/server.ts');
    const enc = new TextEncoder();
    const parts = ['da', 'ta: {"choices":[{"delta":{"content":"3', '91"}}]}', '\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n', '\ndata: [DO', 'NE]\n\n'];
    const body = new ReadableStream<Uint8Array>({ pull(c) { const p = parts.shift(); if (p === undefined) c.close(); else c.enqueue(enc.encode(p)); } });
    let seen: any = null;
    const text = await new Response(meterSse(body, async (s) => { seen = s; })).text();
    expect(text).toContain('"content":"391"');
    expect(text).toContain('data: [DONE]');
    expect(seen).toMatchObject({ aborted: false, usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
});
