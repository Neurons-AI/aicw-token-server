/** Live prices set by the Store, bucket estimates, and the quota a buyer sees as a percentage. */
import { describe, expect, it } from 'vitest';
import { migrate, SCHEMA, WELL_KNOWN_PATH } from '../src/index.ts';
import { sqliteStorage } from '../src/storage-sqlite.ts';
import { BASE, harness } from './helpers.ts';

describe('quota: 100% is the wallet right after its last top-up', () => {
  it('a top-up starts a new 100%, use lowers the balance, a refund lowers the quota', async () => {
    const h = await harness();
    const a = await h.account({ image_tokens: 10 });
    let b = await h.store.balance(a.accountRef);
    expect([b.balances.image_tokens, b.quota.image_tokens]).toEqual([10, 10]);
    const res = await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'x', quality: 'high' });
    // An app gets both with every answer, and shows 60% left (not "6 tokens").
    expect([res.headers.get('x-aicw-balance-image-tokens'), res.headers.get('x-aicw-quota-image-tokens')]).toEqual(['6', '10']);
    b = await h.store.balance(a.accountRef);
    expect([b.balances.image_tokens, b.quota.image_tokens]).toEqual([6, 10]);
    // Buying again: what is left plus the new pack is the new 100%.
    await h.store.fulfill({ receiptId: 'rcpt-second-1', accountRef: a.accountRef, sku: 'pack', quantity: 1, grants: [{ bucket: 'image_tokens', amount: 10 }], orderRef: 'ORD-2', paidAt: new Date().toISOString() });
    b = await h.store.balance(a.accountRef);
    expect([b.balances.image_tokens, b.quota.image_tokens]).toEqual([16, 16]);
    await h.store.refund('rcpt-second-1');
    b = await h.store.balance(a.accountRef);
    expect([b.balances.image_tokens, b.quota.image_tokens]).toEqual([6, 6]);
    // The app sees the same, with the estimate of each bucket.
    const me = (await (await h.api(a.key, '/me/balance')).json()) as any;
    expect(me.quota.image_tokens).toBe(6);
    expect(me.buckets.find((x: any) => x.id === 'image_tokens').estimate).toMatchObject({ unit: 'image', model: 'image-1', each: 1, quality: 'medium' });
  });
  it('an old database is upgraded: the quota of an existing wallet is what was granted', async () => {
    const db = sqliteStorage(':memory:');
    for (const sql of SCHEMA) await db.run(sql);
    await db.run("INSERT INTO ts_wallets(account_ref,bucket,balance,held,updated_at) VALUES('acct-old','llm_tokens',400,0,'2026-01-01')");
    await db.run("INSERT INTO ts_ledger(id,account_ref,bucket,delta,kind,ref,created_at) VALUES('l1','acct-old','llm_tokens',1000,'grant','r1','2026-01-01')");
    await migrate(db);
    await migrate(db);
    expect(await db.first('SELECT balance,quota FROM ts_wallets')).toEqual({ balance: 400, quota: 1000 });
    expect(await db.first("SELECT value FROM ts_meta WHERE key='schema_version'")).toEqual({ value: '2' });
  });
  it('out of quota: the message names no token numbers, the fields still do', async () => {
    const h = await harness();
    const a = await h.account({ image_tokens: 3 });
    const e = ((await (await h.api(a.key, '/images/generations', { model: 'image-1', prompt: 'x', quality: 'high' })).json()) as any).error;
    expect(e).toMatchObject({ code: 'insufficient_tokens', balance: 3, needed: 4 });
    expect(e.message).toBe('your image tokens quota is used up for this request; top up in the AICW Store');
  });
});

describe('estimates', () => {
  it('follow the configured typical use and the price', async () => {
    const h = await harness({ buckets: { llm_tokens: { label: 'LLM tokens', estimate: { chat: { input: 1000, cacheRead: 9000, output: 500 } } }, image_tokens: { label: 'image tokens' }, video_tokens: { label: 'video tokens' }, voice_tokens: { label: 'voice tokens' } } });
    const m = (await (await h.f(BASE + WELL_KNOWN_PATH)).json()) as any;
    const est = Object.fromEntries(m.buckets.map((b: any) => [b.id, b.estimate]));
    expect(est.llm_tokens).toEqual({ unit: 'message', model: 'chat-1', each: 10_500 });
    expect(est.video_tokens).toEqual({ unit: 'video', model: 'video-1', each: 10, seconds: 5, resolution: '720p' });
    expect(est.voice_tokens).toEqual({ unit: 'speech', model: 'voice-1', each: 1 });
    expect(JSON.stringify(m)).not.toContain('"price"');
  });
});

