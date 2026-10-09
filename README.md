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

> Until the package is published on npm / GitHub (`Neurons-AI/aicw-token-server`), run it from this folder: `pnpm install && node src/cli.ts <command>`.

```bash
npm i -g aicw-token-server            # Node 22.5 or newer
mkdir my-tokens && cd my-tokens
aicw-token-server init                # writes token-server.json + .env.example
# edit token-server.json (name, providerId, publicUrl, buckets, models) and put your keys in .env
aicw-token-server check --self        # runs the full conformance check in memory, costs nothing
set -a; . ./.env; set +a
aicw-token-server start --port 8787   # SQLite file token-server.db next to it
```

Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel) at the `publicUrl` you configured, then in
the AICW Store: **Developer → AI Token servers → Add and check**. The Store runs the same
conformance check against your URL (again every week; three failed weeks in a row stop your packs
from selling). Then create **Token packs** that grant tokens from your buckets.

Docker: `docker build -t aicw-token-server .` then `docker run -v $PWD:/data --env-file .env -p 8787:8787 aicw-token-server` (the folder holds `token-server.json` and the SQLite wallets).

## token-server.json

| Field | Meaning |
|---|---|
| `name` | What buyers see ("Acme Voice"). |
| `providerId` | How the app files your server: lowercase, digits, dashes. In the app it becomes `tokens-<providerId>`. Must be unique on the Store. |
| `keyPrefix` | Device keys look like `<keyPrefix>-…` (2–16 characters). |
| `publicUrl` | The public `https://` address, without `/v1`. |
| `trustedStoreKeys` | Ed25519 public keys of the Store (the sample already has the AICW Store key). |
| `buckets` | Your wallets: `{ "voice_tokens": { "label": "voice tokens", "topup": "aicoworker://store/skills/<your pack>" } }`. |
| `adapters` | Where calls go: `openai` (any OpenAI-compatible API: `baseUrl` + `apiKeyEnv`), `byteplus` (Seedance video), `mock` (canned answers for testing). |
| `models` | `{ id, type, bucket, adapter, upstreamModel?, price?, unit? }`. `type` is `chat`, `image`, `video`, `tts`, `stt`, `embedding` or `other`. |
| `allowStoreAdjust` | Let the Store's administrators correct balances by hand (off by default). |
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

## What the app calls (`/v1`, Bearer device key)

`GET /v1/models` · `POST /v1/chat/completions` (stream or not; usage is always requested upstream) ·
`POST /v1/responses` · `POST /v1/images/generations` · `POST /v1/images/edits` (multipart) ·
`POST /v1/videos` → `GET /v1/videos/{id}` → `GET /v1/videos/{id}/content` · `POST /v1/audio/speech` ·
`POST /v1/audio/transcriptions` · `POST /v1/embeddings` · `POST /v1/generate` (type `other`) ·
`GET /v1/me/balance`.

Every answer carries `x-aicw-balance-<bucket>` headers. Out of tokens is HTTP 402:

```json
{ "error": { "code": "insufficient_tokens", "bucket": "voice_tokens", "balance": 0, "needed": 3, "topup": "aicoworker://store/skills/acme-voice-100" } }
```

## What the Store calls (`/aicw`, Ed25519-signed, 5-minute window)

`POST /aicw/fulfill` (grant a paid receipt, idempotent) · `POST /aicw/refund` (take back what is
unused) · `POST /aicw/keys` (the device's one live key; asking again replaces it) ·
`POST /aicw/keys/revoke` · `POST /aicw/balance` · `POST /aicw/adjust` (only with `allowStoreAdjust`).
The buyer is an opaque `accountRef`; your server never learns who it is.

## Writing it yourself instead

Allowed. `aicw-token-server check <url> --key <file>` is the definition of "compatible" (≈ 37
checks). Rules a hand-written server must follow: accounts created with `test: true` never reach a
real model, and for them a prompt containing `[[fail]]` must fail like a broken upstream (5xx) and
`[[refuse]]` must be refused (400), both free of charge. Use `aicw-token-server keygen` to make a
test Store key and start your server trusting it.

## Housekeeping

`start` sweeps every minute: finishes video jobs nobody polled, frees reservations of calls that
died. On Cloudflare Workers run `server.sweep()` from a cron (see `../cloud`, the Neurons AI Cloud
deployment: the same library on D1).

## Security checklist

- Upstream keys only in environment variables on your server; never in `token-server.json`.
- HTTPS only (the Store refuses `http://`).
- Back up the SQLite file: it is your customers' wallets.
- Keep `AICW_EXTRA_STORE_KEYS` empty in production (it is for local checks).
