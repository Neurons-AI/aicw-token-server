import { beforeEach, describe, expect, it } from 'vitest';
import { adjust, balanceOf, balances, grantReceipt, hold, migrate, refundReceipt, release, settle, WalletError, type Storage } from '../src/index.ts';
import { issueKey, revokeKeys, verifyKey } from '../src/keys.ts';
import { sqliteStorage } from '../src/storage-sqlite.ts';

let db: Storage;
const A = 'account-aaaaaa';
const req = (amount: number, mode: 'exact' | 'upTo' = 'exact', bucket = 'img') => hold(db, { accountRef: A, keyId: 'k1', bucket, amount, mode, kind: 'image', model: 'm' });
beforeEach(async () => {
  db = sqliteStorage(':memory:');
  await migrate(db);
});

describe('grants and refunds', () => {
  it('a receipt adds tokens once, however often it is delivered', async () => {
    const p = { receiptId: 'r-000001', accountRef: A, sku: 'pack', orderRef: 'o1', grants: [{ bucket: 'img', amount: 100 }, { bucket: 'llm', amount: 1_000_000 }] };
    expect(await grantReceipt(db, p)).toBe(true);
    expect(await grantReceipt(db, p)).toBe(false);
    expect((await balances(db, A)).balances).toEqual({ img: 100, llm: 1_000_000 });
  });
  it('two receipts add up', async () => {
    await grantReceipt(db, { receiptId: 'r-000001', accountRef: A, sku: 'p', orderRef: 'o', grants: [{ bucket: 'img', amount: 100 }] });
    await grantReceipt(db, { receiptId: 'r-000002', accountRef: A, sku: 'p', orderRef: 'o', grants: [{ bucket: 'img', amount: 50 }] });
    expect(await balanceOf(db, A, 'img')).toBe(150);
  });
  it('a refund takes back only what is left, once', async () => {
    await grantReceipt(db, { receiptId: 'r-000001', accountRef: A, sku: 'p', orderRef: 'o', grants: [{ bucket: 'img', amount: 100 }, { bucket: 'llm', amount: 500 }] });
    const h = await req(30);
    await settle(db, h.requestId, 30);
    const first = await refundReceipt(db, 'r-000001');
    expect(first).toEqual({ applied: true, refunded: expect.arrayContaining([{ bucket: 'img', amount: 70 }, { bucket: 'llm', amount: 500 }]) });
    expect(await balanceOf(db, A, 'img')).toBe(0);
    const again = await refundReceipt(db, 'r-000001');
    expect(again?.applied).toBe(false);
    expect(again?.refunded).toHaveLength(2);
    expect(await balanceOf(db, A, 'img')).toBe(0);
    expect(await refundReceipt(db, 'r-never')).toBeNull();
  });
  it('a refund never takes tokens bought with another receipt beyond what this one granted', async () => {
    await grantReceipt(db, { receiptId: 'r-000001', accountRef: A, sku: 'p', orderRef: 'o', grants: [{ bucket: 'img', amount: 100 }] });
    await grantReceipt(db, { receiptId: 'r-000002', accountRef: A, sku: 'p', orderRef: 'o', grants: [{ bucket: 'img', amount: 40 }] });
    expect((await refundReceipt(db, 'r-000002'))?.refunded).toEqual([{ bucket: 'img', amount: 40 }]);
    expect(await balanceOf(db, A, 'img')).toBe(100);
  });
  it('an adjustment is idempotent on its ref', async () => {
    expect(await adjust(db, { accountRef: A, bucket: 'img', delta: 10, ref: 'adj-000001' })).toBe(true);
    expect(await adjust(db, { accountRef: A, bucket: 'img', delta: 10, ref: 'adj-000001' })).toBe(false);
    expect(await adjust(db, { accountRef: A, bucket: 'img', delta: -4, ref: 'adj-000002' })).toBe(true);
    expect(await balanceOf(db, A, 'img')).toBe(6);
  });
});

