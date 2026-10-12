/** `deploy cloudflare` with a stand-in `cf`: the steps, the files it writes, the secrets, publicUrl. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployCloudflare, readEnvFile, type Runner } from '../src/deploy.ts';
import { sampleConfig } from './helpers.ts';

function project(over: Record<string, unknown> = {}, env = 'OPENAI_API_KEY=sk-test-123\n') {
  const dir = mkdtempSync(join(tmpdir(), 'aicw-deploy-'));
  const config = { ...sampleConfig(), publicUrl: 'https://tokens.example.com', adapters: { mock: { kind: 'mock' }, openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' } }, ...over };
  writeFileSync(join(dir, 'token-server.json'), JSON.stringify(config));
  if (env) writeFileSync(join(dir, '.env'), env);
  return dir;
}
function fakeCf(opts: { loggedIn?: boolean; existingDb?: boolean } = {}) {
  const calls: Array<{ tool: string; args: string[]; interactive?: boolean; secrets?: unknown; config?: string; worker?: string; pkg?: string }> = [];
  let loggedIn = opts.loggedIn ?? true;
  const run: Runner = async (tool, args, { cwd, interactive }) => {
    const call: (typeof calls)[number] = { tool, args, interactive };
    calls.push(call);
    if (tool === 'npm') { call.pkg = readFileSync(join(cwd, 'package.json'), 'utf8'); return { code: 0, stdout: '', stderr: '' }; }
    const a = args.join(' ');
    if (a === 'auth whoami') return { code: 0, stdout: JSON.stringify({ authenticated: loggedIn, tokenValid: loggedIn }), stderr: '' };
    if (a === 'auth login') { loggedIn = true; return { code: 0, stdout: 'Successfully logged in', stderr: '' }; }
    if (a === 'd1 list') return { code: 0, stdout: JSON.stringify(opts.existingDb ? [{ name: 'aicw-tokens-test-tokens', uuid: '99999999-2222-3333-4444-555555555555' }] : []), stderr: '' };
    if (a.startsWith('d1 create')) return { code: 0, stdout: JSON.stringify({ uuid: '11111111-2222-3333-4444-555555555555', name: args[3] }), stderr: '' };
    if (a === 'deploy --mode production') { call.config = readFileSync(join(cwd, 'cloudflare.config.ts'), 'utf8'); call.worker = readFileSync(join(cwd, 'worker.ts'), 'utf8'); return { code: 0, stdout: '│  Deployed aicw-tokens-test-tokens triggers\n│    https://aicw-tokens-test-tokens.acme.workers.dev\n◆  Deploy complete', stderr: '' }; }
    if (a.startsWith('workers secrets bulk')) { const body = JSON.parse(readFileSync(args[args.indexOf('--file') + 1], 'utf8')); call.secrets = body; return { code: 0, stdout: JSON.stringify(Object.fromEntries(Object.keys(body.secrets).map((k) => [k, { name: k, type: 'secret_text' }]))), stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected ' + a };
  };
  return { run, calls };
}
const answering = (async () => Response.json({ providerId: 'test-tokens', protocol: 1 })) as unknown as typeof fetch;

describe('deploy cloudflare (cf)', () => {
  it('installs cf, logs in when needed, creates the database, deploys, writes the real address back, sets the keys as secrets', async () => {
    const dir = project();
    const w = fakeCf({ loggedIn: false });
    const lines: string[] = [];
    const r = await deployCloudflare({ configPath: join(dir, 'token-server.json'), run: w.run, fetch: answering, log: (l) => lines.push(l) });
    expect(r).toEqual({ url: 'https://aicw-tokens-test-tokens.acme.workers.dev', name: 'aicw-tokens-test-tokens', databaseId: '11111111-2222-3333-4444-555555555555' });
    expect(w.calls.map((c) => c.tool + ' ' + c.args.slice(0, 2).join(' '))).toEqual(['npm install --no-audit', 'cf auth whoami', 'cf auth login', 'cf auth whoami', 'cf d1 list', 'cf d1 create', 'cf deploy --mode', 'cf deploy --mode', 'cf workers secrets']);
    expect(JSON.parse(w.calls[0].pkg!).devDependencies).toEqual({ cf: '1.0.0-beta.14', wrangler: '4.149.0' });
    expect(w.calls[2].interactive).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'token-server.json'), 'utf8')).publicUrl).toBe(r.url);
    const deployed = w.calls.filter((c) => c.args[0] === 'deploy')[1];
    expect(deployed.config).toContain('DB: bindings.d1({ name: "aicw-tokens-test-tokens", id: "11111111-2222-3333-4444-555555555555" })');
    expect(deployed.config).toContain('workersDev: true');
    expect(deployed.config).toContain('triggers.scheduled({ schedule: "*/5 * * * *" })');
    expect(deployed.config).not.toContain('AICW_EXTRA_STORE_KEYS');
    expect(deployed.worker).toMatch(/import \{ createWorker \} from '.*src\/worker\.ts';\nimport config from '\.\.\/token-server\.json';\nexport default createWorker\(config\);/);
    expect(w.calls.at(-1)!.secrets).toEqual({ secrets: { OPENAI_API_KEY: { type: 'secret_text', name: 'OPENAI_API_KEY', text: 'sk-test-123' } } });
    expect(existsSync(join(dir, '.aicw-deploy', '.secrets.json'))).toBe(false);
    expect(lines.at(-1)).toContain('Next: register it in the AICW Store');
  });
  it('reuses an existing database, deploys once when publicUrl is already right, adds a test key only when asked', async () => {
    const dir = project({ publicUrl: 'https://aicw-tokens-test-tokens.acme.workers.dev' });
    const w = fakeCf({ existingDb: true });
    const r = await deployCloudflare({ configPath: join(dir, 'token-server.json'), run: w.run, fetch: answering, log: () => {}, testStoreKey: 'PUBKEY=' });
    expect(r.databaseId).toBe('99999999-2222-3333-4444-555555555555');
    const deploys = w.calls.filter((c) => c.args[0] === 'deploy');
    expect(deploys).toHaveLength(1);
    expect(deploys[0].config).toContain('AICW_EXTRA_STORE_KEYS: bindings.text("PUBKEY=")');
    expect(w.calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'login')).toBe(false);
  });
  it('stops before touching Cloudflare when a key is missing or the config is broken', async () => {
    const w = fakeCf();
    await expect(deployCloudflare({ configPath: join(project({}, ''), 'token-server.json'), run: w.run, fetch: answering, log: () => {} })).rejects.toThrow('put these keys in .env first: OPENAI_API_KEY');
    await expect(deployCloudflare({ configPath: join(project({ providerId: 'Bad Id' }), 'token-server.json'), run: w.run, fetch: answering, log: () => {} })).rejects.toThrow('providerId');
    expect(w.calls).toEqual([]);
  });
  it('reads .env files the usual way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aicw-env-'));
    writeFileSync(join(dir, '.env'), '# comment\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line\n');
    expect(readEnvFile(join(dir, '.env'))).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});
