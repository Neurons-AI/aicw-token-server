# aicw-token-server

Sell AI tokens to AI Coworker users from a server **you** run. Your model provider keys stay on
your server; the AICW Store never receives them. The Store sells your token packs (also inside
combos and as in-app purchases), takes the payment, and tells your server what to grant. The
desktop app then calls your server with a per-device key, through an OpenAI-compatible API.

```
buyer ── pays ──▶ AICW Store ── signed "grant 100 tokens" ──▶ your token server ──▶ your model provider
AI Coworker app ── Bearer sk-yourprefix-… (one key per device) ──▶ your token server
```

## Quick start (10 minutes)

> Not on npm yet: run it from a clone (`git clone https://github.com/Neurons-AI/aicw-token-server ~/aicw-token-server && cd ~/aicw-token-server && pnpm install`) as `node src/cli.ts <command>`. Node 22.18 or newer (it runs the TypeScript sources directly).
>
> Not technical? Ask the agent in AI Coworker: "sell tokens for my app with my own server". It does
> every step below; you only log in to Cloudflare once and click "Allow" in the app.

```bash
mkdir my-tokens && cd my-tokens
node ~/aicw-token-server/src/cli.ts init                # token-server.json + .env.example
# edit token-server.json (name, providerId, buckets, models, prices) and put your keys in .env
node ~/aicw-token-server/src/cli.ts check --self        # the full conformance check in memory, costs nothing
node ~/aicw-token-server/src/cli.ts deploy cloudflare   # online in a minute, see "Deploy"
```

Then in the AICW Store: **Developer → AI Token servers → Add and check** with the address it printed.
The Store runs the same conformance check against your URL (again every week; three failed weeks in
a row stop your packs from selling). Then create **Token packs** that grant tokens from your buckets.

## Deploy

### Cloudflare (recommended: one command, free plan is enough to start)

```bash
node ~/aicw-token-server/src/cli.ts deploy cloudflare [--name my-tokens] [--account-id <id>]
```

It logs you in to Cloudflare (a browser window, once), creates a D1 database for the wallets, deploys
a Worker named `aicw-tokens-<providerId>`, stores every key your adapters name (`apiKeyEnv`, read
from `.env`) as Worker secrets, writes the `https://….workers.dev` address into `publicUrl`, and
checks that it answers. Run it again after changing prices, models or keys. It writes
`.aicw-deploy/` next to your config (keep it out of git with `.env`). The tables are created on the
first request, so there is no migration step; D1 keeps a point-in-time history of the wallets
(7 days on the free plan, 30 on a paid one). The Worker entry is `src/worker.ts`
(`export default createWorker(config)`) if you prefer your own wrangler setup.

### Your own machine or VPS (Docker or Node)

```bash
node ~/aicw-token-server/src/cli.ts start --port 8787     # SQLite file token-server.db next to it
# or: docker build -t aicw-token-server . && docker run -v $PWD:/data --env-file .env -p 8787:8787 aicw-token-server
```

The Store only talks to `https://`. Put it behind HTTPS at your `publicUrl`:
- **Caddy** (automatic certificates): `tokens.example.com { reverse_proxy 127.0.0.1:8787 }`
- **Cloudflare Tunnel** (no open port): `cloudflared tunnel --url http://127.0.0.1:8787`, then a named tunnel for a fixed hostname.

