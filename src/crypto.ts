/** WebCrypto only: the same code runs on Cloudflare Workers and on Node. */
const enc = new TextEncoder();
export const bytes = (s: string) => enc.encode(s);
export const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
export const hex = (b: Uint8Array) => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
export async function sha256(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? bytes(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Unbiased base62 (rejection sampling). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const n of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (n < 248 && out.length < length) out += ALPHABET[n % 62];
    }
  }
  return out;
}
export const randomId = () => crypto.randomUUID();
/** The id the Store and a server use to name an Ed25519 public key: first 8 hex of its sha256. */
export const keyId = async (rawPublicKey: Uint8Array) => (await sha256(rawPublicKey)).slice(0, 8);

export async function importPublicKey(rawB64: string): Promise<CryptoKey> {
  const raw = unb64(rawB64);
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, true, ['verify']);
}
export async function verifySignature(rawPublicKeyB64: string, body: string, signatureB64: string): Promise<boolean> {
  try {
    const key = await importPublicKey(rawPublicKeyB64);
    return await crypto.subtle.verify('Ed25519', key, unb64(signatureB64) as BufferSource, bytes(body) as BufferSource);
  } catch {
    return false;
  }
}
export interface Signer {
  /** Raw public key, base64. */
  publicKey: string;
  kid: string;
  sign(body: string): Promise<string>;
}
/** A signer from a PKCS#8 Ed25519 private key (base64), the format the Store keeps its key in. */
export async function signerFromPkcs8(pkcs8B64: string): Promise<Signer> {
  const key = await crypto.subtle.importKey('pkcs8', unb64(pkcs8B64) as BufferSource, { name: 'Ed25519' }, true, ['sign']);
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
  const raw = unb64(jwk.x!);
  return {
    publicKey: b64(raw),
    kid: await keyId(raw),
    sign: async (body) => b64(new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes(body) as BufferSource))),
  };
}
/** A throwaway key pair: tests, `check --self`, and a developer's local run. */
export async function generateSigner(): Promise<Signer & { pkcs8: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = b64(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer));
  return { ...(await signerFromPkcs8(pkcs8)), pkcs8 };
}
/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
