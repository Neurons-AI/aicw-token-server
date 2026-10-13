/**
 * Anthropic, direct: OpenAI Chat Completions in, Claude Messages API out, and back.
 * Anthropic's own OpenAI-compatible endpoint has no prompt caching, so an agent would pay full
 * input price on every turn; this adapter speaks the Messages API and marks the prompt for
 * caching (system + the last two messages, Anthropic allows four breakpoints).
 *
 *   "adapters": { "claude": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" } }
 *
 * Translated: system/developer messages, text and image parts (data: URLs and https URLs), tools,
 * tool_choice, assistant tool calls, tool results, stop, temperature/top_p, max tokens, streaming
 * (text, tool call arguments, thinking as `reasoning_content`) and usage (cache reads and writes in
 * `prompt_tokens_details`).
 */
import { UpstreamError, upstreamKey, type Adapter, type AdapterDeps } from './types.ts';

type Json = Record<string, any>;
const VERSION = '2023-06-01';
const DEFAULT_MAX = 8192;
const EPHEMERAL = { type: 'ephemeral' };

function imageBlock(url: string): Json | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}
function blocksOf(content: unknown): Json[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const part of content as Json[]) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'text' || part.type === 'input_text') && part.text) out.push({ type: 'text', text: String(part.text) });
    else if (part.type === 'image_url') {
      const img = imageBlock(String(part.image_url?.url ?? part.image_url ?? ''));
      if (img) out.push(img);
    }
  }
  return out;
}
const textOf = (content: unknown) => blocksOf(content).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/** The Messages API request for an OpenAI Chat Completions body. */
export function toAnthropic(body: Json): Json {
  const system: Json[] = [];
  const messages: Json[] = [];
  const push = (role: 'user' | 'assistant', blocks: Json[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // Anthropic wants user/assistant turns to alternate: merge neighbours of the same role.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of (Array.isArray(body.messages) ? body.messages : []) as Json[]) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = textOf(m.content);
      if (text) system.push({ type: 'text', text });
    } else if (m.role === 'user') push('user', blocksOf(m.content));
    else if (m.role === 'assistant') {
      const blocks = blocksOf(m.content).filter((b) => b.type === 'text');
      for (const call of (Array.isArray(m.tool_calls) ? m.tool_calls : []) as Json[]) {
        let input: unknown = {};
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: String(call.id), name: String(call.function?.name ?? ''), input: input && typeof input === 'object' ? input : {} });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const parts = blocksOf(m.content);
      push('user', [{ type: 'tool_result', tool_use_id: String(m.tool_call_id), content: parts.length ? parts : [{ type: 'text', text: '(empty)' }] }]);
    }
  }
  // Prompt caching: the system prompt and the last two messages.
  if (system.length) system[system.length - 1].cache_control = EPHEMERAL;
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const blocks = messages[i].content as Json[];
    const last = blocks[blocks.length - 1];
    if (last && last.type !== 'thinking') {
      last.cache_control = EPHEMERAL;
      marked++;
    }
  }
  const out: Json = { model: body.model, max_tokens: Number(body.max_completion_tokens ?? body.max_tokens) || DEFAULT_MAX, messages };
  if (system.length) out.system = system;
  if (Array.isArray(body.tools) && body.tools.length)
    out.tools = (body.tools as Json[]).filter((t) => t?.type === 'function' && t.function?.name).map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
  const choice = body.tool_choice;
  if (out.tools && choice) {
    if (choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (choice === 'required') out.tool_choice = { type: 'any' };
    else if (choice === 'none') out.tool_choice = { type: 'none' };
    else if (choice?.function?.name) out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  if (typeof body.temperature === 'number') out.temperature = Math.min(1, Math.max(0, body.temperature));
  if (typeof body.top_p === 'number' && typeof body.temperature !== 'number') out.top_p = body.top_p;
  const stop = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop : null;
  if (stop?.length) out.stop_sequences = stop.slice(0, 4);
  if (body.stream === true) out.stream = true;
  return out;
}

const FINISH: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop' };
/** Anthropic usage → OpenAI usage (prompt_tokens counts the cached and cache-written tokens too). */
export function usageOf(u: Json | undefined): Json {
  const fresh = Number(u?.input_tokens) || 0;
  const read = Number(u?.cache_read_input_tokens) || 0;
  const write = Number(u?.cache_creation_input_tokens) || 0;
  const output = Number(u?.output_tokens) || 0;
  return { prompt_tokens: fresh + read + write, completion_tokens: output, total_tokens: fresh + read + write + output, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } };
}
/** A Messages API answer → a Chat Completions answer. */
export function fromAnthropic(data: Json, model: string): Json {
  let text = '';
  let reasoning = '';
  const calls: Json[] = [];
  for (const b of (data.content ?? []) as Json[]) {
    if (b.type === 'text') text += b.text ?? '';
    else if (b.type === 'thinking') reasoning += b.thinking ?? '';
    else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const message: Json = { role: 'assistant', content: text || (calls.length ? null : '') };
  if (calls.length) message.tool_calls = calls;
  if (reasoning) message.reasoning_content = reasoning;
  return { id: data.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: FINISH[data.stop_reason] ?? 'stop' }], usage: usageOf(data.usage) };
}

