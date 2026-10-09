/**
 * Canned, deterministic answers in the real wire shapes. Used for tests, for a developer's
 * first run, and for every "test" account the conformance check creates, so a check never
 * spends real upstream money.
 *
 * Triggers inside a prompt: `[[fail]]` makes the upstream fail (5xx), `[[refuse]]` makes it
 * refuse the content (400).
 */
import type { Adapter, VideoState } from './types.ts';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const refusal = () => json({ error: { message: 'the request was refused by the content policy', type: 'invalid_request_error', code: 'content_policy_violation' } }, 400);
const failure = () => json({ error: { message: 'mock upstream failure', type: 'server_error', code: 'server_error' } }, 500);
const textOf = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join(' ') : v && typeof v === 'object' ? textOf((v as any).text ?? (v as any).content ?? (v as any).input ?? '') : '');
const tok = (s: string) => Math.max(1, Math.ceil(s.length / 4));

export function mockAdapter(): Adapter {
  return {
    async forward(path, init) {
      const isForm = init.body instanceof FormData;
      const body = (isForm ? Object.fromEntries((init.body as FormData).entries()) : typeof init.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, any>;
      const prompt = textOf(body.messages ?? body.input ?? body.prompt ?? '');
      if (prompt.includes('[[fail]]')) return failure();
      if (prompt.includes('[[refuse]]')) return refusal();
      if (path === '/chat/completions') {
        const reply = `mock: ${prompt.slice(-200)}`;
        const usage = { prompt_tokens: tok(prompt), completion_tokens: tok(reply), total_tokens: tok(prompt) + tok(reply), prompt_tokens_details: { cached_tokens: 0 } };
        if (!body.stream) return json({ id: 'chatcmpl-mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage });
        const chunk = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
        const parts = [
          chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: reply.slice(0, 6) }, finish_reason: null }] }),
          chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: reply.slice(6) }, finish_reason: 'stop' }] }),
          chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage }),
          'data: [DONE]\n\n',
        ];
        return new Response(parts.join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/responses') {
        const reply = `mock: ${prompt.slice(-200)}`;
        const usage = { input_tokens: tok(prompt), output_tokens: tok(reply), total_tokens: tok(prompt) + tok(reply) };
        return json({ id: 'resp-mock', object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }], usage });
      }
      if (path === '/images/generations' || path === '/images/edits') {
        const n = Math.max(1, Math.min(4, Number(body.n) || 1));
        return json({ created: 0, data: Array.from({ length: n }, () => ({ b64_json: PNG_1X1 })), usage: { total_tokens: 0 } });
      }
      if (path === '/audio/speech') return new Response(new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]), { headers: { 'content-type': 'audio/wav' } });
      if (path === '/audio/transcriptions') return json({ text: 'mock transcription' });
      if (path === '/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return json({ object: 'list', model: body.model, data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })), usage: { prompt_tokens: tok(textOf(body.input)), total_tokens: tok(textOf(body.input)) } });
      }
      return json({ ok: true, echo: body });
    },
    video: {
      // Stateless on purpose (a Worker may answer each poll from a different isolate): the job id
      // carries when it started and how it ends.
      async create(input) {
        if (input.prompt.includes('[[refuse]]')) throw Object.assign(new Error('the request was refused by the content policy'), { status: 400, code: 'content_policy_violation' });
        return { id: `mockvid_${input.prompt.includes('[[fail]]') ? 'fail' : 'ok'}_${Date.now()}` };
      },
      async status(id): Promise<VideoState> {
        const [, outcome, started] = id.split('_');
        if (Date.now() - Number(started) < 300) return { status: 'in_progress', progress: 50 };
        return outcome === 'fail' ? { status: 'failed', error: 'mock video failure' } : { status: 'completed', progress: 100, ref: 'mock' };
      },
      async content() {
        // A tiny, valid MP4 "ftyp" box is enough for a client to save and recognise the file.
        return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50]), { headers: { 'content-type': 'video/mp4' } });
      },
    },
  };
}