Back up `token-server.db` daily (it is your customers' wallets) and keep the process running
(systemd, `docker run --restart=always`).

## token-server.json

| Field | Meaning |
|---|---|
| `name` | What buyers see ("Acme Voice"). |
| `providerId` | How the app files your server: lowercase, digits, dashes. In the app it becomes `tokens-<providerId>`. Must be unique on the Store. |
| `keyPrefix` | Device keys look like `<keyPrefix>-…` (2–16 characters). |
| `publicUrl` | The public `https://` address, without `/v1`. |
| `trustedStoreKeys` | Ed25519 public keys of the Store (the sample already has the AICW Store key). |
| `buckets` | Your wallets: `{ "voice_tokens": { "label": "voice tokens", "topup": "aicoworker://store/skills/<your pack>", "estimate": { … } } }`. `estimate` (optional) is one typical use, see below. |
| `adapters` | Where calls go: `openai` (any OpenAI-compatible API: `baseUrl` + `apiKeyEnv`), `byteplus` (Seedance video), `elevenlabs` (ElevenLabs speech: `apiKeyEnv`, `voice` = default voice id; the model's `upstreamModel` is their model id), `mock` (canned answers for testing). |
| `models` | `{ id, type, bucket, adapter, upstreamModel?, price?, unit? }`. `type` is `chat`, `image`, `video`, `tts`, `stt`, `embedding` or `other`. |
| `allowStoreAdjust` | Let the Store's administrators correct balances by hand (off by default). |
| `allowStorePricing` | Let a trusted Store change prices and estimates at run time (off by default; see below). |
| `limits` | `requestsPerMinute` (per key, default 60), `maxOpenVideos` (per account, 3), `maxBodyBytes` (32 MB). |

How many tokens a call costs (`price`):

| type | default | options |
|---|---|---|
| chat, embedding | 1 token per model token | `input`, `output`, `cacheRead` weights; `defaultHold` (reserve when no `max_tokens`) |
| image | low/medium 1, high 4 per image | `quality: {…}`, `edit` (added for edits) |
| video | 1 per second at 480p, 2 at 720p, 4 at 1080p | `resolution: {…}`, `minSeconds`, `maxSeconds`, `defaultSeconds` |
| tts | 1 per 1000 characters | `per1kChars` |
| stt, other | 1 per request | `perRequest` |

Tokens are **reserved before** the model is called and **charged after** it answers, with what it
really used. A failed or refused call costs nothing. Two calls can never spend the same tokens.

## What buyers see: a quota and an estimate, not token counts

The AICW Store and the app never show a buyer how many tokens they hold. Each wallet is a **quota**:
100% is the wallet right after its last top-up, and it goes down as it is used. Next to it the
buyer sees **about how many typical uses** are left ("about 40 messages", "about 90 images"),
with a note that the real number depends on how complex their prompts and context are.

The server provides both: every balance answer carries `quota` (per bucket), every `/v1` answer
the `x-aicw-quota-<bucket>` header next to `x-aicw-balance-<bucket>`, and the manifest gives each
bucket an `estimate` = what one typical use costs at today's price:

| bucket's model | default typical use | `estimate` override in `buckets.<id>.estimate` |
|---|---|---|
| chat | one agent message: 6,000 fresh input + 60,000 cached input + 2,000 output tokens | `{ "chat": { "input": 6000, "cacheRead": 60000, "output": 2000 } }` |
| image | one image at medium quality | `{ "image": { "quality": "high" } }` |
| video | one 5 s clip at 720p | `{ "video": { "seconds": 5, "resolution": "480p" } }` |
| tts | 1,000 characters | `{ "tts": { "chars": 2000 } }` |
| stt, other, embedding | one request | — |

`"model": "<id>"` picks which model of the bucket the estimate uses (default: the first).

## Letting the Store set prices (`allowStorePricing`)

Off by default: your `token-server.json` is the price list. With `"allowStorePricing": true`, a
Store you trust may replace a model's price (`POST /aicw/prices/set {model, price | null}`) and a
bucket's typical use (`POST /aicw/estimates/set {bucket, estimate | null}`) at run time; `null`
puts your file's value back. Changes live in your database (`ts_overrides`), every one is logged
(`ts_override_log`), and apply from the next call (other processes pick them up within 15 s).
Only price fields can change (weights per model token, per image quality, per video resolution…),
never the seconds limits or the list of resolutions. Any trusted Store may read the live prices
with `POST /aicw/prices`. Neurons AI turns this on for its own server (Store Connect → Token
prices); a developer's server normally keeps it off.

## What the app calls (`/v1`, Bearer device key)

`GET /v1/models` · `POST /v1/chat/completions` (stream or not; usage is always requested upstream) ·
`POST /v1/responses` · `POST /v1/images/generations` · `POST /v1/images/edits` (multipart) ·
`POST /v1/videos` → `GET /v1/videos/{id}` → `GET /v1/videos/{id}/content` · `POST /v1/audio/speech` ·
`POST /v1/audio/transcriptions` · `POST /v1/embeddings` · `POST /v1/generate` (type `other`) ·
`GET /v1/me/balance`.

Every answer carries `x-aicw-balance-<bucket>` and `x-aicw-quota-<bucket>` headers (show
`balance ÷ quota` as a percentage, not the numbers). Out of tokens is HTTP 402:

```json
{ "error": { "code": "insufficient_tokens", "bucket": "voice_tokens", "balance": 0, "needed": 3, "topup": "aicoworker://store/skills/acme-voice-100" } }
```

## What the Store calls (`/aicw`, Ed25519-signed, 5-minute window)

`POST /aicw/fulfill` (grant a paid receipt, idempotent) · `POST /aicw/refund` (take back what is
unused) · `POST /aicw/keys` (the device's one live key; asking again replaces it) ·
`POST /aicw/keys/revoke` · `POST /aicw/balance` · `POST /aicw/adjust` (only with `allowStoreAdjust`) ·
`POST /aicw/prices` · `POST /aicw/prices/set` and `POST /aicw/estimates/set` (only with `allowStorePricing`).
The buyer is an opaque `accountRef`; your server never learns who it is.

## Writing it yourself instead

Allowed. `aicw-token-server check <url> --key <file>` is the definition of "compatible" (≈ 37
checks). Rules a hand-written server must follow: accounts created with `test: true` never reach a
real model, and for them a prompt containing `[[fail]]` must fail like a broken upstream (5xx) and
`[[refuse]]` must be refused (400), both free of charge. Use `aicw-token-server keygen` to make a
test Store key and start your server trusting it.

## Housekeeping

`start` sweeps every minute: finishes video jobs nobody polled, frees reservations of calls that
died. On Cloudflare the deployed Worker runs the sweep from a 5-minute cron (`createWorker` does it).

## Security checklist

- Upstream keys only in environment variables on your server; never in `token-server.json`.
- HTTPS only (the Store refuses `http://`).
- Back up the SQLite file: it is your customers' wallets.
- Keep `AICW_EXTRA_STORE_KEYS` empty in production (it is for local checks).
- Upgrading needs no step: the schema upgrades itself on start (Node) or on the first request
  (`deploy cloudflare` / `createWorker`). Your own D1 setup with wrangler migrations instead: the
  statements are `SCHEMA` then `upgradeSql(u)` for each of `UPGRADES` in `src/storage.ts`.