/** The Messages API event stream → Chat Completions chunks (`data: {...}` lines, then `[DONE]`). */
export function streamFromAnthropic(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let id = 'chatcmpl-claude';
  const created = Math.floor(Date.now() / 1000);
  const usage: Json = {};
  const tools = new Map<number, number>(); // Anthropic block index → OpenAI tool_calls index
  let finish = 'stop';
  let ended = false;
  const chunk = (delta: Json, finish_reason: string | null = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const handle = (event: Json): string => {
    switch (event.type) {
      case 'message_start':
        id = event.message?.id ?? id;
        Object.assign(usage, event.message?.usage ?? {});
        return chunk({ role: 'assistant', content: '' });
      case 'content_block_start': {
        const b = event.content_block ?? {};
        if (b.type === 'tool_use') {
          const index = tools.size;
          tools.set(event.index, index);
          return chunk({ tool_calls: [{ index, id: b.id, type: 'function', function: { name: b.name, arguments: '' } }] });
        }
        return '';
      }
      case 'content_block_delta': {
        const d = event.delta ?? {};
        if (d.type === 'text_delta') return chunk({ content: d.text ?? '' });
        if (d.type === 'thinking_delta') return chunk({ reasoning_content: d.thinking ?? '' });
        if (d.type === 'input_json_delta' && tools.has(event.index)) return chunk({ tool_calls: [{ index: tools.get(event.index), function: { arguments: d.partial_json ?? '' } }] });
        return '';
      }
      case 'message_delta':
        if (event.delta?.stop_reason) finish = FINISH[event.delta.stop_reason] ?? 'stop';
        Object.assign(usage, event.usage ?? {});
        return '';
      case 'message_stop':
        ended = true;
        return tail();
      case 'error':
        ended = true;
        return `data: ${JSON.stringify({ error: { message: event.error?.message ?? 'the model provider failed', type: event.error?.type } })}\n\ndata: [DONE]\n\n`;
      default:
        return '';
    }
  };
  const tail = () => chunk({}, finish) + `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(usage) })}\n\ndata: [DONE]\n\n`;
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(value, controller) {
        buffer += decoder.decode(value, { stream: true });
        let out = '';
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          try {
            out += handle(JSON.parse(line.slice(5).trim()));
          } catch {
            /* not JSON */
          }
        }
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const line = buffer.trim();
        let out = '';
        if (line.startsWith('data:')) {
          try {
            out += handle(JSON.parse(line.slice(5).trim()));
          } catch {
            /* not JSON */
          }
        }
        if (!ended) out += tail();
        if (out) controller.enqueue(encoder.encode(out));
      },
    })
  );
}

export function anthropicAdapter(deps: AdapterDeps): Adapter {
  const base = String(deps.config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    async forward(path, init) {
      if (path !== '/chat/completions') throw new UpstreamError(`the anthropic adapter serves chat only (${path} is not supported)`, 404, 'not_supported');
      const body = JSON.parse(String(init.body ?? '{}')) as Json;
      const res = await deps.fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { ...(deps.config.headers ?? {}), 'x-api-key': upstreamKey(deps), 'anthropic-version': VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(toAnthropic(body)),
        signal: init.signal,
      });
      if (!res.ok) {
        // Their errors are { type: "error", error: { type, message } }: hand back the OpenAI shape.
        const data = (await res.json().catch(() => null)) as Json | null;
        const status = res.status === 529 ? 503 : res.status;
        return Response.json({ error: { message: String(data?.error?.message || `Anthropic answered ${res.status}`), code: data?.error?.type } }, { status });
      }
      if (body.stream === true) return new Response(streamFromAnthropic(res.body!, String(body.model)), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      return Response.json(fromAnthropic((await res.json()) as Json, String(body.model)));
    },
  };
}
