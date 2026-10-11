/**
 * `aicw-token-server deploy cloudflare`: one command from token-server.json + .env to a live server
 * on the developer's own Cloudflare account (Workers + D1; the free plan covers a small shop).
 *
 * Made for an AI agent driving it for a non-technical developer: the only thing a person does is
 * log in to Cloudflare once in the browser (wrangler opens it). The provider keys go from .env to
 * Worker secrets; they stay in the developer's account, nobody else holds them.
 *
 *   1. wrangler whoami (login when needed)       5. upstream keys → Worker secrets
 *   2. D1 database (created or reused)           6. publicUrl written back to token-server.json
 *   3. .aicw-deploy/{wrangler.toml, worker.ts}   7. /healthz + manifest answer
 *   4. wrangler deploy
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.ts';
import { WELL_KNOWN_PATH } from './protocol.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `wrangler <args>` (interactive: the person may need to answer, e.g. the browser login). */
export type WranglerRunner = (args: string[], opts: { cwd: string; interactive?: boolean }) => Promise<RunResult>;
export interface DeployOptions {
  configPath: string;
  envPath?: string;
  /** Worker and database name (default aicw-tokens-<providerId>). */
  name?: string;
  accountId?: string;
  /** Trust an extra Store key: ONLY for a conformance check of a test deployment. */
  testStoreKey?: string;
  wrangler: WranglerRunner;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}
export class DeployError extends Error {}
const LIBRARY_SRC = dirname(fileURLToPath(import.meta.url));

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
  const run = (args: string[], interactive = false) => o.wrangler(args, { cwd: deployDir, interactive });

  log('1/6 Cloudflare account…');
  let who = await run(['whoami']);
  // Only a clear "not logged in": a logged-in whoami may still advise `wrangler login` for extra scopes.
  if (who.code !== 0 || /not authenticated|You are not logged in/i.test(text(who))) {
    log('    Log in to Cloudflare in the browser window that opens (one time).');
    const login = await run(['login'], true);
    if (login.code !== 0) throw new DeployError('Cloudflare login did not finish: run the command again and complete the login in the browser');
    who = await run(['whoami']);
    if (who.code !== 0) throw new DeployError('still not logged in to Cloudflare');
  }

  log(`2/6 Database ${name}…`);
  let databaseId = '';
  const created = await run(['d1', 'create', name]);
  const idIn = (s: string) => /database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i.exec(s)?.[1] ?? '';
  databaseId = idIn(text(created));
  if (!databaseId) {
    const list = await run(['d1', 'list', '--json']);
    try {
      const found = (JSON.parse(list.stdout) as Array<{ name: string; uuid: string }>).find((d) => d.name === name);
      databaseId = found?.uuid ?? '';
    } catch {
      /* fall through to the error */
    }
  }
  if (!databaseId) throw new DeployError(`could not create or find the D1 database "${name}":\n${text(created).trim().slice(0, 800)}`);

  const writeFiles = () => {
    const lib = relative(deployDir, join(LIBRARY_SRC, 'worker.ts')).split('\\').join('/');
    const cfg = relative(deployDir, configPath).split('\\').join('/');
    writeFileSync(join(deployDir, 'worker.ts'), `// Generated by aicw-token-server deploy cloudflare. Do not edit: change token-server.json and deploy again.\nimport { createWorker } from '${lib.startsWith('.') ? lib : './' + lib}';\nimport config from '${cfg.startsWith('.') ? cfg : './' + cfg}';\nexport default createWorker(config);\n`);
    writeFileSync(
      join(deployDir, 'wrangler.toml'),
      [
        '# Generated by aicw-token-server deploy cloudflare.',
        `name = "${name}"`,
        'main = "worker.ts"',
        'compatibility_date = "2026-04-01"',
        'compatibility_flags = ["nodejs_compat"]',
        'workers_dev = true',
        ...(o.accountId ? [`account_id = "${o.accountId}"`] : []),
        ...(o.testStoreKey ? ['[vars]', `AICW_EXTRA_STORE_KEYS = "${o.testStoreKey}"`] : []),
        '[[d1_databases]]',
        'binding = "DB"',
        `database_name = "${name}"`,
        `database_id = "${databaseId}"`,
        '[triggers]',
        'crons = ["*/5 * * * *"]',
        '',
      ].join('\n')
    );
  };
  const deploy = async () => {
    writeFiles();
    const r = await run(['deploy']);
    if (r.code !== 0) throw new DeployError(`wrangler deploy failed:\n${text(r).trim().slice(-1500)}`);
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(text(r))?.[0];
    if (!url) throw new DeployError(`deployed, but the address was not in the output:\n${text(r).trim().slice(-800)}`);
    return url;
  };

  log('3/6 Deploying the Worker…');
  let url = await deploy();
  if (config.publicUrl.replace(/\/+$/, '') !== url) {
    log(`4/6 publicUrl → ${url} (written to ${configPath})`);
    writeFileSync(configPath, JSON.stringify({ ...raw, publicUrl: url }, null, 2) + '\n');
    url = await deploy();
  } else log('4/6 publicUrl already right');

  log(`5/6 ${secretNames.length} provider key(s) → Worker secrets…`);
  if (secretNames.length) {
    const file = join(deployDir, '.secrets.json');
    writeFileSync(file, JSON.stringify(Object.fromEntries(secretNames.map((k) => [k, env[k]]))), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
      const r = await run(['secret', 'bulk', file]);
      if (r.code !== 0) throw new DeployError(`setting the secrets failed:\n${text(r).trim().slice(-800)}`);
    } finally {
      rmSync(file, { force: true });
    }
  }

  log('6/6 Checking it answers…');
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
