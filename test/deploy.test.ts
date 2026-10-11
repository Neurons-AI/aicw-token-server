/** `deploy cloudflare` with a stand-in wrangler: the steps, the files it writes, the secrets, publicUrl. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployCloudflare, readEnvFile, type WranglerRunner } from '../src/deploy.ts';
import { sampleConfig } from './helpers.ts';

function project(over: Record<string, unknown> = {}, env = 'OPENAI_API_KEY=sk-test-123\n') {
  const dir = mkdtempSync(join(tmpdir(), 'aicw-deploy-'));
  const config = { ...sampleConfig(), publicUrl: 'https://tokens.example.com', adapters: { mock: { kind: 'mock' }, openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' } }, ...over };
  writeFileSync(join(dir, 'token-server.json'), JSON.stringify(config));
  if (env) writeFileSync(join(dir, '.env'), env);
  return dir;
}
function fakeWrangler(opts: { loggedIn?: boolean; existingDb?: boolean } = {}) {
  const calls: Array<{ args: string[]; interactive?: boolean; secrets?: unknown; files?: Record<string, string> }> = [];
  let loggedIn = opts.loggedIn ?? true;
  const run: WranglerRunner = async (args, { cwd, interactive }) => {
    const call: (typeof calls)[number] = { args, interactive };
    calls.push(call);
    if (args[0] === 'whoami') return loggedIn ? { code: 0, stdout: 'You are logged in with an OAuth Token', stderr: 'WARNING Wrangler is missing some expected Oauth scopes. To fix this, run `wrangler login`' } : { code: 1, stdout: '', stderr: 'You are not authenticated. Please run `wrangler login`.' };
    if (args[0] === 'login') { loggedIn = true; return { code: 0, stdout: 'Successfully logged in.', stderr: '' }; }
    if (args[0] === 'd1' && args[1] === 'create') return opts.existingDb ? { code: 1, stdout: '', stderr: 'A database with that name already exists' } : { code: 0, stdout: '{\n "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "11111111-2222-3333-4444-555555555555" }]\n}', stderr: '' };
    if (args[0] === 'd1' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ name: 'aicw-tokens-test-tokens', uuid: '99999999-2222-3333-4444-555555555555' }]), stderr: '' };
    if (args[0] === 'deploy') { call.files = { toml: readFileSync(join(cwd, 'wrangler.toml'), 'utf8'), worker: readFileSync(join(cwd, 'worker.ts'), 'utf8') }; return { code: 0, stdout: 'Uploaded aicw-tokens-test-tokens\nDeployed aicw-tokens-test-tokens triggers\n  https://aicw-tokens-test-tokens.acme.workers.dev\n', stderr: '' }; }
    if (args[0] === 'secret') { call.secrets = JSON.parse(readFileSync(args[2], 'utf8')); return { code: 0, stdout: 'Finished processing secrets', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' ') };
  };
  return { run, calls };
}
const answering = (async () => Response.json({ providerId: 'test-tokens', protocol: 1 })) as unknown as typeof fetch;

describe('deploy cloudflare', () => {
  it('logs in when needed, creates the database, deploys, writes the real address back, then sets the keys as secrets', async () => {
    const dir = project();
    const w = fakeWrangler({ loggedIn: false });
    const lines: string[] = [];
    const r = await deployCloudflare({ configPath: join(dir, 'token-server.json'), wrangler: w.run, fetch: answering, log: (l) => lines.push(l) });
    expect(r).toEqual({ url: 'https://aicw-tokens-test-tokens.acme.workers.dev', name: 'aicw-tokens-test-tokens', databaseId: '11111111-2222-3333-4444-555555555555' });
    expect(w.calls.map((c) => c.args[0] + (c.args[1] && !c.args[1].startsWith('/') ? ' ' + c.args[1] : ''))).toEqual(['whoami', 'login', 'whoami', 'd1 create', 'deploy', 'deploy', 'secret bulk']);
    expect(w.calls[1].interactive).toBe(true);
    // The address Cloudflare gave is now the server's publicUrl (and the second deploy carries it).
    expect(JSON.parse(readFileSync(join(dir, 'token-server.json'), 'utf8')).publicUrl).toBe(r.url);
    const deployed = w.calls.filter((c) => c.args[0] === 'deploy')[1].files!;
    expect(deployed.toml).toContain('database_id = "11111111-2222-3333-4444-555555555555"');
    expect(deployed.toml).toContain('crons = ["*/5 * * * *"]');
    expect(deployed.toml).not.toContain('AICW_EXTRA_STORE_KEYS');
    expect(deployed.worker).toMatch(/import \{ createWorker \} from '.*src\/worker\.ts';\nimport config from '\.\.\/token-server\.json';\nexport default createWorker\(config\);/);
    // The key went to Cloudflare as a secret; the temporary file is gone.
    expect(w.calls.find((c) => c.args[0] === 'secret')!.secrets).toEqual({ OPENAI_API_KEY: 'sk-test-123' });
    expect(existsSync(join(dir, '.aicw-deploy', '.secrets.json'))).toBe(false);
    expect(lines.at(-1)).toContain('Next: register it in the AICW Store');
  });
  it('reuses an existing database, deploys once when publicUrl is already right', async () => {
    const dir = project({ publicUrl: 'https://aicw-tokens-test-tokens.acme.workers.dev' });
    const w = fakeWrangler({ existingDb: true });
    const r = await deployCloudflare({ configPath: join(dir, 'token-server.json'), wrangler: w.run, fetch: answering, log: () => {} });
    expect(r.databaseId).toBe('99999999-2222-3333-4444-555555555555');
    expect(w.calls.filter((c) => c.args[0] === 'deploy')).toHaveLength(1);
  });
  it('stops before touching Cloudflare when a key is missing or the config is broken', async () => {
    const w = fakeWrangler();
    await expect(deployCloudflare({ configPath: join(project({}, ''), 'token-server.json'), wrangler: w.run, fetch: answering, log: () => {} })).rejects.toThrow('put these keys in .env first: OPENAI_API_KEY');
    await expect(deployCloudflare({ configPath: join(project({ providerId: 'Bad Id' }), 'token-server.json'), wrangler: w.run, fetch: answering, log: () => {} })).rejects.toThrow('providerId');
    expect(w.calls).toEqual([]);
  });
  it('reads .env files the usual way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aicw-env-'));
    writeFileSync(join(dir, '.env'), '# comment\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line\n');
    expect(readEnvFile(join(dir, '.env'))).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});
