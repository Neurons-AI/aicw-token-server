/**
 * The prepaid wallet. A balance never goes below zero through a hold, and a failed model
 * call never costs anything:
 *
 *   hold    take the estimated cost out of `balance` into `held` before calling the model
 *   settle  the call worked: give the hold back and charge what it really cost
 *   release the call failed: give the hold back
 *
 * Every step is conditional SQL, so two requests racing for the last tokens cannot both win
 * and a retried settle cannot charge twice.
 */
import type { Grant } from './protocol.ts';
import { randomId } from './crypto.ts';
import { st, type Storage } from './storage.ts';

const now = () => new Date().toISOString();

export class WalletError extends Error {
  code: string;
  bucket: string;
  balance: number;
  needed: number;
  constructor(code: string, bucket: string, balance: number, needed: number) {
    super(code);
    this.code = code;
    this.bucket = bucket;
    this.balance = balance;
    this.needed = needed;
  }
}

export async function ensureAccount(db: Storage, accountRef: string, test = false): Promise<void> {
  await db.run('INSERT OR IGNORE INTO ts_accounts(ref,test,created_at) VALUES(?,?,?)', accountRef, test ? 1 : 0, now());
}
export async function isTestAccount(db: Storage, accountRef: string): Promise<boolean> {
  return !!(await db.first<{ test: number }>('SELECT test FROM ts_accounts WHERE ref=?', accountRef))?.test;
}
export async function balances(db: Storage, accountRef: string): Promise<{ balances: Record<string, number>; held: Record<string, number>; quota: Record<string, number>; updatedAt: string }> {
  const rows = await db.all<{ bucket: string; balance: number; held: number; quota: number; updated_at: string }>(
    'SELECT bucket,balance,held,quota,updated_at FROM ts_wallets WHERE account_ref=?',
    accountRef
  );
  const out = { balances: {} as Record<string, number>, held: {} as Record<string, number>, quota: {} as Record<string, number>, updatedAt: '' };
  for (const r of rows) {
    out.balances[r.bucket] = r.balance;
    out.held[r.bucket] = r.held;
    out.quota[r.bucket] = Math.max(r.quota ?? 0, r.balance + r.held);
    if (r.updated_at > out.updatedAt) out.updatedAt = r.updated_at;
  }
  return out;
}
export async function balanceOf(db: Storage, accountRef: string, bucket: string): Promise<number> {
  return (await db.first<{ balance: number }>('SELECT balance FROM ts_wallets WHERE account_ref=? AND bucket=?', accountRef, bucket))?.balance ?? 0;
}

/**
 * Add what a paid receipt grants. Idempotent on the receipt id: the receipt row is inserted
 * first in the same batch, so a second delivery fails that insert and changes nothing.
 */
