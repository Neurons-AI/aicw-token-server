/** Any OpenAI-compatible upstream: chat, responses, images, audio, embeddings, and the `/videos` job API. */
import { UpstreamError, upstreamKey, type Adapter, type AdapterDeps, type VideoState } from './types.ts';

export function openaiAdapter(deps: AdapterDeps): Adapter {
  const base = String(deps.config.baseUrl || '').replace(/\/+$/, '');
  const call = (path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal }) =>
    deps.fetch(base + path, {
      method: init.method,
      headers: { ...(deps.config.headers ?? {}), ...(init.headers ?? {}), authorization: `Bearer ${upstreamKey(deps)}` },
      body: init.body ?? undefined,
      signal: init.signal,
    });
  const json = async (res: Response) => {
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok || !data) throw new UpstreamError(String(data?.error?.message || `upstream answered ${res.status}`), res.status === 400 ? 400 : 502);
    return data;
  };
  const state = (d: Record<string, any>): VideoState => {
    const s = String(d.status || '');
    if (s === 'completed') return { status: 'completed', progress: 100 };
    if (s === 'failed' || s === 'cancelled') return { status: 'failed', error: String(d.error?.message || s) };
    return { status: s === 'queued' ? 'queued' : 'in_progress', progress: Number(d.progress) || undefined };
  };
  const images = deps.config.images === 'chat' ? chatImages(call) : null;
  return {
    forward: (path, init) => (images && (path === '/images/generations' || path === '/images/edits') ? images(path, init) : call(path, init)),
    video: {
      async create(input) {
        const form = new FormData();
        form.set('model', input.model);
        form.set('prompt', input.prompt);
        form.set('seconds', String(input.seconds));
        form.set('size', { '480p': '854x480', '720p': '1280x720', '1080p': '1920x1080' }[input.resolution] || '1280x720');
        if (input.images[0]) {
          const img = await deps.fetch(input.images[0]);
          form.set('input_reference', await img.blob(), 'reference');
        }
        return { id: String((await json(await call('/videos', { method: 'POST', body: form }))).id) };
      },
      status: async (id) => state(await json(await call(`/videos/${encodeURIComponent(id)}`, { method: 'GET' }))),
      content: (id) => call(`/videos/${encodeURIComponent(id)}/content`, { method: 'GET' }),
    },
  };
}

type Call = (path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal }) => Promise<Response>;
const ASPECTS: Record<string, string> = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3', '1792x1024': '16:9', '1024x1792': '9:16' };
function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/**
 * `images: "chat"`: an image model reached through chat completions (OpenRouter, Gemini image
 * models). `/images/generations` and `/images/edits` become one chat call per image with
 * `modalities: ["image","text"]`; the answer is the usual `{ data: [{ b64_json }] }`, with the
 * summed `usage.cost` for the price floor. Quality maps to size: high = 2K, anything else 1K.
 */
function chatImages(call: Call) {
  return async (path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal }): Promise<Response> => {
    let fields: Record<string, any> = {};
    const refs: string[] = [];
    if (path === '/images/edits' && init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else if (k === 'image' || k === 'image[]' || k === 'mask') {
          if (k === 'mask') continue;
          const file = v as unknown as Blob;
          refs.push(`data:${file.type || 'image/png'};base64,${base64(new Uint8Array(await file.arrayBuffer()))}`);
        }
      }
    } else fields = JSON.parse(String(init.body ?? '{}'));
    const { prompt, size, quality, n, model, response_format: _rf, output_format: _of, background: _bg, moderation: _md, ...extra } = fields;
    const aspect = ASPECTS[String(size || '')];
    const count = Math.max(1, Math.min(4, Math.trunc(Number(n)) || 1));
    const data: Array<{ b64_json: string }> = [];
    let cost = 0;
    for (let i = 0; i < count; i++) {
      const content = refs.length ? [{ type: 'text', text: String(prompt ?? '') }, ...refs.map((url) => ({ type: 'image_url', image_url: { url } }))] : String(prompt ?? '');
      const res = await call('/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: init.signal,
        body: JSON.stringify({ ...extra, model, modalities: ['image', 'text'], messages: [{ role: 'user', content }], image_config: { image_size: quality === 'high' ? '2K' : '1K', ...(aspect ? { aspect_ratio: aspect } : {}) } }),
      });
      if (!res.ok) return res;
      const out = (await res.json().catch(() => null)) as Record<string, any> | null;
      cost += Number(out?.usage?.cost) || 0;
      for (const img of out?.choices?.[0]?.message?.images ?? []) {
        const url = String(img?.image_url?.url ?? '');
        if (url.startsWith('data:')) data.push({ b64_json: url.slice(url.indexOf(',') + 1) });
      }
    }
    return Response.json({ created: Math.floor(Date.now() / 1000), data, usage: cost ? { cost } : undefined });
  };
}