describe('hold, settle, release', () => {
  beforeEach(async () => {
    await grantReceipt(db, { receiptId: 'r-000001', accountRef: A, sku: 'p', orderRef: 'o', grants: [{ bucket: 'img', amount: 10 }, { bucket: 'llm', amount: 1000 }] });
  });
  it('refuses a hold larger than the balance and changes nothing', async () => {
    await expect(req(11)).rejects.toMatchObject({ code: 'insufficient_tokens', bucket: 'img', balance: 10, needed: 11 });
    expect(await balances(db, A)).toMatchObject({ balances: { img: 10 }, held: { img: 0 } });
  });
  it('refuses a hold on a bucket the account never had', async () => {
    await expect(req(1, 'exact', 'nope')).rejects.toBeInstanceOf(WalletError);
  });
  it('moves tokens to held, then charges the real cost on settle', async () => {
    const h = await req(5);
    expect(h).toMatchObject({ amount: 5, balanceAfter: 5 });
    expect(await balances(db, A)).toMatchObject({ balances: { img: 5 }, held: { img: 5 } });
    expect(await settle(db, h.requestId, 3)).toBe(7);
    expect(await balances(db, A)).toMatchObject({ balances: { img: 7 }, held: { img: 0 } });
  });
  it('settling twice charges once; releasing after a settle does nothing', async () => {
    const h = await req(5);
    await settle(db, h.requestId, 5);
    expect(await settle(db, h.requestId, 5)).toBe(5);
    expect(await release(db, h.requestId)).toBe(5);
    expect(await balances(db, A)).toMatchObject({ balances: { img: 5 }, held: { img: 0 } });
  });
  it('a release gives everything back, once', async () => {
    const h = await req(10);
    expect(await release(db, h.requestId, 'upstream down')).toBe(10);
    expect(await release(db, h.requestId)).toBe(10);
    expect(await settle(db, h.requestId, 10)).toBe(10);
    expect(await balances(db, A)).toMatchObject({ balances: { img: 10 }, held: { img: 0 } });
    expect(await db.first('SELECT status,error FROM ts_requests WHERE id=?', h.requestId)).toEqual({ status: 'released', error: 'upstream down' });
  });
  it('"upTo" holds what is there when the estimate is larger', async () => {
    const h = await req(5000, 'upTo', 'llm');
    expect(h.amount).toBe(1000);
    expect(await settle(db, h.requestId, 120)).toBe(880);
  });
  it('"upTo" still refuses an empty wallet', async () => {
    const h = await req(1000, 'upTo', 'llm');
    await settle(db, h.requestId, 1000);
    await expect(req(10, 'upTo', 'llm')).rejects.toMatchObject({ code: 'insufficient_tokens', balance: 0 });
  });
  it('two calls cannot both take the last tokens', async () => {
    const results = await Promise.allSettled([req(6), req(6), req(6)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balances(db, A)).toMatchObject({ balances: { img: 4 }, held: { img: 6 } });
  });
  it('a call that costs more than was held still pays in full', async () => {
    const h = await req(100, 'upTo', 'llm');
    expect(await settle(db, h.requestId, 150)).toBe(850);
  });
  it('held always equals the sum of open requests', async () => {
    const a = await req(2);
    const b = await req(3);
    await settle(db, a.requestId, 1);
    const open = await db.first<{ n: number }>("SELECT COALESCE(SUM(hold),0) AS n FROM ts_requests WHERE status='held'");
    expect((await balances(db, A)).held.img).toBe(open!.n);
    await release(db, b.requestId);
    expect((await balances(db, A)).held.img).toBe(0);
  });
});

describe('device keys', () => {
  it('stores only a hash and finds the key again', async () => {
    const issued = await issueKey(db, 'sk-test', A, 'device-1');
    expect(issued.key.startsWith('sk-test-')).toBe(true);
    const row = await db.first<{ key_hash: string }>('SELECT key_hash FROM ts_keys WHERE id=?', issued.id);
    expect(row!.key_hash).not.toContain(issued.key.slice(8));
    expect((await verifyKey(db, issued.key))?.account_ref).toBe(A);
    expect(await verifyKey(db, issued.key + 'x')).toBeNull();
    expect(await verifyKey(db, '')).toBeNull();
  });
  it('a device has one live key; another device is untouched', async () => {
    const a1 = await issueKey(db, 'sk-test', A, 'device-1');
    const b1 = await issueKey(db, 'sk-test', A, 'device-2');
    const a2 = await issueKey(db, 'sk-test', A, 'device-1');
    expect(await verifyKey(db, a1.key)).toBeNull();
    expect(await verifyKey(db, a2.key)).not.toBeNull();
    expect(await verifyKey(db, b1.key)).not.toBeNull();
    expect(await revokeKeys(db, A, 'device-2')).toBe(1);
    expect(await verifyKey(db, b1.key)).toBeNull();
    expect(await revokeKeys(db, A)).toBe(1);
    expect(await verifyKey(db, a2.key)).toBeNull();
  });
});
