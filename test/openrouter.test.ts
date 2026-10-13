/** Models reached through OpenRouter: routing fields, the cost floor, Anthropic cache marks, images through chat. */
import { afterEach, describe, expect, it } from 'vitest';
import { chargeForChat, readChatUsage } from '../src/pricing.ts';
import { markAnthropicCache } from '../src/server.ts';
import { harness, upstream } from './helpers.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('cost floor', () => {
  const model = { id: 'm', type: 'chat' as const, bucket: 'b', adapter: 'a', price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, perUsd: 50_000 } };
  it('charges by tokens, cache writes at their own price, and never below the reported cost', () => {
    const usage = readChatUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 }, cost: 0.0001 })!;
    expect(usage).toMatchObject({ input: 1000, output: 100, cacheRead: 600, cacheWrite: 200, cost: 0.0001 });
    // 200 fresh × 0.1 + 600 × 0.01 + 200 × 0.125 + 100 × 0.5 = 20 + 6 + 25 + 50 = 101; the cost floor is 5.
    expect(chargeForChat(model, usage)).toBe(101);
    // A pricier route than the token prices assume: the reported cost wins.
    expect(chargeForChat(model, readChatUsage({ prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 })!)).toBe(500);
  });
});

describe('anthropic cache marks', () => {
  it('marks the system prompt and the last two non-tool messages, and drops the caller marks', () => {
    const out = markAnthropicCache([
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: [{ type: 'text', text: 'old', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'run it' },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ]);
    const marked = out.map((m) => (Array.isArray(m.content) ? m.content.some((p: any) => p.cache_control) : false));
    expect(marked).toEqual([true, false, true, true, false]);
    expect(out[0].content).toEqual([{ type: 'text', text: 'You are an agent.', cache_control: { type: 'ephemeral' } }]);
  });
});

describe('through OpenRouter', () => {
  it('sends the model routing fields and charges at least the reported cost', async () => {
    const up = await upstream(() => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '391' } }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.002 } }) }));
    closers.push(up.close);
    const h = await harness(
      {
        buckets: { kimi_tokens: { label: 'Kimi' } },
        adapters: { or: { kind: 'openai', baseUrl: up.url, apiKeyEnv: 'OR_KEY' } },
        models: [{ id: 'kimi-k3', type: 'chat', bucket: 'kimi_tokens', adapter: 'or', upstreamModel: 'moonshotai/kimi-k3', upstreamBody: { provider: { sort: 'price', max_price: { prompt: 3, completion: 15 } } }, price: { input: 0.15, output: 0.74, cacheRead: 0.015, perUsd: 49_068 } }],
      },
      { OR_KEY: 'or-secret' }
    );
    const a = await h.account({ kimi_tokens: 10_000 });
    const res = await h.api(a.key, '/chat/completions', { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], provider: { sort: 'throughput' } });
    expect(res.status).toBe(200);
    // The buyer never sees what the call cost Neurons, nor which host served it.
    const answer = (await res.json()) as any;
    expect(answer.usage).toEqual({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 });
    expect(answer.provider).toBeUndefined();
    const sent = JSON.parse(up.calls[0].body.toString());
    expect(sent.model).toBe('moonshotai/kimi-k3');
    expect(sent.provider).toEqual({ sort: 'price', max_price: { prompt: 3, completion: 15 } });
    // Tokens: 100 × 0.15 + 40 × 0.74 = 44.6 → 45; reported cost $0.002 × 49,068 = 98.1 → 99.
    expect((await a.wallet()).balances.kimi_tokens).toBe(10_000 - 99);
  });

  it('makes and edits images through chat completions', async () => {
    const up = await upstream(() => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] } }], usage: { prompt_tokens: 10, completion_tokens: 1120, cost: 0.0672 } }) }));
    closers.push(up.close);
    const h = await harness(
      {
        buckets: { gemini_image_tokens: { label: 'Gemini images' } },
        adapters: { orimg: { kind: 'openai', baseUrl: up.url, apiKeyEnv: 'OR_KEY', images: 'chat' } },
        models: [{ id: 'gemini-3.1-flash-image', type: 'image', bucket: 'gemini_image_tokens', adapter: 'orimg', upstreamModel: 'google/gemini-3.1-flash-image', price: { quality: { low: 3300, medium: 3300, auto: 3300, high: 5000 }, edit: 100, perUsd: 49_068 } }],
      },
      { OR_KEY: 'or-secret' }
    );
    const a = await h.account({ gemini_image_tokens: 20_000 });
    const made = await h.api(a.key, '/images/generations', { model: 'gemini-3.1-flash-image', prompt: 'a cup', size: '1536x1024' });
    expect(made.status).toBe(200);
    const madeJson = (await made.json()) as any;
    expect(madeJson.data[0].b64_json).toBe(PNG);
    expect(madeJson.usage?.cost).toBeUndefined();
    const sent = JSON.parse(up.calls[0].body.toString());
    expect(up.calls[0].url).toBe('/chat/completions');
    expect(sent).toMatchObject({ model: 'google/gemini-3.1-flash-image', modalities: ['image', 'text'], messages: [{ role: 'user', content: 'a cup' }], image_config: { image_size: '1K', aspect_ratio: '3:2' } });
    // 3,300 by the table; the reported $0.0672 × 49,068 = 3,297.4 → 3,298 stays under it.
    expect((await a.wallet()).balances.gemini_image_tokens).toBe(20_000 - 3300);

    const form = new FormData();
    form.set('model', 'gemini-3.1-flash-image');
    form.set('prompt', 'make it red');
    form.set('quality', 'high');
    form.set('image', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'a.png');
    const edited = await h.api(a.key, '/images/edits', form);
    expect(edited.status).toBe(200);
    const sent2 = JSON.parse(up.calls[1].body.toString());
    expect(sent2.image_config).toEqual({ image_size: '2K' });
    expect(sent2.messages[0].content).toEqual([{ type: 'text', text: 'make it red' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]);
    expect((await a.wallet()).balances.gemini_image_tokens).toBe(20_000 - 3300 - 5100);
  });
});

