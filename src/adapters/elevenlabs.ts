/**
 * ElevenLabs text-to-speech (not OpenAI-compatible): `POST /v1/audio/speech` → their
 * `POST /v1/text-to-speech/{voice_id}`. The app sends `voice` (an ElevenLabs voice id) or the
 * adapter's `voice` is used; `model` is the token server's model, sent as `model_id` (its
 * `upstreamModel`, e.g. "eleven_multilingual_v2").
 *
 *   "adapters": { "eleven": { "kind": "elevenlabs", "apiKeyEnv": "ELEVENLABS_API_KEY", "voice": "<default voice id>" } }
 *   "models": [{ "id": "story-voice", "type": "tts", "bucket": "voice_tokens", "adapter": "eleven",
 *                "upstreamModel": "eleven_multilingual_v2", "price": { "per1kChars": 1 } }]
 */
import { UpstreamError, upstreamKey, type Adapter, type AdapterDeps } from './types.ts';

const FORMATS: Record<string, string> = { mp3: 'mp3_44100_128', wav: 'pcm_44100', opus: 'opus_48000_64', pcm: 'pcm_44100' };

export function elevenlabsAdapter(deps: AdapterDeps): Adapter {
  const base = String(deps.config.baseUrl || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  return {
    async forward(path, init) {
      if (path !== '/audio/speech') throw new UpstreamError(`the elevenlabs adapter only makes speech (${path} is not supported)`, 404, 'not_supported');
      const body = JSON.parse(String(init.body ?? '{}')) as { model?: string; input?: string; voice?: string; response_format?: string; speed?: number };
      const voice = String(body.voice || deps.config.voice || '').trim();
      if (!/^[A-Za-z0-9]{8,64}$/.test(voice)) throw new UpstreamError('send "voice" (an ElevenLabs voice id), or set "voice" on the adapter', 400, 'voice_required');
      const format = FORMATS[String(body.response_format || 'mp3')] ?? FORMATS.mp3;
      const res = await deps.fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`, {
        method: 'POST',
        headers: { ...(deps.config.headers ?? {}), 'xi-api-key': upstreamKey(deps), 'content-type': 'application/json', accept: 'audio/*' },
        body: JSON.stringify({ text: String(body.input ?? ''), model_id: body.model, ...(body.speed ? { voice_settings: { speed: body.speed } } : {}) }),
        signal: init.signal,
      });
      if (res.ok) return new Response(res.body, { status: 200, headers: { 'content-type': res.headers.get('content-type') || 'audio/mpeg' } });
      // Their errors are { detail: { status, message } }: hand back the OpenAI shape the server reads.
      const data = (await res.json().catch(() => null)) as { detail?: { message?: string; status?: string } | string } | null;
      const message = typeof data?.detail === 'string' ? data.detail : data?.detail?.message || `ElevenLabs answered ${res.status}`;
      return Response.json({ error: { message, code: typeof data?.detail === 'object' ? data?.detail?.status : undefined } }, { status: res.status === 422 ? 400 : res.status });
    },
  };
}
