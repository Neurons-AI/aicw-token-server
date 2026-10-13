/**
 * Google Gemini, direct. Chat goes to Google's OpenAI-compatible endpoint (`{base}/openai`);
 * images (Nano Banana: gemini-*-image) go to the native `models/{model}:generateContent` with
 * `responseModalities: ["IMAGE"]`, answered in the usual `{ data: [{ b64_json }] }` shape.
 * Quality maps to size: high = 2K, anything else 1K. Size maps to an aspect ratio.
 *
 *   "adapters": { "gemini": { "kind": "gemini", "apiKeyEnv": "GEMINI_API_KEY" } }
 *
 * Note: the OpenAI-compatible endpoint leaves thinking out of `completion_tokens` (it is only in
 * `total_tokens`); readChatUsage bills the difference as output.
 */
import { UpstreamError, upstreamKey, type Adapter, type AdapterDeps } from './types.ts';

const ASPECTS: Record<string, string> = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3', '1792x1024': '16:9', '1024x1792': '9:16' };
function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function geminiAdapter(deps: AdapterDeps): Adapter {
  const base = String(deps.config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const images = async (path: string, init: { body?: BodyInit | null; signal?: AbortSignal }): Promise<Response> => {
    let fields: Record<string, any> = {};
    const parts: Array<Record<string, unknown>> = [];
    if (path === '/images/edits' && init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else if (k === 'image' || k === 'image[]') {
          const file = v as unknown as Blob;
          parts.push({ inlineData: { mimeType: file.type || 'image/png', data: base64(new Uint8Array(await file.arrayBuffer())) } });
        }
      }
    } else fields = JSON.parse(String(init.body ?? '{}'));
    const count = Math.max(1, Math.min(4, Math.trunc(Number(fields.n)) || 1));
    const aspect = ASPECTS[String(fields.size || '')];
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: String(fields.prompt ?? '') }, ...parts] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: fields.quality === 'high' ? '2K' : '1K', ...(aspect ? { aspectRatio: aspect } : {}) } },
    });
    const data: Array<{ b64_json: string }> = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    for (let i = 0; i < count; i++) {
      const res = await deps.fetch(`${base}/models/${encodeURIComponent(String(fields.model))}:generateContent`, {
        method: 'POST',
        headers: { ...(deps.config.headers ?? {}), 'x-goog-api-key': upstreamKey(deps), 'content-type': 'application/json' },
        body,
        signal: init.signal,
      });
      const out = (await res.json().catch(() => null)) as Record<string, any> | null;
      if (!res.ok) {
        const message = String(out?.error?.message || `Gemini answered ${res.status}`);
        return Response.json({ error: { message, code: out?.error?.status } }, { status: res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status });
      }
      for (const part of out?.candidates?.[0]?.content?.parts ?? []) if (part?.inlineData?.data) data.push({ b64_json: String(part.inlineData.data) });
      usage.prompt_tokens += Number(out?.usageMetadata?.promptTokenCount) || 0;
      usage.completion_tokens += (Number(out?.usageMetadata?.candidatesTokenCount) || 0) + (Number(out?.usageMetadata?.thoughtsTokenCount) || 0);
    }
    return Response.json({ created: Math.floor(Date.now() / 1000), data, usage });
  };
  return {
    forward(path, init) {
      if (path === '/images/generations' || path === '/images/edits') return images(path, init);
      if (path !== '/chat/completions' && path !== '/embeddings') throw new UpstreamError(`the gemini adapter does not serve ${path}`, 404, 'not_supported');
      return deps.fetch(`${base}/openai${path}`, {
        method: init.method,
        headers: { ...(deps.config.headers ?? {}), ...(init.headers ?? {}), authorization: `Bearer ${upstreamKey(deps)}` },
        body: init.body ?? undefined,
        signal: init.signal,
      });
    },
  };
}