export async function grantReceipt(
  db: Storage,
  p: { receiptId: string; accountRef: string; sku: string; orderRef: string; grants: Grant[]; test?: boolean }
): Promise<boolean> {
  if (await db.first('SELECT 1 AS x FROM ts_receipts WHERE receipt_id=?', p.receiptId)) return false;
  const stamp = now();
  const batch = [
    st('INSERT OR IGNORE INTO ts_accounts(ref,test,created_at) VALUES(?,?,?)', p.accountRef, p.test ? 1 : 0, stamp),
    st('INSERT INTO ts_receipts(receipt_id,account_ref,sku,order_ref,grants_json,created_at) VALUES(?,?,?,?,?,?)', p.receiptId, p.accountRef, p.sku, p.orderRef, JSON.stringify(p.grants), stamp),
  ];
  for (const g of p.grants) {
    batch.push(
      st('INSERT INTO ts_ledger(id,account_ref,bucket,delta,kind,ref,note,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId(), p.accountRef, g.bucket, g.amount, 'grant', p.receiptId, p.sku, stamp),
      st(
        // A top-up starts a new 100%: the quota is the wallet right after it.
        'INSERT INTO ts_wallets(account_ref,bucket,balance,held,quota,updated_at) VALUES(?,?,?,0,?,?) ON CONFLICT(account_ref,bucket) DO UPDATE SET balance=balance+excluded.balance,quota=balance+held+excluded.balance,updated_at=excluded.updated_at',
        p.accountRef,
        g.bucket,
        g.amount,
        g.amount,
        stamp
      )
    );
  }
  try {
    await db.batch(batch);
    return true;
  } catch (e) {
    // Two deliveries of one receipt raced: the loser hits the primary key and rolls back.
    if (await db.first('SELECT 1 AS x FROM ts_receipts WHERE receipt_id=?', p.receiptId)) return false;
    throw e;
  }
}

/** Take back the unused part of what a receipt granted. Idempotent. */
export async function refundReceipt(db: Storage, receiptId: string): Promise<{ applied: boolean; refunded: Grant[] } | null> {
  const receipt = await db.first<{ account_ref: string; grants_json: string; refunded_at: string | null }>(
    'SELECT account_ref,grants_json,refunded_at FROM ts_receipts WHERE receipt_id=?',
    receiptId
  );
  if (!receipt) return null;
  const read = async () =>
    (await db.all<{ bucket: string; delta: number }>("SELECT bucket,delta FROM ts_ledger WHERE kind='refund' AND ref=?", receiptId)).map((r) => ({ bucket: r.bucket, amount: -r.delta }));
  if (receipt.refunded_at) return { applied: false, refunded: await read() };
  const stamp = now();
  const pending = "EXISTS(SELECT 1 FROM ts_receipts WHERE receipt_id=? AND refunded_at IS NULL)";
  const batch = [];
  for (const g of JSON.parse(receipt.grants_json) as Grant[]) {
    batch.push(
      // The ledger row records exactly what the next statement removes: min(granted, what is left).
      st(
        `INSERT INTO ts_ledger(id,account_ref,bucket,delta,kind,ref,note,created_at)
         SELECT ?,account_ref,bucket,-MIN(?,MAX(balance,0)),'refund',?,NULL,? FROM ts_wallets WHERE account_ref=? AND bucket=? AND ${pending}`,
        randomId(),
        g.amount,
        receiptId,
        stamp,
        receipt.account_ref,
        g.bucket,
        receiptId
      ),
      // What was taken back leaves the quota too (never below what is still in the wallet).
      st(`UPDATE ts_wallets SET balance=balance-MIN(?,MAX(balance,0)),quota=MAX(balance-MIN(?,MAX(balance,0))+held,quota-MIN(?,MAX(balance,0))),updated_at=? WHERE account_ref=? AND bucket=? AND ${pending}`, g.amount, g.amount, g.amount, stamp, receipt.account_ref, g.bucket, receiptId)
    );
  }
  batch.push(st('UPDATE ts_receipts SET refunded_at=? WHERE receipt_id=? AND refunded_at IS NULL', stamp, receiptId));
  const results = await db.batch(batch);
  return { applied: results[results.length - 1].changes === 1, refunded: await read() };
}

/** A manual correction by the operator (or the Store, when the server allows it). Idempotent on `ref`. */
export async function adjust(db: Storage, p: { accountRef: string; bucket: string; delta: number; ref: string; note?: string }): Promise<boolean> {
  if (await db.first("SELECT 1 AS x FROM ts_ledger WHERE kind='adjust' AND ref=? AND bucket=?", p.ref, p.bucket)) return false;
  const stamp = now();
  try {
    await db.batch([
      st('INSERT OR IGNORE INTO ts_accounts(ref,test,created_at) VALUES(?,0,?)', p.accountRef, stamp),
      st('INSERT INTO ts_ledger(id,account_ref,bucket,delta,kind,ref,note,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId(), p.accountRef, p.bucket, p.delta, 'adjust', p.ref, p.note ?? null, stamp),
      st(
        // A correction upward can only raise the quota to what the wallet now holds.
        'INSERT INTO ts_wallets(account_ref,bucket,balance,held,quota,updated_at) VALUES(?,?,?,0,?,?) ON CONFLICT(account_ref,bucket) DO UPDATE SET balance=balance+excluded.balance,quota=MAX(quota,balance+held+excluded.balance),updated_at=excluded.updated_at',
        p.accountRef,
        p.bucket,
        p.delta,
        Math.max(p.delta, 0),
        stamp
      ),
    ]);
    return true;
  } catch (e) {
    if (await db.first("SELECT 1 AS x FROM ts_ledger WHERE kind='adjust' AND ref=? AND bucket=?", p.ref, p.bucket)) return false;
    throw e;
  }
}

export interface Hold {
  requestId: string;
  amount: number;
  balanceAfter: number;
}
/**
 * Reserve tokens for one model call.
 *   exact  : the call costs exactly `amount` (an image, a video) — all or nothing.
 *   upTo   : the call costs at most `amount` (a chat turn) — hold what is there, at least 1.
 */
export async function hold(
  db: Storage,
  p: { accountRef: string; keyId: string; bucket: string; amount: number; mode: 'exact' | 'upTo'; kind: string; model: string }
): Promise<Hold> {
  const want = Math.max(1, Math.ceil(p.amount));
  for (let attempt = 0; attempt < 3; attempt++) {
    const balance = await balanceOf(db, p.accountRef, p.bucket);
    const amount = p.mode === 'exact' ? want : Math.min(want, balance);
    if (balance < 1 || amount > balance) throw new WalletError('insufficient_tokens', p.bucket, Math.max(balance, 0), want);
    const requestId = randomId();
    const stamp = now();
    const results = await db.batch([
      st('UPDATE ts_wallets SET balance=balance-?,held=held+?,updated_at=? WHERE account_ref=? AND bucket=? AND balance>=?', amount, amount, stamp, p.accountRef, p.bucket, amount),
      // Only when the reservation above happened (held now covers it).
      st(
        `INSERT INTO ts_requests(id,account_ref,key_id,kind,model,bucket,status,hold,created_at)
         SELECT ?,?,?,?,?,?,'held',?,? WHERE changes()=1`,
        requestId,
        p.accountRef,
        p.keyId,
        p.kind,
        p.model,
        p.bucket,
        amount,
        stamp
      ),
    ]);
    if (results[0].changes === 1 && results[1].changes === 1) return { requestId, amount, balanceAfter: balance - amount };
    // Lost a race for the same tokens: read the balance again.
  }
  throw new WalletError('insufficient_tokens', p.bucket, Math.max(await balanceOf(db, p.accountRef, p.bucket), 0), want);
}

/** The call worked: return the hold, charge the real cost. Returns the balance afterwards. */
export async function settle(db: Storage, requestId: string, charged: number, usage?: unknown): Promise<number | null> {
  const req = await db.first<{ account_ref: string; bucket: string; hold: number; status: string }>('SELECT account_ref,bucket,hold,status FROM ts_requests WHERE id=?', requestId);
  if (!req) return null;
  if (req.status === 'held') {
    const cost = Math.max(0, Math.ceil(charged));
    const stamp = now();
    const open = "EXISTS(SELECT 1 FROM ts_requests WHERE id=? AND status='held')";
    await db.batch([
      st(`UPDATE ts_wallets SET balance=balance+?-?,held=held-?,updated_at=? WHERE account_ref=? AND bucket=? AND ${open}`, req.hold, cost, req.hold, stamp, req.account_ref, req.bucket, requestId),
      st("UPDATE ts_requests SET status='done',charged=?,usage_json=?,done_at=? WHERE id=? AND status='held'", cost, usage === undefined ? null : JSON.stringify(usage), stamp, requestId),
    ]);
  }
  return balanceOf(db, req.account_ref, req.bucket);
}

/** The call failed: return the hold, charge nothing. */
export async function release(db: Storage, requestId: string, error?: string): Promise<number | null> {
  const req = await db.first<{ account_ref: string; bucket: string; hold: number; status: string }>('SELECT account_ref,bucket,hold,status FROM ts_requests WHERE id=?', requestId);
  if (!req) return null;
  if (req.status === 'held') {
    const stamp = now();
    const open = "EXISTS(SELECT 1 FROM ts_requests WHERE id=? AND status='held')";
    await db.batch([
      st(`UPDATE ts_wallets SET balance=balance+?,held=held-?,updated_at=? WHERE account_ref=? AND bucket=? AND ${open}`, req.hold, req.hold, stamp, req.account_ref, req.bucket, requestId),
      st("UPDATE ts_requests SET status='released',charged=0,error=?,done_at=? WHERE id=? AND status='held'", (error ?? '').slice(0, 500) || null, stamp, requestId),
    ]);
  }
  return balanceOf(db, req.account_ref, req.bucket);
}

export async function usageSummary(db: Storage, accountRef: string, sinceIso: string) {
  return db.all<{ bucket: string; model: string; requests: number; charged: number }>(
    "SELECT bucket,model,COUNT(*) AS requests,COALESCE(SUM(charged),0) AS charged FROM ts_requests WHERE account_ref=? AND status='done' AND created_at>=? GROUP BY bucket,model ORDER BY charged DESC",
    accountRef,
    sinceIso
  );
}
