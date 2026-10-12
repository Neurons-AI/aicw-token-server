/**
 * `aicw-token-server deploy cloudflare`: one command from token-server.json + .env to a live server
 * on the developer's own Cloudflare account (Workers + D1; the free plan covers a small shop), with
 * the Cloudflare CLI `cf` (https://developers.cloudflare.com/cf/).
 *
 * Made for an AI agent driving it for a non-technical developer: the only thing a person does is
 * approve the Cloudflare login once in the browser (`cf auth login`, a one-time code). For a machine
 * nobody sits at, set CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) instead. The provider keys go
 * from .env to Worker secrets; they stay in the developer's account, nobody else holds them.
 *
 *   1. .aicw-deploy/ with cf + its bundler (npm install, pinned)   5. publicUrl written back (+ redeploy)
 *   2. cf auth whoami (login when needed)                         6. provider keys → Worker secrets
 *   3. D1 database (reused by name, else created)                 7. the manifest answers
 *   4. cloudflare.config.ts + worker.ts → cf deploy
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.ts';
import { WELL_KNOWN_PATH } from './protocol.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `cf <args>` or `npm <args>` in `cwd` (interactive: a person may need to act, e.g. the login). */
export type Runner = (tool: 'cf' | 'npm', args: string[], opts: { cwd: string; interactive?: boolean }) => Promise<RunResult>;
export interface DeployOptions {
  configPath: string;
  envPath?: string;
  /** Worker and database name (default aicw-tokens-<providerId>). */
  name?: string;
  accountId?: string;
  /** Trust an extra Store key: ONLY for a conformance check of a test deployment. */
  testStoreKey?: string;
  run: Runner;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}
export class DeployError extends Error {}
const LIBRARY_SRC = dirname(fileURLToPath(import.meta.url));
/** Pinned: cf is in beta, and its project commands bundle with wrangler. */
export const CF_VERSION = '1.0.0-beta.14';
export const WRANGLER_VERSION = '4.149.0';

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const text = (r: RunResult) => `${r.stdout}\n${r.stderr}`;
const json = <T>(r: RunResult): T | null => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
};
const q = (s: string) => JSON.stringify(s);

