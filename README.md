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

> Install from npm: [`aicw-token-server`](https://www.npmjs.com/package/aicw-token-server). Node 22.18 or
> newer, nothing else.
>
> Not technical? Ask the agent in AI Coworker: "sell tokens for my app with my own server". It does
> every step below; you only log in to Cloudflare once and click "Allow" in the app.

```bash
mkdir my-tokens && cd my-tokens
npm init -y && npm install aicw-token-server   # the version is pinned in this folder
npx aicw-token-server init                     # token-server.json + .env.example
# edit token-server.json (name, providerId, buckets, models, prices) and put your keys in .env
npx aicw-token-server check --self             # the full conformance check in memory, costs nothing
npx aicw-token-server deploy cloudflare        # online in a minute, see "Deploy"
```

Update: `npm install aicw-token-server@latest`, then `deploy cloudflare` again (same address, wallets kept).
Working on the library itself: clone this repo, `pnpm install`, then `node src/cli.ts <command>`.

Then in the AICW Store: **Developer → AI Token servers → Add and check** with the address it printed.
The Store runs the same conformance check against your URL (again every week; three failed weeks in
a row stop your packs from selling). Then create **Token packs** that grant tokens from your buckets.

## Deploy

### Cloudflare (recommended: one command, free plan is enough to start)

```bash
npx aicw-token-server deploy cloudflare [--name my-tokens] [--account-id <id>]
```

It uses the Cloudflare CLI [`cf`](https://developers.cloudflare.com/cf/) (installed for you in
`.aicw-deploy/`, pinned): it signs you in to Cloudflare once (`cf auth login`: approve a one-time code
in the browser; on a machine nobody sits at, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
instead), creates a D1 database for the wallets, deploys a Worker named `aicw-tokens-<providerId>`, stores every key your adapters name (`apiKeyEnv`, read
from `.env`) as Worker secrets, writes the `https://….workers.dev` address into `publicUrl`, and
checks that it answers. Run it again after changing prices, models or keys. It writes
`.aicw-deploy/` next to your config (keep it out of git with `.env`). The tables are created on the
first request, so there is no migration step; D1 keeps a point-in-time history of the wallets
(7 days on the free plan, 30 on a paid one). The Worker entry is `aicw-token-server/worker`
(`import { createWorker } from 'aicw-token-server/worker'; export default createWorker(config)`) if you prefer your own `cf` or wrangler setup.

### Your own machine or VPS (Docker or Node)

```bash
npx aicw-token-server start --port 8787        # SQLite file token-server.db next to it
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

## Many models through OpenRouter, never below cost

One OpenRouter key reaches Claude, Gemini, Kimi, GLM, DeepSeek and Gemini image models, and every
answer says what the call cost (`usage.cost`). Use the `openai` adapter on
`https://openrouter.ai/api/v1` and, per model:

```json
"adapters": {
  "or":    { "kind": "openai", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
  "orimg": { "kind": "openai", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "images": "chat" }
},
"models": [
  { "id": "claude-sonnet-5.5", "type": "chat", "bucket": "claude_tokens", "adapter": "or", "upstreamModel": "anthropic/claude-sonnet-5.5",
    "promptCache": "anthropic", "price": { "input": 0.0982, "cacheRead": 0.0099, "cacheWrite": 0.1227, "output": 0.4907, "perUsd": 49068 } },
  { "id": "glm-5.3", "type": "chat", "bucket": "glm_tokens", "adapter": "or", "upstreamModel": "z-ai/glm-5.3",
    "upstreamBody": { "provider": { "max_price": { "prompt": 1.4, "completion": 4.4 } } }, "price": { "input": 0.0687, "output": 0.2159, "perUsd": 49068 } },
  { "id": "gemini-3.1-flash-image", "type": "image", "bucket": "image_tokens", "adapter": "orimg", "upstreamModel": "google/gemini-3.1-flash-image",
    "price": { "quality": { "low": 3300, "medium": 3300, "auto": 3300, "high": 5000 }, "edit": 100, "perUsd": 49068 } }
]
```

- `price.perUsd` (wallet tokens per 1 USD): a call is never charged less than the reported cost × perUsd, whatever route, long-context tier or cache write it took. Set it from the same formula as your token prices.
- `price.cacheWrite`: prompt tokens written to the provider's cache (Anthropic bills them above input).
- `promptCache: "anthropic"`: marks the system prompt and the last messages for Anthropic prompt caching, so an agent's repeated prefix is a cache read on the next turn.
- `upstreamBody`: fields set on every upstream request for that model (OpenRouter `provider` routing; `max_price` keeps a flat-priced model off pricier hosts).
- `images: "chat"` on an adapter: `/images/generations` and `/images/edits` go through chat completions with `modalities: ["image","text"]` (quality `high` = 2K, otherwise 1K).
- Buyers never see the upstream cost or which host served them: `usage.cost`, `cost_details`, `is_byok` and `provider` are removed from every answer, streamed or not.

## Claude and Gemini direct (no 5.5% router fee)

- `"kind": "anthropic"` (`apiKeyEnv`): Claude through the Messages API, translated to and from Chat
  Completions (system, images, tools and tool results, streaming, thinking as `reasoning_content`) and
  prompt-cached (system + last two messages). Usage carries cache reads and writes; set `price.cacheWrite`.
- `"kind": "gemini"` (`apiKeyEnv`): chat through Google's OpenAI-compatible endpoint, Nano Banana
  images (`gemini-*-image`) through `generateContent`. That endpoint leaves thinking out of
  `completion_tokens`; the server bills `total_tokens − prompt − completion` as output. Gemini Pro bills
  prompts above 200k tokens higher for the whole call: set `price.longContext: { above: 200000, input, output, cacheRead }`.
- Both refuse API calls from some regions (Hong Kong among them). On Cloudflare Workers the edge that
  runs your Worker follows the caller, so pass a `fetch` that sends those hosts through a Worker placed in
  the US (`[placement] region = "aws:us-east-1"`, reached by a service binding) — Neurons AI Cloud does this.

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
