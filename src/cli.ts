#!/usr/bin/env node
/**
 *   aicw-token-server init                 write token-server.json + .env.example here
 *   aicw-token-server start [--config f] [--port n] [--db file]
 *   aicw-token-server check <url> --key <file>      run the conformance check against a server
 *   aicw-token-server check --self [--config f]     start this config in memory and check it
 *   aicw-token-server keygen               make a test Store key pair for local checks
 *   aicw-token-server deploy cloudflare [--config f] [--env f] [--name n] [--account-id id]
 *                                          put the server online on your Cloudflare account (Workers + D1)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatReport, runConformance } from './check/suite.ts';
import { AICW_STORE_PUBLIC_KEYS, validateConfig } from './config.ts';
import { generateSigner, signerFromPkcs8 } from './crypto.ts';
import { loadConfigFile, startNodeServer } from './node.ts';
import { createTokenServer } from './server.ts';
import { spawn } from 'node:child_process';
import { deployCloudflare, DeployError, type WranglerRunner } from './deploy.ts';
import { migrate } from './storage.ts';
import { sqliteStorage } from './storage-sqlite.ts';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const configPath = () => resolve(flag('config') ?? process.env.AICW_TOKEN_SERVER_CONFIG ?? 'token-server.json');

const SAMPLE = {
  name: 'My AI Token Server',
  providerId: 'my-ai',
  keyPrefix: 'sk-my',
  publicUrl: 'https://tokens.example.com',
  trustedStoreKeys: AICW_STORE_PUBLIC_KEYS,
  buckets: {
    llm_tokens: { label: 'LLM tokens' },
    image_tokens: { label: 'image tokens' },
  },
  adapters: {
    openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  },
  models: [
    { id: 'gpt-5.6-sol', type: 'chat', bucket: 'llm_tokens', adapter: 'openai', unit: '1 token = 1 model token', price: { input: 1, output: 1, cacheRead: 1, defaultHold: 32000 } },
    { id: 'gpt-image-2', type: 'image', bucket: 'image_tokens', adapter: 'openai', unit: '1 token = 1 image (low/medium), 4 tokens = 1 high quality image', price: { quality: { low: 1, medium: 1, high: 4, auto: 1 }, edit: 1 } },
  ],
  limits: { requestsPerMinute: 60, maxOpenVideos: 3 },
};

async function main(): Promise<number> {
  if (command === 'init') {
    const file = configPath();
    if (existsSync(file) && !has('force')) {
      console.error(`${file} already exists (use --force to overwrite)`);
      return 1;
    }
    writeFileSync(file, JSON.stringify(SAMPLE, null, 2) + '\n');
    if (!existsSync('.env.example')) writeFileSync('.env.example', '# Upstream keys stay here, on your server. They are never sent to the AICW Store.\nOPENAI_API_KEY=\n');
    console.log(`Wrote ${file} and .env.example.\nNext: edit them, then\n  aicw-token-server check --self\n  aicw-token-server start`);
    return 0;
  }
  if (command === 'keygen') {
    const signer = await generateSigner();
    const file = resolve(flag('out') ?? 'test-store-key.txt');
    writeFileSync(file, signer.pkcs8 + '\n', { mode: 0o600 });
    console.log(`Private key (keep it local): ${file}\nPublic key: ${signer.publicKey}\n\nStart the server with this test key trusted:\n  AICW_EXTRA_STORE_KEYS=${signer.publicKey} aicw-token-server start\nThen:\n  aicw-token-server check http://127.0.0.1:8787 --key ${file}`);
    return 0;
  }
  if (command === 'start') {
    const config = loadConfigFile(configPath());
    const extra = (process.env.AICW_EXTRA_STORE_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!config.trustedStoreKeys.length && !extra.length) console.warn('warning: no trusted Store key — nobody can grant tokens or issue keys');
    if (extra.length) console.warn(`warning: ${extra.length} extra test Store key(s) trusted (AICW_EXTRA_STORE_KEYS). Do not set this in production.`);
    const running = await startNodeServer({ config, database: flag('db') ?? process.env.AICW_TOKEN_SERVER_DB, port: Number(flag('port') ?? process.env.PORT ?? 8787), extraStoreKeys: extra });
    console.log(`${config.name} listening on :${running.port} (public URL ${config.publicUrl})`);
    await new Promise(() => {});
    return 0;
  }
  if (command === 'check') {
    if (has('self')) {
      const { config, problems } = validateConfig(JSON.parse(readFileSync(configPath(), 'utf8')));
      if (problems.length) {
        console.error(`${configPath()} has problems:\n  - ${problems.join('\n  - ')}`);
        return 1;
      }
      const signer = await generateSigner();
      const storage = sqliteStorage(':memory:');
      await migrate(storage);
      const server = createTokenServer({ config: { ...config, trustedStoreKeys: [signer.publicKey] }, storage, env: process.env });
      const report = await runConformance({ url: 'http://self.test', signer, fetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(server.app.request(String(input).replace('http://self.test', ''), init))) as typeof fetch, pollMs: 200 });
      console.log(has('json') ? JSON.stringify(report, null, 2) : formatReport(report));
      return report.ok ? 0 : 1;
    }
    const url = args[1];
    const keyFile = flag('key');
    if (!url || url.startsWith('--') || !keyFile) {
      console.error('usage: aicw-token-server check <url> --key <private key file>   (or: check --self)');
      return 1;
    }
    const report = await runConformance({ url, signer: await signerFromPkcs8(readFileSync(keyFile, 'utf8').trim()) });
    console.log(has('json') ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.ok ? 0 : 1;
  }
  if (command === 'deploy') {
    if (args[1] !== 'cloudflare') {
      console.error('usage: aicw-token-server deploy cloudflare [--config token-server.json] [--env .env] [--name n] [--account-id id]');
      return 1;
    }
    const accountId = flag('account-id') ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    // wrangler 4 through npx: nothing to install by hand.
    const wrangler: WranglerRunner = (wargs, opts) =>
      new Promise((done) => {
        const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'wrangler@4', ...wargs], {
          cwd: opts.cwd,
          env: { ...process.env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), WRANGLER_SEND_METRICS: 'false' },
          stdio: opts.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (b) => (stdout += b));
        child.stderr?.on('data', (b) => (stderr += b));
        child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
        child.on('error', (e) => done({ code: 1, stdout, stderr: String(e) }));
      });
    try {
      await deployCloudflare({ configPath: configPath(), envPath: flag('env'), name: flag('name'), accountId, testStoreKey: flag('test-store-key'), wrangler });
      return 0;
    } catch (e) {
      console.error(e instanceof DeployError ? `\n${e.message}` : e);
      return 1;
    }
  }
  console.log('usage: aicw-token-server <init | start | check | keygen | deploy cloudflare>\n  init                      write token-server.json + .env.example\n  start [--port n] [--db f]  run the server\n  check --self              check this config in memory (no network, no upstream cost)\n  check <url> --key <file>  check a running server\n  keygen                    make a test Store key for local checks\n  deploy cloudflare         put it online on your Cloudflare account (Workers + D1, one command)');
  return command ? 1 : 0;
}
main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