export async function deployCloudflare(o: DeployOptions): Promise<{ url: string; name: string; databaseId: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const configPath = resolve(o.configPath);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const { config, problems } = validateConfig(raw);
  if (problems.length) throw new DeployError(`${configPath} has problems:\n  - ${problems.join('\n  - ')}`);
  const name = (o.name ?? `aicw-tokens-${config.providerId}`).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new DeployError(`name "${name}": lowercase letters, digits and dashes`);
  // Every upstream key an adapter names must be in .env (or the environment).
  const env = { ...process.env, ...readEnvFile(resolve(o.envPath ?? join(dirname(configPath), '.env'))) } as Record<string, string | undefined>;
  const secretNames = [...new Set(Object.values(config.adapters).map((a) => a.apiKeyEnv).filter((x): x is string => !!x))];
  const missing = secretNames.filter((k) => !env[k]);
  if (missing.length) throw new DeployError(`put these keys in .env first: ${missing.join(', ')}`);

  const deployDir = join(dirname(configPath), '.aicw-deploy');
  mkdirSync(deployDir, { recursive: true });
  const cf = (args: string[], interactive = false) => o.run('cf', args, { cwd: deployDir, interactive });

  log('1/7 Preparing the Cloudflare CLI…');
  writeFileSync(join(deployDir, 'package.json'), JSON.stringify({ private: true, type: 'module', devDependencies: { cf: CF_VERSION, wrangler: WRANGLER_VERSION } }, null, 2) + '\n');
  const install = await o.run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: deployDir });
  if (install.code !== 0) throw new DeployError(`installing the Cloudflare CLI failed:\n${text(install).trim().slice(-800)}`);

  log('2/7 Cloudflare account…');
  const signedIn = async () => {
    const r = await cf(['auth', 'whoami']);
    return r.code === 0 && json<{ authenticated?: boolean }>(r)?.authenticated === true;
  };
  if (!(await signedIn())) {
    log('    Approve the Cloudflare login in the browser window that opens (one time).');
    const login = await cf(['auth', 'login'], true);
    if (login.code !== 0 || !(await signedIn())) throw new DeployError('Cloudflare login did not finish: run the command again and approve the login in the browser');
  }

  log(`3/7 Database ${name}…`);
  const list = await cf(['d1', 'list']);
  let databaseId = (json<Array<{ name: string; uuid: string }>>(list) ?? []).find((d) => d.name === name)?.uuid ?? '';
  if (!databaseId) {
    const created = await cf(['d1', 'create', '--name', name]);
    databaseId = json<{ uuid?: string }>(created)?.uuid ?? '';
    if (!databaseId) throw new DeployError(`could not create the D1 database "${name}":\n${text(created).trim().slice(0, 800)}`);
  }

  const writeFiles = () => {
    const lib = relative(deployDir, join(LIBRARY_SRC, 'worker.ts')).split('\\').join('/');
    const cfg = relative(deployDir, configPath).split('\\').join('/');
    writeFileSync(join(deployDir, 'worker.ts'), `// Generated by aicw-token-server deploy cloudflare. Do not edit: change token-server.json and deploy again.\nimport { createWorker } from '${lib.startsWith('.') ? lib : './' + lib}';\nimport config from '${cfg.startsWith('.') ? cfg : './' + cfg}';\nexport default createWorker(config);\n`);
    writeFileSync(
      join(deployDir, 'cloudflare.config.ts'),
      [
        '// Generated by aicw-token-server deploy cloudflare (Cloudflare CLI `cf`).',
        'import { bindings, defineConfig, triggers } from "cf/config";',
        '',
        'export default defineConfig({',
        ...(o.accountId ? [`\taccountId: ${q(o.accountId)},`] : []),
        '\tworker: {',
        `\t\tname: ${q(name)},`,
        '\t\tcompatibilityDate: "2026-04-01",',
        '\t\tcompatibilityFlags: ["nodejs_compat"],',
        '\t\tentrypoint: "worker.ts",',
        '\t\tworkersDev: true,',
        '\t\ttriggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],',
        '\t\tenv: {',
        `\t\t\tDB: bindings.d1({ name: ${q(name)}, id: ${q(databaseId)} }),`,
        ...(o.testStoreKey ? [`\t\t\tAICW_EXTRA_STORE_KEYS: bindings.text(${q(o.testStoreKey)}),`] : []),
        '\t\t},',
        '\t},',
        '});',
        '',
      ].join('\n')
    );
  };
  const deploy = async () => {
    writeFiles();
    const r = await cf(['deploy', '--mode', 'production']);
    if (r.code !== 0) throw new DeployError(`cf deploy failed:\n${text(r).trim().slice(-1500)}`);
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(text(r))?.[0];
    if (!url) throw new DeployError(`deployed, but the address was not in the output:\n${text(r).trim().slice(-800)}`);
    return url;
  };

  log('4/7 Deploying the Worker…');
  let url = await deploy();
  if (config.publicUrl.replace(/\/+$/, '') !== url) {
    log(`5/7 publicUrl → ${url} (written to ${configPath})`);
    writeFileSync(configPath, JSON.stringify({ ...raw, publicUrl: url }, null, 2) + '\n');
    url = await deploy();
  } else log('5/7 publicUrl already right');

  log(`6/7 ${secretNames.length} provider key(s) → Worker secrets…`);
  if (secretNames.length) {
    // A file, not an argument: keys never show up in the process list.
    const file = join(deployDir, '.secrets.json');
    writeFileSync(file, JSON.stringify({ secrets: Object.fromEntries(secretNames.map((k) => [k, { type: 'secret_text', name: k, text: env[k] }])) }), { mode: 0o600 });
    try {
      const r = await cf(['workers', 'secrets', 'bulk', '--worker', name, '--file', file]);
      const set = json<Record<string, unknown>>(r) ?? {};
      if (r.code !== 0 || secretNames.some((k) => !(k in set))) throw new DeployError(`setting the secrets failed:\n${text(r).trim().slice(-800)}`);
    } finally {
      rmSync(file, { force: true });
    }
  }

  log('7/7 Checking it answers…');
  const f = o.fetch ?? fetch;
  let manifest: { providerId?: string } | null = null;
  for (let i = 0; i < 20 && !manifest; i++) {
    try {
      const res = await f(url + WELL_KNOWN_PATH, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) manifest = (await res.json()) as { providerId?: string };
    } catch {
      /* a new workers.dev name takes a few seconds */
    }
    if (!manifest) await new Promise((r) => setTimeout(r, 3000));
  }
  if (manifest?.providerId !== config.providerId) throw new DeployError(`deployed at ${url}, but it does not answer yet: try ${url}/healthz in a minute`);
  log(`\nLive: ${url}\nNext: register it in the AICW Store (Developer → AI Token servers → ${url}), or ask the agent to.`);
  return { url, name, databaseId };
}
