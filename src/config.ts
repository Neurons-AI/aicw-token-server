/**
 * What an operator writes in `token-server.json`. Secrets never go in this file: an adapter
 * names the environment variable that holds its upstream key.
 */
import { MODEL_TYPES, type ModelType } from './protocol.ts';

export interface AdapterConfig {
  /** `openai`: any OpenAI-compatible API. `anthropic`: Claude Messages API (translated, prompt-cached). `gemini`: Google Gemini (chat + Nano Banana images). `byteplus`: BytePlus ModelArk video (Seedance). `elevenlabs`: ElevenLabs speech. `mock`: canned answers. */
  kind: 'openai' | 'anthropic' | 'gemini' | 'byteplus' | 'elevenlabs' | 'mock' | (string & {});
  baseUrl?: string;
  /** Name of the environment variable with the upstream API key. */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** elevenlabs: the voice id used when a request names none. */
  voice?: string;
  /**
   * openai: `"chat"` makes images through chat completions with `modalities: ["image","text"]`
   * (OpenRouter, Gemini image models) instead of `/images/generations` and `/images/edits`.
   */
  images?: 'chat';
}
/** How many wallet tokens one call costs. */
export interface Price {
  /** chat / embedding: wallet tokens per model token, by kind (default 1 each). */
  input?: number;
  output?: number;
  cacheRead?: number;
  /** chat: wallet tokens per prompt token written to the provider's cache (default: `input`). */
  cacheWrite?: number;
  /**
   * Safety net, wallet tokens per 1 USD: when the upstream reports what the call cost (OpenRouter's
   * `usage.cost`), the charge is never below that cost × perUsd. Set it from the same formula as
   * the token prices so a pricier route, a long-context tier or cache writes never sell at a loss.
   */
  perUsd?: number;
  /** chat: prices for a call whose prompt is longer than `above` tokens (the whole call, as Google bills Gemini Pro). */
  longContext?: { above: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** chat: what to reserve when the request names no max_tokens. */
  defaultHold?: number;
  /** image: tokens per image by quality; `edit` is added when reference images are sent. */
  quality?: Record<string, number>;
  edit?: number;
  /**
   * video: floor, wallet tokens per 1 million upstream tokens the job reports (BytePlus bills video by
   * token, and an edit or extension also bills the source video): a job never costs less than that.
   */
  perMillionUpstreamTokens?: number;
  /** video: the same for a job with a source / reference video (BytePlus bills those at a lower token rate). With it, such a job is charged by the tokens reported, not by seconds. */
  perMillionUpstreamTokensWithVideo?: number;
  /** video: tokens per second by resolution. */
  resolution?: Record<string, number>;
  minSeconds?: number;
  maxSeconds?: number;
  defaultSeconds?: number;
  /** tts: tokens per 1000 characters. */
  per1kChars?: number;
  /** stt / other: tokens per request. */
  perRequest?: number;
}
export interface ModelConfig {
  id: string;
  type: ModelType;
  bucket: string;
  adapter: string;
  /** The model name the upstream knows (default: `id`). */
  upstreamModel?: string;
  /** Fields set on every upstream chat/image request for this model (e.g. OpenRouter `provider` routing); they win over the caller's. */
  upstreamBody?: Record<string, unknown>;
  /** `"anthropic"`: mark the prompt for Anthropic prompt caching (system + last messages), through OpenRouter. */
  promptCache?: 'anthropic';
  price?: Price;
  /** One sentence for buyers. */
  unit?: string;
  /** chat: shown to the app (PublicModel): display name, context window, longest answer, picture input, thinking. */
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: Array<'text' | 'image'>;
  reasoning?: boolean;
  /** What one use is called in the buyer's estimate (default by type: message, image, video, speech, request). */
  estimateUnit?: import('./protocol.ts').EstimateUnit;
}
/** A wallet bucket. */
export interface BucketConfig {
  label: string;
  /** Store deep link where a buyer gets more of this bucket. */
  topup?: string;
  /**
   * What one typical use looks like, for the "about how many" a buyer sees instead of a token
   * count (default: the bucket's first model; an agent message of 6,000 fresh input + 60,000
   * cached input + 2,000 output tokens; a medium image; a 5 second 720p video).
   */
  estimate?: import('./prices.ts').EstimateProfile;
}
export interface TokenServerConfig {
  name: string;
  /** How the app files this server: lowercase letters, digits, dashes. */
  providerId: string;
  /** Keys look like `<keyPrefix>-…`. */
  keyPrefix: string;
  /** Public base URL (https://…), without /v1. Used in the manifest and in video URLs. */
  publicUrl: string;
  /** Raw Ed25519 public keys (base64) of the Stores allowed to grant tokens and issue keys. */
  trustedStoreKeys: string[];
  buckets: Record<string, BucketConfig>;
  models: ModelConfig[];
  adapters: Record<string, AdapterConfig>;
  /** Whether a trusted Store may also correct balances by hand (`/aicw/adjust`). */
  allowStoreAdjust?: boolean;
  /**
   * Whether a trusted Store may change prices and estimates at run time (`/aicw/prices/set`,
   * `/aicw/estimates/set`). Off by default: the prices in this file are the prices.
   */
  allowStorePricing?: boolean;
  limits?: { requestsPerMinute?: number; maxOpenVideos?: number; maxBodyBytes?: number };
}

/** The AICW Store production signing key (also pinned in the desktop app). */
export const AICW_STORE_PUBLIC_KEYS: string[] = ['tyM+Jt4Ch4fKlRfku6tHnBw0dpVaw33rXgGPYvSXx/U='];

export const DEFAULT_LIMITS = { requestsPerMinute: 60, maxOpenVideos: 3, maxBodyBytes: 32 * 1024 * 1024 };

export function validateConfig(raw: unknown, extraAdapterKinds: string[] = []): { config: TokenServerConfig; problems: string[] } {
  const problems: string[] = [];
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<TokenServerConfig>;
  const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (!str(c.name)) problems.push('name: give the server a name buyers will see');
  if (!str(c.providerId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(c.providerId))) problems.push('providerId: lowercase letters, digits and dashes (for example "acme-voice")');
  if (!str(c.keyPrefix) || !/^[a-z][a-z0-9-]{1,15}$/.test(String(c.keyPrefix))) problems.push('keyPrefix: 2-16 lowercase characters starting with a letter (for example "sk-acme")');
  if (!str(c.publicUrl) || !/^https?:\/\//.test(String(c.publicUrl))) problems.push('publicUrl: the public https:// address of this server');
  if (!Array.isArray(c.trustedStoreKeys)) problems.push('trustedStoreKeys: a list (may be empty while you develop)');
  const buckets = c.buckets && typeof c.buckets === 'object' ? c.buckets : {};
  if (!Object.keys(buckets).length) problems.push('buckets: declare at least one wallet bucket');
  for (const id of Object.keys(buckets)) if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) problems.push(`buckets.${id}: lowercase letters, digits and underscores`);
  const adapters = c.adapters && typeof c.adapters === 'object' ? c.adapters : {};
  for (const [id, a] of Object.entries(adapters)) {
    const kind = (a as AdapterConfig)?.kind;
    if (!['openai', 'byteplus', 'elevenlabs', 'anthropic', 'gemini', 'mock', ...extraAdapterKinds].includes(kind)) problems.push(`adapters.${id}.kind: openai, byteplus, elevenlabs, anthropic, gemini, mock${extraAdapterKinds.length ? ', ' + extraAdapterKinds.join(', ') : ''}`);
    if (kind === 'openai' && !str((a as AdapterConfig)?.baseUrl)) problems.push(`adapters.${id}.baseUrl: the upstream API address`);
  }
  const seen = new Set<string>();
  if (!Array.isArray(c.models) || !c.models.length) problems.push('models: declare at least one model');
  for (const [i, m] of (Array.isArray(c.models) ? c.models : []).entries()) {
    const at = `models[${i}]`;
    if (!str(m?.id)) problems.push(`${at}.id: required`);
    else if (seen.has(m.id)) problems.push(`${at}.id: "${m.id}" is declared twice`);
    else seen.add(m.id);
    if (!MODEL_TYPES.includes(m?.type)) problems.push(`${at}.type: one of ${MODEL_TYPES.join(', ')}`);
    if (!str(m?.bucket) || !(m.bucket in buckets)) problems.push(`${at}.bucket: "${m?.bucket}" is not a declared bucket`);
    if (!str(m?.adapter) || !(m.adapter in adapters)) problems.push(`${at}.adapter: "${m?.adapter}" is not a declared adapter`);
  }
  return { config: c as TokenServerConfig, problems };
}
