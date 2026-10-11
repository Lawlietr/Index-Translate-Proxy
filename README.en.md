<h1 align="center">Index-Translate-Proxy</h1>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/%F0%9F%87%B9%F0%9F%87%BC_%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-2ea44f?style=for-the-badge" alt="🇹🇼 繁體中文"></a>
  <a href="README.en.md"><img src="https://img.shields.io/badge/%F0%9F%87%AC%F0%9F%87%A7_English-555555?style=for-the-badge" alt="🇬🇧 English"></a>
</p>

<p align="center"><b>(◕ᴗ◕)</b> <sub>Both language versions of this README are 100% equivalent — change one, the other is updated too</sub></p>

<p align="center">
  Turn bilibili <b>Index-Translate</b> (a free translation model with an OpenAI-compatible API) into an OpenAI-compatible endpoint you host yourself — paste it into a browser extension or any other client.<br>
  A thin proxy: it does not rewrite your prompt, swap models, or cache.<br>
  It only does what is actually needed to make the upstream usable from a plugin: fixed UA, path normalisation, forced streaming, line-boundary chunking, and a passcode of your own.
</p>

Deploy it in your own Vercel project: free, no GPU, no upstream account — running in about five minutes.

Use it for:

- **Web page translation**: put your own URL into Immersive Translate's "Translation service → OpenAI → custom API endpoint" field.
- **Any OpenAI-compatible client**: `curl`, the OpenAI SDKs, LangChain and friends — just set the base URL.
- **Your own translation backend**: a translation exit for your own apps and scripts that needs no GPU and costs nothing.

Why a proxy is needed in the middle, and what it deliberately does not solve: [`design/why-proxy.md`](design/why-proxy.md) (Chinese).

## Deploy (Vercel, five minutes)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy&project-name=index-translate-proxy&repository-name=index-translate-proxy&env=ITP_KEY&envDescription=Your%20own%20passcode%20%28openssl%20rand%20-hex%2032%29&envLink=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy%2Fblob%2Fmain%2FREADME.en.md)

**One required value: `ITP_KEY`** — any string you invent yourself; clients have to present it (it is not an upstream key, the upstream needs no authentication).
Generate one:

```bash
openssl rand -hex 32    # this output is what you paste into the plugin's "API Key" field
```

