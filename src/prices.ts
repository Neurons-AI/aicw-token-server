/**
 * Live prices and the "about how many" estimate of each wallet bucket.
 *
 * `token-server.json` holds the operator's starting prices. When the operator lets the Store set
 * prices (`allowStorePricing`), a trusted Store may replace a model's price or a bucket's
 * estimate at run time; the replacement lives in the database (`ts_overrides`), every change is
 * logged (`ts_override_log`), and the server picks it up without a restart.
 *
 * The estimate is what a buyer sees instead of a token count: "about 40 messages", "about 100
 * images". It is the price of one typical use of the bucket's model, so it follows the price.
 */
import type { BucketConfig, ModelConfig, Price, TokenServerConfig } from './config.ts';
import type { BucketEstimate, EstimateUnit, ModelType } from './protocol.ts';
import { randomId } from './crypto.ts';
import { st, type Storage } from './storage.ts';

const DEFAULT_QUALITY: Record<string, number> = { low: 1, medium: 1, high: 4, auto: 1 };
const DEFAULT_RESOLUTION: Record<string, number> = { '480p': 1, '720p': 2, '1080p': 4 };
/** One message of an agent: a few model calls, most of the prompt read back from the cache. */
export const DEFAULT_CHAT_PROFILE = { input: 6_000, cacheRead: 60_000, output: 2_000 };

/** A model's price with every default the metering code would use filled in. */
export function fullPrice(model: ModelConfig): Price {
  const p = model.price ?? {};
  // The cost floor is the operator's, never the Store's: it stays whatever price is laid over it.
  const floor = { ...(p.perUsd ? { perUsd: p.perUsd } : {}), ...(p.longContext ? { longContext: { ...p.longContext } } : {}), ...(p.perMillionUpstreamTokens ? { perMillionUpstreamTokens: p.perMillionUpstreamTokens } : {}), ...(p.perMillionUpstreamTokensWithVideo ? { perMillionUpstreamTokensWithVideo: p.perMillionUpstreamTokensWithVideo } : {}) };
  switch (model.type) {
    case 'chat':
      return { input: p.input ?? 1, output: p.output ?? 1, cacheRead: p.cacheRead ?? p.input ?? 1, ...(p.cacheWrite !== undefined ? { cacheWrite: p.cacheWrite } : {}), defaultHold: p.defaultHold ?? 16_000, ...floor };
    case 'embedding':
      return { input: p.input ?? 1 };
    case 'image':
      return { quality: { ...(p.quality ?? DEFAULT_QUALITY) }, edit: p.edit ?? 0, ...floor };
    case 'video':
      return { resolution: { ...(p.resolution ?? DEFAULT_RESOLUTION) }, minSeconds: p.minSeconds ?? 4, maxSeconds: p.maxSeconds ?? 12, defaultSeconds: p.defaultSeconds ?? 5, ...floor };
    case 'tts':
      return { per1kChars: p.per1kChars ?? 1 };
    default:
      return { perRequest: p.perRequest ?? 1 };
  }
}
/** Which price fields the Store may set, by model type. Seconds limits are the operator's, not a price. */
const SETTABLE: Record<ModelType, string[]> = {
  chat: ['input', 'output', 'cacheRead', 'cacheWrite', 'defaultHold'],
  embedding: ['input'],
  image: ['quality', 'edit'],
  video: ['resolution'],
  tts: ['per1kChars'],
  stt: ['perRequest'],
  other: ['perRequest'],
};
const weight = (v: unknown, min = 0.000001) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= 1_000_000;

