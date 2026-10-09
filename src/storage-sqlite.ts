import { DatabaseSync } from 'node:sqlite';
import type { RunResult, Statement, Storage } from './storage.ts';

/** A SQLite file on the server's own disk (Node 22.5+ ships the driver). `:memory:` for tests. */
export function sqliteStorage(file: string): Storage & { close(): void } {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const norm = (args: unknown[]) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as never[];
  const run = (sql: string, args: unknown[] = []): RunResult => ({ changes: Number(db.prepare(sql).run(...norm(args)).changes) });
  return {
    run: async (sql, ...args) => run(sql, args),
    first: async <T>(sql: string, ...args: unknown[]) => (db.prepare(sql).get(...norm(args)) as T | undefined) ?? null,
    all: async <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...norm(args)) as T[],
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((s) => run(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}
