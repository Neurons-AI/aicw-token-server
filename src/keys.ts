/** Per-device API keys. Only the sha256 of a key is stored; the key itself is shown once. */
import { randomBase62, randomId, sha256 } from './crypto.ts';
import { st, type Storage } from './storage.ts';

const now = () => new Date().toISOString();
export interface KeyRecord {
  id: string;
  account_ref: string;
  device_ref: string | null;
  prefix: string;
  status: string;
}
/** Issue the one live key of a device (asking again replaces it). */
export async function issueKey(db: Storage, keyPrefix: string, accountRef: string, deviceRef: string | null): Promise<{ key: string; prefix: string; id: string }> {
  const key = `${keyPrefix}-${randomBase62(40)}`;
  const prefix = key.slice(0, keyPrefix.length + 7);
  const id = randomId();
  const stamp = now();
  const batch = [];
  if (deviceRef) batch.push(st("UPDATE ts_keys SET status='revoked',revoked_at=? WHERE account_ref=? AND device_ref=? AND status='active'", stamp, accountRef, deviceRef));
  batch.push(st('INSERT INTO ts_keys(id,account_ref,device_ref,key_hash,prefix,status,created_at) VALUES(?,?,?,?,?,?,?)', id, accountRef, deviceRef, await sha256(key), prefix, 'active', stamp));
  await db.batch(batch);
  return { key, prefix, id };
}
export async function verifyKey(db: Storage, key: string): Promise<KeyRecord | null> {
  if (!key || key.length < 20 || key.length > 200) return null;
  // The lookup is by hash, so there is no byte-by-byte comparison of the secret to time.
  const row = await db.first<KeyRecord>("SELECT id,account_ref,device_ref,prefix,status FROM ts_keys WHERE key_hash=? AND status='active'", await sha256(key));
  if (row) await db.run('UPDATE ts_keys SET last_used_at=? WHERE id=?', now(), row.id);
  return row;
}
export async function revokeKeys(db: Storage, accountRef: string, deviceRef?: string): Promise<number> {
  const stamp = now();
  const r = deviceRef
    ? await db.run("UPDATE ts_keys SET status='revoked',revoked_at=? WHERE account_ref=? AND device_ref=? AND status='active'", stamp, accountRef, deviceRef)
    : await db.run("UPDATE ts_keys SET status='revoked',revoked_at=? WHERE account_ref=? AND status='active'", stamp, accountRef);
  return r.changes;
}
export async function listKeys(db: Storage, accountRef: string) {
  return db.all<{ prefix: string; device_ref: string | null; status: string; created_at: string; last_used_at: string | null }>(
    'SELECT prefix,device_ref,status,created_at,last_used_at FROM ts_keys WHERE account_ref=? ORDER BY created_at DESC LIMIT 50',
    accountRef
  );
}