The value has no length or format requirements (don't add surrounding whitespace; plain hex like this is the safe choice). After changing it, **redeploy** for it to take effect.

Click the button → paste that string into the prompted field → Deploy. There is no build step, no server, no GPU.
Prefer not to use the button: Vercel → import this repo (Framework: Other) → add `ITP_KEY` under Environment Variables → Deploy.

```bash
# once deployed, confirm everything works (protocol checks: auth, chunking, 413, 429 pass-through, real streaming…)
node scripts/probe-live.mjs https://<your-project>.vercel.app --key <your ITP_KEY>
```

<details>
<summary>Want it on Cloudflare Workers? (Not right now — the reason is inside)</summary>

Same protocol code, same variable (`npx wrangler secret put ITP_KEY && npx wrangler deploy`). But as measured on
2026-10-10: **requests to the upstream from Cloudflare's egress get blocked with 412 by the WAF**, so that entry
point cannot translate anything — the default entry point is therefore Vercel. The measured comparison of the three
egress options is in [`design/egress-options.md`](design/egress-options.md).

</details>

## After deploying: what to put in the plugin

| Field | Value |
|---|---|
| API endpoint (base URL) | `https://<your-project>.vercel.app/v1` (with or without `/v1` works; it is never doubled into `/v1/v1/…`) |
| Model | `Index-Translate-35B-A3B` (default), `index-mt-9b`, `index-mt-2b` (faster). Only these three — anything else gets a 400 |
| API Key | the `ITP_KEY` you just generated |

To see which models a given instance actually allows: `curl -H "Authorization: Bearer $KEY" <your-url>/v1/models`
(answered by this proxy itself — not forwarded upstream, costs no quota).

## Verify (curl)

```bash
B=https://<your-project>.vercel.app
KEY=<your ITP_KEY>

curl -s -X POST "$B/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[
        {"role":"system","content":"Translate into 繁體中文, keep the numbering."},
        {"role":"user","content":"1. The meeting starts at nine.\n2. Please bring the report."}]}'
# → {"choices":[{"message":{"content":"1. 會議九點開始。\n2. 請把報告帶來。"},"finish_reason":"stop"}]}

# without a key: you should get 401 (proof the gate is on)
curl -s -w "\nHTTP %{http_code}\n" -X POST "$B/v1/chat/completions" -H "content-type: application/json" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[{"role":"user","content":"1. Hi."}]}'
# → 401 {"error":{"message":"未提供 API Key…","type":"authentication_error"}}
```

Both `Authorization: Bearer` and `x-api-key` are accepted. Opening `https://<your-project>.vercel.app/` returns one
line of explanation and reports whether the key is configured in `x-proxy-auth` — no need to open the dashboard to
debug that.

## Configuration

**One required value**: `ITP_KEY` (Secret). Not set → every request returns **503**; it does not turn into an open endpoint.
**Everything else has a default and works untouched.**

<details>
<summary>Optional tuning (usually leave alone)</summary>

| Name | Default | When you would change it |
|---|---|---|
| `MAX_INFLIGHT` | `4` | one deployment serving several apps at the same time, or a plugin configured with high concurrency |
| `SLOT_WAIT_MS` | `15000` | how long to wait for a slot before returning 429; give up earlier or wait longer |
| `MAX_INPUT_CHARS` | `2500` | chunk size (the upstream truncates on the output side, so this is a conservative bound) |
| `MAX_LINE_CHARS` | `2000` | chunks are cut at line boundaries only, so this is the single-line limit (too long → 413 with a way around it) |
| `MAX_TOKENS_DEFAULT` | `4096` | value injected when the client sends no `max_tokens` (the upstream's default 2,048 cuts the tail off) |
| `MAX_BODY_BYTES` | `16384` | per-chunk body limit, above that → 413 |

To change any of them, add a variable with the same name in Vercel's Environment Variables and redeploy.

</details>

**In the plugin, set "max requests per second" to 3~5** — the concurrency gate is per instance, so the real protection
lives on the client side (the upstream rate-limits per IP, and cloud egress IPs come from a shared pool).

The proxy only ever adds these four **protocol-level** parameters (your prompt is never modified): `stream: true`,
`stream_options.include_usage`, `chat_template_kwargs.enable_thinking:false`, and `max_tokens` (untouched if you set it).
The reasoning is in [`design/why-proxy.md`](design/why-proxy.md) and
[`design/streaming-and-chunking.md`](design/streaming-and-chunking.md).

<details>
<summary><b>Reading errors</b> (status and header reference)</summary>

Errors always use the OpenAI shape (`error.message`), so the plugin displays the message directly. Every response
carries:

(`x-proxy-build` is for **you, the deployer**: when something goes wrong online, the response tells you which build is running.
`npm run deploy:vercel` sets the commit in Vercel before deploying; if you deploy from the dashboard, add a `GIT_COMMIT` environment variable yourself.)

| Header | Meaning |
|---|---|
| `x-proxy-upstream-stream: forced` | upstream is always asked for SSE (non-streaming gets cut off by the upstream after 10s) |
| `x-proxy-chunks` / `x-proxy-chunk-failed` / `x-proxy-chunk-lines` | how many chunks were sent, which one failed, how many lines were translated before the failure |
| `x-proxy-chunk-truncated` | the upstream returned `finish_reason:"length"`, the tail was cut off |
| `x-proxy-build` | which commit that deployment runs (12 characters); this header is absent when `GIT_COMMIT` is not set |
| `x-proxy-auth` | `configured` / `missing`: whether the deployment has a key set |
| `x-proxy-hint` | only on error responses, a suggestion (does not change the upstream's status or body) |

| Symptom | Check first |
|---|---|
| 401 | `x-proxy-auth: missing` → the Secret was not set; `configured` → the value sent is not the same string |
| 503 | `ITP_KEY` is missing from the deployment |
| 400 (model) | only the three models above are allowed; the message lists them |
| 413 | a single line too long, or the body too large; the message explains how to work around it |
| 429 + `Retry-After` | look at `x-proxy-hint`: our local gate, or the upstream's own |
| translation stops halfway | `x-proxy-chunk-truncated` / `finish_reason:"length"` |
| line count does not match | the upstream sometimes returns `choices: []`; the proxy does not retry, it passes it through as-is |

</details>

<details>
<summary><b>Development and tests</b></summary>

```bash
npm run dev       # local miniflare (reads .dev.vars), real upstream; http://127.0.0.1:8787
npm test          # 82 offline tests (fake fetch injected, no network)
npm run smoke     # 51 end-to-end smoke checks (worker inside the process)
npm run serve-bridge  # serve the Vercel entry with Node (no login, real upstream) → then run probe-live against http://127.0.0.1:8788
npm run dev:vercel    # run locally via the Vercel CLI (requires `vercel login`)
npm run lint:zh   # comments and user-facing text stay in Traditional Chinese (AGENTS rule 11)
node scripts/probe-upstream.mjs --quick   # re-measure upstream behaviour, results stored in tests/fixtures/
npm run lint:readme # structural parity check for the two READMEs (edit one, sync the other)
```

There is a single copy of the protocol code (`src/lib/`); the entry points are only platform bridges: `api/index.js`
(Vercel, primary) and `src/worker.js` (Cloudflare, kept). Design notes, measurements and decisions live in
[`design/`](design/); the non-negotiable rules in [`AGENTS.md`](AGENTS.md); the to-do list in [`TODO.md`](TODO.md)
— these three are internal documents, in Chinese only. Every upstream fact quoted here (UA blacklist, quota, output limits…) was
**measured by us**: `node scripts/probe-upstream.mjs`.

</details>

## Limitations (not pretending to be less fragile than it is)

- The upstream is a **free public endpoint**: no SLA, **60,000 tokens/min per IP**, and cloud egress IPs are a shared pool; model names get withdrawn.
- Concurrency protection is per instance, not a global guarantee.
- Output-side truncation: raising it to 4,096 tokens only pushes the problem further.
- The upstream is unreachable from Cloudflare egress (412), which is why the default entry point is Vercel.
- The upstream models have token-decoding defects ("秦漢→秦漢"); a thin proxy does not repair upstream output.

## Licence

MIT (see [`LICENSE`](LICENSE)). The upstream [bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)
is Apache-2.0 — only its facts, model names and prompt structure are referenced here, **its code was not copied verbatim**.