describe('the floor survives a Store price', () => {
  it('keeps perUsd and cacheWrite through the live catalog and a Store-set price', async () => {
    const { fullPrice, mergePrice } = await import('../src/prices.ts');
    const m = { id: 'c', type: 'chat' as const, bucket: 'b', adapter: 'a', price: { input: 0.1, output: 0.5, cacheWrite: 0.125, perUsd: 49_068 } };
    expect(fullPrice(m)).toMatchObject({ cacheWrite: 0.125, perUsd: 49_068 });
    expect(mergePrice(m, { input: 0.2 })).toMatchObject({ input: 0.2, perUsd: 49_068 });
    const img = { id: 'i', type: 'image' as const, bucket: 'b', adapter: 'a', price: { quality: { low: 1, medium: 1, high: 2, auto: 1 }, perUsd: 49_068 } };
    expect(mergePrice(img, { quality: { high: 3 } })).toMatchObject({ quality: { high: 3 }, perUsd: 49_068 });
  });
});

describe('streaming through OpenRouter', () => {
  it('meters the cost but strips it from what the buyer receives', async () => {
    const chunks = [
      { id: 'c1', provider: 'InferenceNet', choices: [{ delta: { content: '39' } }] },
      { id: 'c1', provider: 'InferenceNet', choices: [{ delta: { content: '1' } }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.002, is_byok: false, cost_details: { upstream_inference_cost: 0.002 } } },
    ];
    const up = await upstream(() => ({ headers: { 'content-type': 'text/event-stream' }, body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).concat(['data: [DONE]\n\n']) }));
    closers.push(up.close);
    const h = await harness(
      {
        buckets: { kimi_tokens: { label: 'Kimi' } },
        adapters: { or: { kind: 'openai', baseUrl: up.url, apiKeyEnv: 'OR_KEY' } },
        models: [{ id: 'kimi-k3', type: 'chat', bucket: 'kimi_tokens', adapter: 'or', price: { input: 0.15, output: 0.74, perUsd: 49_068 } }],
      },
      { OR_KEY: 'or-secret' }
    );
    const a = await h.account({ kimi_tokens: 10_000 });
    const res = await h.api(a.key, '/chat/completions', { model: 'kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const text = await res.text();
    expect(text).toContain('"content":"39"');
    expect(text).not.toMatch(/cost|InferenceNet|is_byok/);
    expect(text).toContain('[DONE]');
    expect((await a.wallet()).balances.kimi_tokens).toBe(10_000 - 99);
  });
});
