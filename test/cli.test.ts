/** The CLI as a developer runs it: init, start over real HTTP with a SQLite file, check by URL. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CLI = resolve(import.meta.dirname, '../src/cli.ts');
const dir = mkdtempSync(join(tmpdir(), 'aicw-token-server-'));
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
const children: Array<{ kill(): void }> = [];
afterAll(() => children.forEach((c) => c.kill()));

describe('cli', () => {
  it('init writes a config that passes the self check', () => {
    const init = run(['init']);
    expect(init.status, init.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, 'token-server.json'), 'utf8'));
    expect(config.trustedStoreKeys).toHaveLength(1);
    expect(run(['init']).status).toBe(1);
    const check = run(['check', '--self']);
    expect(check.stdout).toContain('PASS:');
    expect(check.status, check.stdout + check.stderr).toBe(0);
  });
  it('a broken config is explained, not crashed on', () => {
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ name: 'x' }));
    const out = run(['check', '--self', '--config', 'broken.json']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('providerId:');
  });
  it('start serves over HTTP and a check by URL passes with a trusted test key', async () => {
    const keygen = run(['keygen']);
    expect(keygen.status, keygen.stderr).toBe(0);
    const publicKey = keygen.stdout.match(/Public key: (\S+)/)![1];
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'start', '--port', '0', '--db', join(dir, 'tokens.db')], { cwd: dir, env: { ...process.env, AICW_EXTRA_STORE_KEYS: publicKey } });
    children.push(child);
    const port = await new Promise<number>((ok, fail) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/listening on :(\d+)/);
        if (m) ok(Number(m[1]));
      });
      child.on('exit', (code) => fail(new Error(`server exited ${code}: ${out}`)));
      setTimeout(() => fail(new Error('server did not start: ' + out)), 15000);
    });
    const url = `http://127.0.0.1:${port}`;
    expect((await fetch(url + '/healthz')).status).toBe(200);
    const check = run(['check', url, '--key', 'test-store-key.txt', '--json']);
    const report = JSON.parse(check.stdout);
    expect(report.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
    expect(check.status).toBe(0);
    // A key the server does not trust is refused.
    run(['keygen', '--out', 'other-key.txt']);
    expect(run(['check', url, '--key', 'other-key.txt']).status).toBe(1);
  });
});
