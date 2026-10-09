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
  return {
    forward: call,
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
