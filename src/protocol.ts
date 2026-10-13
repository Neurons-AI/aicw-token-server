/**
 * The AICW Token Server protocol, version 1.
 *
 * Two audiences talk to a token server:
 *   - an AI Coworker app, with a per-device key, on the OpenAI-compatible `/v1/*` routes;
 *   - the AICW Store, with Ed25519-signed requests, on `/aicw/*` (grant tokens after a
 *     purchase, issue a device key, refund, read a balance).
 *
 * This file is the single description of the shapes on the wire. The server, the Store and
 * the conformance check all import it, so they cannot drift apart.
 */
export const PROTOCOL_VERSION = 1;
export const WELL_KNOWN_PATH = '/.well-known/aicw-token-server';
export const SIGNATURE_HEADER = 'x-aicw-signature';
export const KEY_ID_HEADER = 'x-aicw-key-id';
/** A signed request older or newer than this is refused (replay window). */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export const MODEL_TYPES = ['chat', 'image', 'video', 'tts', 'stt', 'embedding', 'other'] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export interface PublicModel {
  id: string;
  type: ModelType;
  /** The wallet bucket a call to this model spends. */
  bucket: string;
  /** One sentence a buyer can read: "1 token = 1 image at medium quality". */
  unit?: string;
}
/** What one typical use of a bucket is: a buyer sees "about N <unit>s", never a token count. */
export type EstimateUnit = 'message' | 'image' | 'video' | 'speech' | 'song' | 'request';
export interface BucketEstimate {
  unit: EstimateUnit;
  /** The model a typical use goes to. */
  model: string;
  /** Wallet tokens one typical use costs (may be fractional). */
  each: number;
  /** video: the clip the estimate counts. */
  seconds?: number;
  resolution?: string;
  /** image: the quality the estimate counts. */
  quality?: string;
}
export interface PublicBucket {
  id: string;
  label: string;
  estimate?: BucketEstimate;
}
export interface ServerManifest {
  protocol: number;
  name: string;
  /** Provider id the app files this server under (lowercase, digits, dashes). */
  providerId: string;
  /** Base URL of the OpenAI-compatible API, ending in /v1. */
  baseUrl: string;
  buckets: PublicBucket[];
  models: PublicModel[];
  library?: { name: string; version: string };
}

export interface Grant {
  bucket: string;
  amount: number;
}
/** Every signed body carries when it was made; the receiver refuses stale ones. */
export interface Signed {
  ts: string;
}
export interface FulfillRequest extends Signed {
  receiptId: string;
  /** Opaque, stable per (Store account, server). The server never learns who the buyer is. */
  accountRef: string;
  sku: string;
  quantity: number;
  grants: Grant[];
  orderRef: string;
  paidAt: string;
  /** A conformance-check purchase: grant it to a sandbox account that never reaches a real model. */
  test?: boolean;
}
export interface FulfillResponse {
  ok: true;
  /** False when this receipt had already been fulfilled (the call is idempotent). */
  applied: boolean;
  balances: Record<string, number>;
}
export interface RefundRequest extends Signed {
  receiptId: string;
}
export interface RefundResponse {
  ok: true;
  applied: boolean;
  /** What was taken back: the unused part of what the receipt granted. */
  refunded: Grant[];
}
export interface KeyRequest extends Signed {
  accountRef: string;
  deviceRef: string;
  test?: boolean;
}
export interface ProviderDescriptor {
  id: string;
  name: string;
  baseUrl: string;
  models: PublicModel[];
}
export interface KeyResponse {
  ok: true;
  /** Shown once. A device has one live key: asking again revokes the previous one. */
  key: string;
  prefix: string;
  provider: ProviderDescriptor;
}
export interface KeyRevokeRequest extends Signed {
  accountRef: string;
  /** Omitted: every key of the account. */
  deviceRef?: string;
}
export interface BalanceRequest extends Signed {
  accountRef: string;
}
export interface BalanceResponse {
  ok: true;
  balances: Record<string, number>;
  held: Record<string, number>;
  /** Per bucket: the wallet right after its last top-up. 100% of the buyer's quota; balance / quota is what is left. */
  quota: Record<string, number>;
  buckets: PublicBucket[];
  keys: Array<{ prefix: string; deviceRef: string | null; status: string; createdAt: string; lastUsedAt: string | null }>;
  usage: Array<{ bucket: string; model: string; requests: number; charged: number }>;
}
export interface AdjustRequest extends Signed {
  accountRef: string;
  bucket: string;
  delta: number;
  /** Idempotency key. */
  ref: string;
  note?: string;
}

/** `POST /aicw/prices`: what the Store's price page shows. */
export interface PriceEntry {
  id: string;
  type: ModelType;
  bucket: string;
  /** The price in force (the operator's, or the Store's replacement). */
  price: Record<string, unknown>;
  /** The operator's price from the configuration file. */
  defaultPrice: Record<string, unknown>;
  overridden: boolean;
  unit?: string;
  updatedAt: string | null;
}
export interface EstimateEntry {
  bucket: string;
  label: string;
  estimate: BucketEstimate;
  /** The typical use in force, every default filled in. */
  profile: Record<string, unknown>;
  overridden: boolean;
  updatedAt: string | null;
}
export interface PricesResponse {
  ok: true;
  /** False: this server keeps its prices in its configuration file and refuses changes. */
  editable: boolean;
  models: PriceEntry[];
  buckets: EstimateEntry[];
  log: Array<{ kind: string; target: string; value: unknown; note: string | null; at: string }>;
}
export interface SetPriceRequest extends Signed {
  model: string;
  /** Fields of the price to replace (tables merge key by key); null puts the operator's price back. */
  price: Record<string, unknown> | null;
  note?: string;
}
export interface SetEstimateRequest extends Signed {
  bucket: string;
  estimate: Record<string, unknown> | null;
  note?: string;
}

/** `GET /v1/me/balance` (device key). */
export interface MeBalance {
  balances: Record<string, number>;
  held: Record<string, number>;
  quota: Record<string, number>;
  buckets: PublicBucket[];
  updatedAt: string;
}
/** The error body of every `/v1/*` failure (the OpenAI shape, plus what the app needs to react). */
export interface ApiError {
  error: {
    message: string;
    type: string;
    code: string;
    bucket?: string;
    balance?: number;
    needed?: number;
    /** Where the app sends the user to buy more (a Store deep link). */
    topup?: string;
  };
}
export const balanceHeader = (bucket: string) => `x-aicw-balance-${bucket.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
/** The bucket's quota (100% = the wallet right after its last top-up), next to its balance: apps show balance ÷ quota, not tokens. */
export const quotaHeader = (bucket: string) => `x-aicw-quota-${bucket.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

/** Video job states, the same words the OpenAI video API uses. */
export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed';
export interface VideoJob {
  id: string;
  object: 'video';
  model: string;
  status: VideoStatus;
  progress?: number;
  /** Present when completed: fetch it with the same key. */
  url?: string;
  error?: { message: string; code: string };
}
