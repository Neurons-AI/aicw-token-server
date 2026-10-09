/**
 * The only thing the server needs from a database: run SQLite statements, alone or as one
 * atomic batch. Cloudflare D1 and a local SQLite file both fit, so the wallet logic is
 * written once, as SQL.
 */
export interface Statement {
  sql: string;
  args?: unknown[];
}
export interface RunResult {
  changes: number;
}
export interface Storage {
  run(sql: string, ...args: unknown[]): Promise<RunResult>;
  first<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]>;
  /** All statements commit together or not at all; returns the change count of each. */
  batch(statements: Statement[]): Promise<RunResult[]>;
}
export const st = (sql: string, ...args: unknown[]): Statement => ({ sql, args });

/** Every table is prefixed `ts_`, so the server can share a database with something else. */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS ts_accounts(
     ref TEXT PRIMARY KEY, test INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ts_keys(
     id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, device_ref TEXT,
     key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
     created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS ts_keys_account ON ts_keys(account_ref, status)`,
  `CREATE TABLE IF NOT EXISTS ts_wallets(
     account_ref TEXT NOT NULL, bucket TEXT NOT NULL,
     balance INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
     PRIMARY KEY(account_ref, bucket))`,
  `CREATE TABLE IF NOT EXISTS ts_ledger(
     id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, bucket TEXT NOT NULL, delta INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('grant','refund','adjust')),
     ref TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, UNIQUE(kind, ref, bucket))`,
  `CREATE INDEX IF NOT EXISTS ts_ledger_account ON ts_ledger(account_ref, created_at)`,
  `CREATE TABLE IF NOT EXISTS ts_receipts(
     receipt_id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, sku TEXT NOT NULL, order_ref TEXT NOT NULL,
     grants_json TEXT NOT NULL, created_at TEXT NOT NULL, refunded_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ts_requests(
     id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, key_id TEXT NOT NULL,
     kind TEXT NOT NULL, model TEXT NOT NULL, bucket TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('held','done','released')),
     hold INTEGER NOT NULL, charged INTEGER, usage_json TEXT,
     upstream_id TEXT, upstream_ref TEXT, error TEXT, created_at TEXT NOT NULL, done_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS ts_requests_account ON ts_requests(account_ref, created_at)`,
  `CREATE INDEX IF NOT EXISTS ts_requests_open ON ts_requests(status, kind, created_at)`,
  `CREATE TABLE IF NOT EXISTS ts_rate(key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at TEXT NOT NULL)`,
];
export async function migrate(db: Storage): Promise<void> {
  for (const sql of SCHEMA) await db.run(sql);
}
