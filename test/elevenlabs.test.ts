/** ElevenLabs speech through the token server: their API shape, the key header, errors, charging. */
import { afterEach, describe, expect, it } from 'vitest';
import { harness, upstream } from './helpers.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
async function withEleven(handler: Parameters<typeof upstream>[0], voice?: string) {
  const up = await upstream(handler);
  closers.push(up.close);
  const h = await harness(
    {
      buckets: { voice_tokens: { label: 'voice tokens', estimate: { tts: { chars: 2000 } } } },
      adapters: { eleven: { kind: 'elevenlabs', baseUrl: up.url, apiKeyEnv: 'ELEVENLABS_API_KEY', ...(voice ? { voice } : {}) } },
      models: [{ id: 'story-voice', type: 'tts', bucket: 'voice_tokens', adapter: 'eleven', upstreamModel: 'eleven_multilingual_v2', price: { per1kChars: 1 } }],
    },
    { ELEVENLABS_API_KEY: 'xi-secret' }
  );
  return { up, h };
}

describe('elevenlabs adapter', () => {
  it('turns /v1/audio/speech into their text-to-speech call and charges per 1000 characters', async () => {
    const { up, h } = await withEleven(() => ({ headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from([9, 9, 9]) }), 'DefaultVoice123');
    const a = await h.account({ voice_tokens: 10 });
    const res = await h.api(a.key, '/audio/speech', { model: 'story-voice', input: 'x'.repeat(1500), voice: 'Rachel21m00Tcm4' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect((await res.arrayBuffer()).byteLength).toBe(3);
    expect(up.calls[0].url).toBe('/v1/text-to-speech/Rachel21m00Tcm4?output_format=mp3_44100_128');
    expect(up.calls[0].headers['xi-api-key']).toBe('xi-secret');
    expect(up.calls[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(up.calls[0].body.toString())).toEqual({ text: 'x'.repeat(1500), model_id: 'eleven_multilingual_v2' });
    expect((await a.wallet()).balances.voice_tokens).toBe(8);
    // No voice in the request: the adapter's default.
    await h.api(a.key, '/audio/speech', { model: 'story-voice', input: 'hi' });
    expect(up.calls[1].url).toBe('/v1/text-to-speech/DefaultVoice123?output_format=mp3_44100_128');
    // The estimate a buyer sees: 2000 characters = 2 tokens.
    expect((await (await h.f('http://tokens.test/.well-known/aicw-token-server')).json()).buckets[0].estimate).toEqual({ unit: 'speech', model: 'story-voice', each: 2 });
  });
  it('a refusal or an outage costs nothing; no voice anywhere is a clear 400', async () => {
    const { h } = await withEleven((req) => (req.url!.includes('Bad') ? { status: 422, body: JSON.stringify({ detail: { status: 'invalid_text', message: 'text is empty' } }) } : { status: 500, body: '{}' }));
    const a = await h.account({ voice_tokens: 10 });
    const refused = await h.api(a.key, '/audio/speech', { model: 'story-voice', input: 'x', voice: 'BadVoice1234' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toBe('text is empty');
    expect((await h.api(a.key, '/audio/speech', { model: 'story-voice', input: 'x', voice: 'GoodVoice1234' })).status).toBe(502);
    const none = await h.api(a.key, '/audio/speech', { model: 'story-voice', input: 'x' });
    expect(none.status).toBe(400);
    expect((await none.json()).error.message).toContain('voice');
    expect((await a.wallet()).balances.voice_tokens).toBe(10);
  });
});