/** Check a price a Store wants to set. Returns the problems (empty: fine). */
export function checkPrice(model: ModelConfig, raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['price must be an object'];
  const p = raw as Record<string, unknown>;
  const problems: string[] = [];
  const allowed = SETTABLE[model.type];
  const base = fullPrice(model);
  for (const [k, v] of Object.entries(p)) {
    if (!allowed.includes(k)) {
      problems.push(`${k}: not a price of a ${model.type} model (allowed: ${allowed.join(', ')})`);
      continue;
    }
    if (k === 'quality' || k === 'resolution') {
      const table = base[k as 'quality' | 'resolution']!;
      if (!v || typeof v !== 'object' || Array.isArray(v)) problems.push(`${k}: an object of numbers`);
      else
        for (const [key, n] of Object.entries(v as Record<string, unknown>)) {
          if (!(key in table)) problems.push(`${k}.${key}: this model has no such ${k === 'quality' ? 'quality' : 'resolution'} (it has ${Object.keys(table).join(', ')})`);
          else if (!weight(n)) problems.push(`${k}.${key}: a number above 0`);
        }
    } else if (k === 'defaultHold') {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10_000_000) problems.push('defaultHold: a whole number of model tokens, 1 to 10,000,000');
    } else if (k === 'edit') {
      if (!weight(v, 0)) problems.push('edit: a number, 0 or more');
    } else if (!weight(v)) problems.push(`${k}: a number above 0`);
  }
  return problems;
}
/** The default price with a replacement laid over it (tables merge key by key). */
export function mergePrice(model: ModelConfig, override: Price | null | undefined): Price {
  const base = fullPrice(model);
  if (!override) return base;
  return {
    ...base,
    ...override,
    ...(base.quality ? { quality: { ...base.quality, ...(override.quality ?? {}) } } : {}),
    ...(base.resolution ? { resolution: { ...base.resolution, ...(override.resolution ?? {}) } } : {}),
  };
}
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const table = (t: Record<string, number>) => Object.entries(t).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
/** One line a buyer can read, made from a price. */
export function describePrice(model: ModelConfig, p: Price): string {
  switch (model.type) {
    case 'chat':
      return `per model token: input ${fmt(p.input!)} · cached input ${fmt(p.cacheRead!)} · output ${fmt(p.output!)} tokens`;
    case 'embedding':
      return `per model token: ${fmt(p.input!)} tokens`;
    case 'image':
      return `per image: ${table(p.quality!)} tokens${p.edit ? `; an edit adds ${fmt(p.edit)}` : ''}`;
    case 'video':
      return `per second: ${table(p.resolution!)} tokens`;
    case 'tts':
      return `per 1000 characters: ${fmt(p.per1kChars!)} tokens`;
    default:
      return `per request: ${fmt(p.perRequest!)} tokens`;
  }
}

// ───────────────────────────── estimates ─────────────────────────────
export interface EstimateProfile {
  /** The model a typical use goes to (default: the bucket's first model). */
  model?: string;
  chat?: { input: number; cacheRead: number; output: number };
  image?: { quality: string };
  video?: { seconds: number; resolution: string };
  tts?: { chars: number };
}
const UNIT: Record<ModelType, EstimateUnit> = { chat: 'message', embedding: 'request', image: 'image', video: 'video', tts: 'speech', stt: 'request', other: 'request' };

/** The profile with every default filled in, for the bucket's model. */
export function fullProfile(model: ModelConfig, price: Price, profile: EstimateProfile = {}): Required<Pick<EstimateProfile, 'model'>> & EstimateProfile {
  const out: EstimateProfile & { model: string } = { model: model.id };
  if (model.type === 'chat') out.chat = { ...DEFAULT_CHAT_PROFILE, ...(profile.chat ?? {}) };
  if (model.type === 'image') out.image = { quality: profile.image?.quality ?? ('medium' in price.quality! ? 'medium' : Object.keys(price.quality!)[0]) };
  if (model.type === 'video') {
    const res = price.resolution!;
    out.video = { seconds: profile.video?.seconds ?? price.defaultSeconds ?? 5, resolution: profile.video?.resolution ?? ('720p' in res ? '720p' : Object.keys(res)[0]) };
  }
  if (model.type === 'tts') out.tts = { chars: profile.tts?.chars ?? 1000 };
  return out;
}
/** Wallet tokens one typical use costs. */
export function estimateEach(model: ModelConfig, price: Price, profile: EstimateProfile): number {
  const f = fullProfile(model, price, profile);
  let n: number;
  switch (model.type) {
    case 'chat':
      n = f.chat!.input * price.input! + f.chat!.cacheRead * price.cacheRead! + f.chat!.output * price.output!;
      break;
    case 'embedding':
      n = 1000 * price.input!;
      break;
    case 'image':
      n = price.quality![f.image!.quality] ?? 1;
      break;
    case 'video':
      n = (price.resolution![f.video!.resolution] ?? 1) * f.video!.seconds;
      break;
    case 'tts':
      n = (f.tts!.chars / 1000) * price.per1kChars!;
      break;
    default:
      n = price.perRequest!;
  }
  return Math.max(0.000001, Math.round(n * 1e6) / 1e6);
}
export function checkEstimate(config: TokenServerConfig, bucket: string, raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['estimate must be an object'];
  const e = raw as EstimateProfile & Record<string, unknown>;
  const problems: string[] = [];
  const models = config.models.filter((m) => m.bucket === bucket);
  const model = e.model === undefined ? models[0] : models.find((m) => m.id === e.model);
  if (!model) return [e.model === undefined ? `bucket "${bucket}" has no model` : `model: "${String(e.model)}" does not spend bucket "${bucket}"`];
  const price = fullPrice(model);
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  for (const k of Object.keys(e)) if (!['model', 'chat', 'image', 'video', 'tts'].includes(k)) problems.push(`${k}: not part of an estimate`);
  const only = (k: string, type: ModelType) => e[k] !== undefined && model.type !== type && problems.push(`${k}: the model "${model.id}" is a ${model.type} model`);
  only('chat', 'chat');
  only('image', 'image');
  only('video', 'video');
  only('tts', 'tts');
  if (e.chat && model.type === 'chat') {
    const c = e.chat;
    if (!int(c.input, 0, 10_000_000) || !int(c.cacheRead, 0, 10_000_000) || !int(c.output, 1, 10_000_000)) problems.push('chat: whole numbers of model tokens for input, cacheRead and output (output at least 1)');
  }
  if (e.image && model.type === 'image' && !(e.image.quality in price.quality!)) problems.push(`image.quality: one of ${Object.keys(price.quality!).join(', ')}`);
  if (e.video && model.type === 'video') {
    if (!(e.video.resolution in price.resolution!)) problems.push(`video.resolution: one of ${Object.keys(price.resolution!).join(', ')}`);
    if (!int(e.video.seconds, price.minSeconds!, price.maxSeconds!)) problems.push(`video.seconds: ${price.minSeconds} to ${price.maxSeconds}`);
  }
  if (e.tts && model.type === 'tts' && !int(e.tts.chars, 1, 1_000_000)) problems.push('tts.chars: 1 to 1,000,000');
  return problems;
}

