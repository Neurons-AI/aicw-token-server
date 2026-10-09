/**
 * The Store's side of the protocol: build a signed request and call a token server. The AICW
 * Store uses this; so do the conformance check and the tests. A developer's own tooling can
 * use it too, with a key the server trusts.
 */
import type { Signer } from './crypto.ts';
import {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  WELL_KNOWN_PATH,
  type AdjustRequest,
  type BalanceResponse,
  type FulfillRequest,
  type FulfillResponse,
  type KeyResponse,
  type RefundResponse,
  type ServerManifest,
} from './protocol.ts';

export async function signedRequest(signer: Signer, body: Record<string, unknown>, at: Date = new Date()): Promise<{ body: string; headers: Record<string, string> }> {
  const text = JSON.stringify({ ...body, ts: at.toISOString() });
  return { body: text, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: await signer.sign(text), [KEY_ID_HEADER]: signer.kid } };
}
export class TokenServerError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
type Omit2<T> = Omit<T, 'ts'>;
export interface StoreClient {
  manifest(): Promise<ServerManifest>;
  fulfill(req: Omit2<FulfillRequest>): Promise<FulfillResponse>;
  refund(receiptId: string): Promise<RefundResponse>;
  issueKey(accountRef: string, deviceRef: string, test?: boolean): Promise<KeyResponse>;
  revokeKeys(accountRef: string, deviceRef?: string): Promise<{ ok: true; revoked: number }>;
  balance(accountRef: string): Promise<BalanceResponse>;
  adjust(req: Omit2<AdjustRequest>): Promise<FulfillResponse>;
}
export function storeClient(serverUrl: string, signer: Signer, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): StoreClient {
  const base = serverUrl.replace(/\/+$/, '');
  const read = async <T>(res: Response): Promise<T> => {
    const data = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
    if (!res.ok || !data) throw new TokenServerError(res.status, String(data?.error?.code || 'bad_answer'), String(data?.error?.message || `the token server answered ${res.status}`));
    return data;
  };
  const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const req = await signedRequest(signer, body);
    return read<T>(await fetchImpl(base + path, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) }));
  };
  return {
    manifest: async () => read<ServerManifest>(await fetchImpl(base + WELL_KNOWN_PATH, { signal: AbortSignal.timeout(timeoutMs) })),
    fulfill: (req) => post('/aicw/fulfill', req as unknown as Record<string, unknown>),
    refund: (receiptId) => post('/aicw/refund', { receiptId }),
    issueKey: (accountRef, deviceRef, test) => post('/aicw/keys', { accountRef, deviceRef, ...(test ? { test: true } : {}) }),
    revokeKeys: (accountRef, deviceRef) => post('/aicw/keys/revoke', { accountRef, ...(deviceRef ? { deviceRef } : {}) }),
    balance: (accountRef) => post('/aicw/balance', { accountRef }),
    adjust: (req) => post('/aicw/adjust', req as unknown as Record<string, unknown>),
  };
}