describe('prices set by the Store', () => {
  it('are refused unless the operator allows it; anyone trusted may read them', async () => {
    const h = await harness();
    await expect(h.store.setPrice('image-1', { quality: { medium: 2 } })).rejects.toMatchObject({ status: 403, code: 'pricing_disabled' });
    await expect(h.store.setEstimate('image_tokens', { image: { quality: 'high' } })).rejects.toMatchObject({ status: 403 });
    const p = await h.store.prices();
    expect(p.editable).toBe(false);
    expect(p.models.find((x) => x.id === 'chat-1')).toMatchObject({ price: { input: 1, output: 1, cacheRead: 1, defaultHold: 16000 }, overridden: false });
    expect(p.log).toEqual([]);
  });
  it('a new price is charged on the next call, shows in the manifest and the estimate, and can be undone', async () => {
    const h = await harness({ allowStorePricing: true });
    const a = await h.account();
    const r = await h.store.setPrice('chat-1', { input: 0.5, output: 4, cacheRead: 0.1 }, 'October prices');
    expect(r.manifest.models.find((x) => x.id === 'chat-1')!.unit).toBe('per model token: input 0.5 · cached input 0.1 · output 4 tokens');
    expect(r.manifest.buckets.find((b) => b.id === 'llm_tokens')!.estimate!.each).toBe(6000 * 0.5 + 60000 * 0.1 + 2000 * 4);
    // The mock answers with prompt 10 / completion 20 / no cache.
    const before = (await h.store.balance(a.accountRef)).balances.llm_tokens;
    const chat = await h.api(a.key, '/chat/completions', { model: 'chat-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(200);
    const usage = ((await chat.json()) as any).usage;
    const after = (await h.store.balance(a.accountRef)).balances.llm_tokens;
    expect(before - after).toBe(Math.ceil(usage.prompt_tokens * 0.5 + usage.completion_tokens * 4));
    // Tables merge key by key; an unknown quality, a zero or a non-price field are refused.
    await h.store.setPrice('image-1', { quality: { high: 6 } });
    expect((await h.store.prices()).models.find((x) => x.id === 'image-1')!.price).toEqual({ quality: { low: 1, medium: 1, high: 6, auto: 1 }, edit: 0 });
    await expect(h.store.setPrice('image-1', { quality: { ultra: 9 } })).rejects.toMatchObject({ status: 400, code: 'invalid_price' });
    await expect(h.store.setPrice('chat-1', { output: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(h.store.setPrice('video-1', { maxSeconds: 60 })).rejects.toMatchObject({ status: 400 });
    await expect(h.store.setPrice('nope', { input: 1 })).rejects.toMatchObject({ status: 404 });
    await h.store.setPrice('chat-1', null, 'back to the file');
    const p = await h.store.prices();
    expect(p.models.find((x) => x.id === 'chat-1')).toMatchObject({ overridden: false, price: { input: 1, output: 1 } });
    expect(p.log.map((l) => [l.kind, l.target, l.value === null])).toEqual([['price', 'chat-1', true], ['price', 'image-1', false], ['price', 'chat-1', false]]);
  });
  it('an estimate profile can be changed and is checked', async () => {
    const h = await harness({ allowStorePricing: true });
    const r = await h.store.setEstimate('video_tokens', { video: { seconds: 4, resolution: '480p' } });
    expect(r.manifest.buckets.find((b) => b.id === 'video_tokens')!.estimate).toEqual({ unit: 'video', model: 'video-1', each: 4, seconds: 4, resolution: '480p' });
    await expect(h.store.setEstimate('video_tokens', { video: { seconds: 99, resolution: '480p' } })).rejects.toMatchObject({ code: 'invalid_estimate' });
    await expect(h.store.setEstimate('video_tokens', { chat: { input: 1, cacheRead: 1, output: 1 } })).rejects.toMatchObject({ code: 'invalid_estimate' });
    await expect(h.store.setEstimate('llm_tokens', { model: 'image-1' })).rejects.toMatchObject({ code: 'invalid_estimate' });
    await expect(h.store.setEstimate('nope', {})).rejects.toMatchObject({ code: 'unknown_bucket' });
    // The chat estimate may point at the embedding model of the same bucket.
    expect((await h.store.setEstimate('llm_tokens', { model: 'embed-1' })).manifest.buckets[0].estimate).toEqual({ unit: 'request', model: 'embed-1', each: 1000 });
  });
});