// ───────────────────────────── what is live ─────────────────────────────
export interface Overrides {
  prices: Map<string, { price: Price; updatedAt: string; note: string | null }>;
  estimates: Map<string, { estimate: EstimateProfile; updatedAt: string; note: string | null }>;
}
export async function readOverrides(db: Storage): Promise<Overrides> {
  const rows = await db.all<{ kind: string; target: string; json: string; updated_at: string; note: string | null }>('SELECT kind,target,json,updated_at,note FROM ts_overrides');
  const out: Overrides = { prices: new Map(), estimates: new Map() };
  for (const r of rows) {
    try {
      if (r.kind === 'price') out.prices.set(r.target, { price: JSON.parse(r.json), updatedAt: r.updated_at, note: r.note });
      if (r.kind === 'estimate') out.estimates.set(r.target, { estimate: JSON.parse(r.json), updatedAt: r.updated_at, note: r.note });
    } catch {
      /* an unreadable row is ignored: the operator's price applies */
    }
  }
  return out;
}
/** Set (or, with null, remove) one replacement and log it, in one batch. */
export async function writeOverride(db: Storage, kind: 'price' | 'estimate', target: string, value: unknown | null, note: string | null): Promise<void> {
  const stamp = new Date().toISOString();
  await db.batch([
    value === null
      ? st('DELETE FROM ts_overrides WHERE kind=? AND target=?', kind, target)
      : st('INSERT INTO ts_overrides(kind,target,json,updated_at,note) VALUES(?,?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at,note=excluded.note', kind, target, JSON.stringify(value), stamp, note),
    st('INSERT INTO ts_override_log(id,kind,target,json,note,created_at) VALUES(?,?,?,?,?,?)', randomId(), kind, target, value === null ? null : JSON.stringify(value), note, stamp),
  ]);
}
export async function overrideLog(db: Storage, limit = 50) {
  return (await db.all<{ kind: string; target: string; json: string | null; note: string | null; created_at: string }>('SELECT kind,target,json,note,created_at FROM ts_override_log ORDER BY created_at DESC LIMIT ?', limit)).map((r) => ({
    kind: r.kind,
    target: r.target,
    value: r.json === null ? null : JSON.parse(r.json),
    note: r.note,
    at: r.created_at,
  }));
}
export interface LiveCatalog {
  models: ModelConfig[];
  /** Bucket id → its estimate (what one typical use costs). */
  estimates: Record<string, BucketEstimate>;
  profiles: Record<string, EstimateProfile & { model: string }>;
}
/** The models with their live prices, and each bucket's estimate. */
export function liveCatalog(config: TokenServerConfig, o: Overrides): LiveCatalog {
  const models = config.models.map((m) => {
    const replaced = o.prices.get(m.id);
    if (!replaced) return m;
    const price = mergePrice(m, replaced.price);
    return { ...m, price, unit: describePrice(m, price) };
  });
  const estimates: LiveCatalog['estimates'] = {};
  const profiles: LiveCatalog['profiles'] = {};
  for (const [id, b] of Object.entries(config.buckets) as Array<[string, BucketConfig]>) {
    const profile: EstimateProfile = o.estimates.get(id)?.estimate ?? b.estimate ?? {};
    const model = models.find((m) => m.id === profile.model && m.bucket === id) ?? models.find((m) => m.bucket === id);
    if (!model) continue;
    const price = fullPrice(model);
    profiles[id] = fullProfile(model, price, profile) as EstimateProfile & { model: string };
    estimates[id] = { unit: model.estimateUnit ?? UNIT[model.type], model: model.id, each: estimateEach(model, price, profile), ...(profiles[id].video ? { seconds: profiles[id].video!.seconds, resolution: profiles[id].video!.resolution } : {}), ...(profiles[id].image ? { quality: profiles[id].image!.quality } : {}) };
  }
  return { models, estimates, profiles };
}
