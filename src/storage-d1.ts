import type { RunResult, Statement, Storage } from './storage.ts';

/** The slice of Cloudflare's D1Database this adapter uses (no dependency on workers-types). */
interface D1Prepared {
  bind(...args: unknown[]): D1Prepared;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Prepared;
  batch(statements: D1Prepared[]): Promise<Array<{ meta?: { changes?: number } }>>;
}
export function d1Storage(db: D1Like): Storage {
  const prep = (sql: string, args: unknown[] = []) => db.prepare(sql).bind(...args);
  const changes = (r: { meta?: { changes?: number } }): RunResult => ({ changes: r.meta?.changes ?? 0 });
  return {
    run: async (sql, ...args) => changes(await prep(sql, args).run()),
    first: <T>(sql: string, ...args: unknown[]) => prep(sql, args).first<T>(),
    all: async <T>(sql: string, ...args: unknown[]) => (await prep(sql, args).all<T>()).results,
    batch: async (statements: Statement[]) => (await db.batch(statements.map((s) => prep(s.sql, s.args)))).map(changes),
  };
}
