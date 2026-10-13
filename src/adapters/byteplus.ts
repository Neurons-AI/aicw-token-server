/**
 * BytePlus ModelArk video generation (Seedance), turned into the common video job shape.
 *   create : POST {base}/contents/generations/tasks
 *   status : GET  {base}/contents/generations/tasks/{id}
 * The finished file is a signed URL on BytePlus; the server streams it to the caller and
 * never hands that URL out.
 */
import { UpstreamError, upstreamKey, type Adapter, type AdapterDeps, type VideoState } from './types.ts';

export function byteplusAdapter(deps: AdapterDeps): Adapter {
  const base = String(deps.config.baseUrl || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/+$/, '');
  const call = async (path: string, init: { method: string; body?: string }) => {
    const res = await deps.fetch(base + path, {
      method: init.method,
      headers: { ...(deps.config.headers ?? {}), 'content-type': 'application/json', authorization: `Bearer ${upstreamKey(deps)}` },
      body: init.body,
    });
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok || !data) throw new UpstreamError(String(data?.error?.message || `BytePlus answered ${res.status}`), res.status === 400 ? 400 : 502);
    return data;
  };
  return {
    forward: async () => {
      throw new UpstreamError('the byteplus adapter only serves video models', 400, 'unsupported');
    },
    video: {
      async create(input) {
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
        const videos = input.videos ?? [];
        // With a source video (edit / extend) every picture is a reference, not the first frame.
        for (const [i, url] of input.images.entries()) content.push({ type: 'image_url', image_url: { url }, role: i === 0 && !videos.length ? 'first_frame' : 'reference_image' });
        for (const url of videos) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
        for (const url of input.audios ?? []) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
        const data = await call('/contents/generations/tasks', {
          method: 'POST',
          body: JSON.stringify({
            model: input.model,
            content,
            resolution: input.resolution,
            // An edit keeps the source length (-1) and ratio; an extension keeps the ratio.
            duration: input.task === 'edit' ? -1 : input.seconds,
            ...(videos.length && (input.task === 'edit' || input.task === 'extend') ? { ratio: 'adaptive' } : input.ratio ? { ratio: input.ratio } : {}),
            ...(videos.length && input.task ? { omni_reference_task_type: input.task } : {}),
            watermark: false,
          }),
        });
        return { id: String(data.id) };
      },
      async status(id): Promise<VideoState> {
        const d = await call(`/contents/generations/tasks/${encodeURIComponent(id)}`, { method: 'GET' });
        const s = String(d.status || '');
        const usageTokens = Number(d.usage?.total_tokens ?? d.usage?.completion_tokens) || undefined;
        if (s === 'succeeded') return { status: 'completed', progress: 100, ref: String(d.content?.video_url || ''), ...(usageTokens ? { usageTokens } : {}) };
        if (s === 'failed' || s === 'cancelled' || s === 'expired') return { status: 'failed', error: String(d.error?.message || s) };
        return { status: s === 'queued' ? 'queued' : 'in_progress' };
      },
      async content(_id, ref) {
        if (!ref) throw new UpstreamError('the video file is no longer available', 404, 'not_found');
        return deps.fetch(ref);
      },
    },
  };
}
