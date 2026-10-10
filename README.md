# Index-Translate-Proxy

一個 **Vercel 上的 Edge 函式**（同一份協定碼也保留 **Cloudflare Worker** 入口）：把 bilibili **Index-Translate**
的免費公網 API（`https://index-translate.bilibili.com/v1`）以**同源端點**的形式提供出去，讓瀏覽器插件
（**沉浸式翻譯 Immersive Translate** 的「OpenAI 翻譯服務 + 自訂接口地址」）與其他 OpenAI 相容
客戶端可以直接使用 35B 翻譯模型。本 repo 只做代理，不做 UI。

> 狀態：**已上線** —— `https://index-translate-proxy.vercel.app`（線上探測 19 ok / 0 fail / 1 skip，
> 串流兩側皆真增量）。**主入口在 Vercel**；CF Worker 那份因**出口被上游風控 412**而目前打不到上游
> （原因與選項見 [`design/egress-options.md`](design/egress-options.md)）。
> 實作規則與設計決策在 [`AGENTS.md`](AGENTS.md) 與 [`design/`](design/)。

## 為什麼需要一個代理（不是「可有可無」）

官方教學自己就在端點前面放了一座橋（`python call_api.py --serve`），理由寫在
`inference/llm/README_zh.md`：瀏覽器直連公網端點受「跨域（CORS）、WAF 保護、思維鏈（CoT）」三項限制。
2026-10-08 首次實測、2026-10-10 重測覆核後，三項裡只有 **WAF 一項是真的**——但它的規則比官方描述的窄：
擋的是**特定機器人 UA**，不是「不像瀏覽器」。

| 官方列的限制 | 實測（2026-10-10） |
|---|---|
| 跨域（CORS） | **不成立**（帶 `Origin` 時上游回 `access-control-allow-origin: *`） |
| WAF 保護 | **部分成立**：`Python-urllib/*`、`python-requests/*` → 412；`curl/*`、`Cloudflare-Workers`、空字串 UA → 200 |
| 思維鏈（CoT） | **不成立**（`enable_thinking` 開或關都不吐 `<think>`，見下方注意事项） |

所以這個 worker 的實質價值有兩條，都不是「開 CORS」：

1. **UA 適配**：固定用一個自報家門的 UA（`Index-Translate-Proxy/0.1`，實測 200）打上游，不依賴客戶端送什麼。
   上游擋的是黑名單（`python-requests/*`、`Python-urllib/*`），不是「不像瀏覽器」，所以不假裝自己是瀏覽器。
2. **協定適配**：插件填的自訂網址會直接 POST `<url>/chat/completions`（**不會**補 `/v1`），
   而上游只認 `/v1/chat/completions`。本代理接受 `/chat/completions`、`/v1/…`、`/api/v1/…`
   三種寫法並正規化到 `/v1/…`，所以插件填 `https://<worker>/v1` 或 `https://<worker}/api/v1` 都能動。

第三項——「不設上限會被 429 打爆」——同樣是真的，只是那條規則按 **egress IP** 算，而 Worker 的出口 IP
是共用池（探測時 30 秒連打 7 次就 429）。所以本代理自己設並發上限，不假裝上游有配額可查。

完整探測數據與推翻的舊假設：[`design/upstream-probe-2026-10-10.md`](design/upstream-probe-2026-10-10.md)。

## 快速開始

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy&project-name=index-translate-proxy&repository-name=index-translate-proxy&env=ITP_KEY&envDescription=%E4%BD%BF%E7%94%A8%E8%80%85%E5%85%B1%E7%94%A8%E7%9A%84%E9%91%91%E6%AC%8A%20key%EF%BC%8C%E8%87%AA%E8%A8%82%E4%B8%80%E4%B8%B2%EF%BC%88openssl%20rand%20-hex%2032%EF%BC%89&envLink=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy%2Fblob%2Fmain%2F.dev.vars.example)

自己部署（**Vercel**，現行主入口）：

```bash
git clone git@github.com:Lawlietr/Index-Translate-Proxy.git
cd Index-Translate-Proxy
# 1. Vercel 專案 → Import 這個 repo（Framework 選 Other；構建命令與輸出目錄都不需要）
# 2. Settings → Environment Variables → Production：ITP_KEY = 自己產生（openssl rand -hex 32）
# 3. 部署，然後設 Allowlist 關閉
```

沒有 `ITP_KEY` 時代理一律回 **503**（不會變成公開）。上線後跑一次探測確認：

```bash
node scripts/probe-live.mjs https://<你的專案>.vercel.app   # 19 項協定檢查（規則 13）
node scripts/probe-sse-timing.mjs https://<你的專案>.vercel.app  # 確認串流是真增量
```

部署後打開 `https://<你的專案>.vercel.app/` 會看到一行說明與 `x-proxy-auth: configured|missing`——
不用翻控制台就知道自己有沒有設 key。

**要部署到 Cloudflare？** 協定碼完全相同，但目前**從 CF 出口打上游會被風控 412**，
所以那側部署出來的實例打不到上游（`design/egress-options.md`）。真要跑：
`npx wrangler secret put ITP_KEY && npx wrangler deploy`。

**一键部署按鈕**（Vercel 與 CF 兩個按鈕的參數定案）在 [`design/deploy-button.md`](design/deploy-button.md)；
本 repo 還沒有 `deploy/`，所以在徽章上線前請用上面的步驟。

## 插件要怎麼填

以沉浸式翻譯（網頁翻譯／插件設定 → 翻譯服務）為例：

| 欄位 | 值 |
|---|---|
| 服務提供者 | OpenAI（或 OpenAI-compatible）。**不要選「沉浸式翻譯（自托管）」**——那是 DeepL 協定 |
| 模型 | `Index-Translate-35B-A3B` |
| 自訂接口地址 | `https://<你的 worker>/v1`（或 `https://<你的 worker}/api/v1`） |
| API Key | 你 `wrangler secret put ITP_KEY` 時設的那把 key（**它是本代理的門，上游本身不需 key**） |

「開發者／自訂翻譯服務」那一欄填 `https://<你的 worker 域名}` 也可以：本代理對任何路徑都補出正確的
上游路徑，但**絕不會補成 `/v1/v1/…`**（AGENTS.md 規則 5）。

## 鑑權

一把**共用的 key**（`ITP_KEY`，Secret）。上游本身免費、不鑑權，所以這把 key 是**我們自己的門**，
不是上游的憑證；完整的定案理由與「不做什麼」在 [`design/auth.md`](design/auth.md)。

```bash
npx wrangler secret put ITP_KEY      # 不是 vars（那會變明文）；本地開發放 .dev.vars
```

- 讀取順序：`Authorization: Bearer <key>` → `x-api-key: <key>`。不支援 query／path 帶 key（會留在 URL 裡）。
- 比對的是 **SHA-256 摘要**（常數時間），日誌不會出現明文 key。
- 沒帶或不對 → **401**（OpenAI 錯誤形狀 + `WWW-Authenticate: Bearer`，插件才看得到 message）。
- 沒設 `ITP_KEY` → **503**，不會「變成公開可用」：那是部署端少了 Secret，不該讓使用者以為代理正常。
- 試 key 的失敗走**獨立限流**：`wrangler.toml` 的 `[[ratelimits]]` 綁定 `AUTH_RL`，按 `cf-connecting-ip`
  計，30 次／60 秒，超過回 429 + `Retry-After`。有人亂試不會把正常請求擠掉；而且 401 發生在任何上游請求
  之前，**不消耗上游配額**。
- `OPTIONS`（預檢）**不鑑權**，但 `Access-Control-Allow-Headers` 一定含 `authorization`。
- ⚠️ 這是「擋公網上的滥用」，**不是多租戶配額控制**：key 明文存在插件設定裡，任何人開 devtools 就看得到。
  上游按 **IP** 限流，共用同一條 worker 的人共用同一個出口配額。

## 代理會對上游改什麼（逐項透明列出）

| 項目 | 代理的行為 | 為什麼 |
|---|---|---|
| `User-Agent` | 固定為 `Index-Translate-Proxy/0.1 (+…)`，**不轉發**客戶端的 | 上游 WAF 擋的是機器人 UA 黑名單（規則 2）。真被擋了就改 `src/lib/headers.js` 的 `PROXY_UA` 一個常數 |
| 轉發的標頭 | 只帶 `content-type` 與 UA；`authorization`／`cookie`／CF 的 `x-*` 一律不帶 | 規則 8；上游沒有 key，插件填的是我們的 key |
| 模型 | 只放行 `Index-Translate-35B-A3B`；其他模型本地 400，**不換、不降級、不試探** | 規則 1，避免「以為自己選的模型跑過了」 |
| 路徑 | `/v1/*`、`/api/*`、裸 `/chat/completions` 都正規化到 `/v1/*`；其他路徑本地 404 | 插件的網址規則與上游的路徑不一致（規則 5） |
| 串流 | 一律向上游要 SSE；非串流客戶端由代理**組回**單一 `chat.completion`，並插一個只含原分隔字元的 delta | 上游非串流 10.0s 會 504；切塊要接回行界（規則 3、規則 4） |
| 注入 | 只有四項**協定層**注入：`stream`、`stream_options.include_usage`、`chat_template_kwargs.enable_thinking:false`、`max_tokens`（客戶端已帶就不動）。**prompt 一律不改** | 規則 9 |
| 超長輸入 | 先切（2,500 字元，保守值）→ **依序**送、按原分隔字元接回。**單行本身**超過 `MAX_LINE_CHARS`（2,000）→ **本地 413**，不切也不猜 | 上游的截斷在**輸出側**（不是輸入側），不標記就看不出來；行內切會讓編號錯位（規則 4） |
| 行對應 | 上游**只在請求帶翻譯指令時**逐行對應（`system` 或 `source_language`/`target_translation`）。只送編號句不帶指令時，它會加前言、把每句展開成多語言列表，或只回一行「請提供文本」 | 端點行為，代理修不了；只能不讓它更糟（不重編編號、不黏行）。實測數字見 design/upstream-probe §1 |
| 並發 | 一個請求持有一個 slot（預設 4，`MAX_INFLIGHT`）；閘滿先本地排隊 15 秒，等不到才 **429 + `Retry-After: 2`** | 規則 7；上游配額按 IP 且共用出口 |
| 上游錯誤 | **不改 status、不改 body**，只在同一回應加 `x-proxy-hint`（我們的建議） | 規則 6 |
| 思考標記 | 上游不吐 `<think>`，但萬一換端點就吐：只剝流式前綴（不會把編號行一起吃掉） | 規則 4 |

## 除錯標頭與疑難排解

回應一律帶：

| 標頭 | 意義 |
|---|---|
| `x-proxy-upstream-stream` | 固定 `forced`——對上游一律要 SSE（規則 3） |
| `x-proxy-chunks` | 這個請求被切成幾塊（沒切就不帶） |
| `x-proxy-chunk-failed` / `x-proxy-chunk-lines` | 中途某塊失敗時：哪一塊、之前已譯出幾行（見 design §3） |
| `x-proxy-truncated` | 上游回 `finish_reason:"length"`（尾部被截），而且我們動過 `max_tokens` |
| `x-proxy-auth` | `configured`／`missing`——開根路徑就知道 key 有沒有設好 |
| `x-proxy-hint` | 只在**錯誤回應**出現：我們的建議文字（percent-encoded，規則 6 的載體約定）。 |

`x-proxy-hint` 只在錯誤回應出現，而且**只寫事實與建議**（「本代理不重試」、「404/429 是本地擋的，不是上游」
這類）。它**不會**對上游回應做任何猜測——上游的 status 與 body 從來不改。

| 症狀 | 先看哪裡 |
|---|---|
| 只報「CORS 失敗」 | `OPTIONS /v1/chat/completions` 的 `access-control-allow-headers` 有沒有 `authorization` |
| 401 | 先看 `x-proxy-auth`：`missing` → `ITP_KEY` 這個 Secret 沒設好；`configured` → 插件填的不是同一把 key |
| 503「未設定 ITP_KEY」 | 部署端少了 Secret：`npx wrangler secret put ITP_KEY`（放 `vars` 沒用，那是明文且不同名） |
| 只報「請求失敗」 | body 要是 OpenAI 錯誤形狀（`error.message`）；400／401／404／429／503 都符合，所以插件會顯示 message |
| 412 | 不會發生在本代理（UA 由我們固定）。若看到 412，代表你打的是上游，不是 worker |
| 429 + `Retry-After` | 看 `x-proxy-hint`：本代理的閘還是上游回的。**上游的 429 是按 IP**，共用 worker 的人共用同一個配額 |
| 504 + `Retry-After: 2` | 上游的 10 秒非串流限制——本代理一律要 SSE，所以這條只會出現在上游自己回 504 時 |
| 譯文比原文少、沒有提示 | 看 `finish_reason`／`x-proxy-truncated`（尾側截斷；已把 `max_tokens` 推到 4,096） |
| 譯文行數對不上原文行數 | 上游偶爾回 `choices: []`（2026-10-10 實測）；本代理不重試，把這段原樣傳出去 |

## 環境變數

| 名稱 | 預設 | 說明 |
|---|---|---|
| `ITP_KEY` | （沒有 → 一律 503） | **Secret**。本代理的共用 key，見 design/auth.md |
| `MAX_INPUT_CHARS` | `2500` | 切塊的保守邊界（2026-10-10 探測值） |
| `MAX_INFLIGHT` | `4` | 同時在途的請求數（單 isolate）。上游無配額可查，只能自己設 |
| `SLOT_WAIT_MS` | `15000` | 閘滿時在本地排隊的最久時間，等不到才 429 |
| `MAX_TOKENS_DEFAULT` | `4096` | 客戶端沒帶 `max_tokens` 時補的值（上游預設 2,048 會截尾） |
| `MAX_LINE_CHARS` | `2000` | 單行長度上限。只在行界切塊，所以單行超長無法切 → **413** 並說明怎麼繞過 |
| `MAX_BODY_BYTES` | `16384` | 要送上游的單塊 body 上限，超過 → **413**（不讓它變成上游側的逾時或不明錯誤） |

四個閾值都能用 Dashboard 改（不需要重新部署）；預設值同時寫在 `src/lib/limits.js` 的 `DEFAULTS`
與 `wrangler.toml` 的 `[vars]`，**兩邊要一致**（AGENTS.md 規則 15），改一處就兩邊都改。

鑑權失敗的限流不是 env 變數，而是 `wrangler.toml` 的 `[[ratelimits]]`（綁定名 `AUTH_RL`，30 次／60 秒）；
本地 dev 沒有這個綁定時不擋。

`Account` 由 `wrangler` 自己讀（`wrangler whoami` / `CLOUDFLARE_ACCOUNT_ID`），**不寫進設定檔**——
把帳號寫死會直接擋掉一鍵部署。

## 開發

```bash
npm run dev                 # 本地跑真的 Worker runtime（讀 .dev.vars），瀏覽器/插件可打 http://127.0.0.1:8787
npm test                    # node --test，離線：注入假的 fetch，不碰網路
npm run smoke               # 端到端冒煙：在程序內跑 worker，逐條檢查主要路徑
npm run lint:zh             # 規則 11：掃常見簡體字（註解與使用者文字都要繁體）
node scripts/probe-live.mjs <base>          # 部署後打真的入口（規則 13）
node scripts/probe-sse-timing.mjs <base>    # 線上串流是否真增量（用 curl 當 client）
node scripts/probe-upstream.mjs --quick     # 打上游，結果存 tests/fixtures/
```

**協定碼只有一份**（`src/lib/`）：`api/index.js`（Vercel Edge runtime，現行主入口）、`src/worker.js`
（Cloudflare Worker，保留）、`api/probe.js`（一次性探測用）。本地開發以 `npm run dev`（miniflare）為主，
它與 Vercel 入口跑同一組協定碼。

離線測試覆蓋：路徑正規化（不產生 `/v1/v1`）、鑑權三態與限流、並發閘（排隊與 429 形狀）、切塊的
行界與單行 413、`<think>` 前綴剝離、非串流客戶端的組包（`usage` 缺就不帶）、中途失敗的 status 語義、
模型白名單、入口橋接（`x-vercel-*`、函式 URL、拆塊）。`tests/fixtures/` 是上游**實際回什麼**的原始存證
（`choices: []`、`error_code: 7001`、SSE 的 `usage` 行為），改實作時要能對回去。

## 已知限制（不要假裝比較不脆弱）

- 上游是**免費公網端點**：無 SLA、有 **60,000 tokens/min per IP** 的軟配額（超出回 429 + `retry-after`），
  而 **Vercel/CF 的出口 IP 是共用池** → 那個額度不是我們獨佔的。上游也**會撤回模型名稱**（`index-homura-*` 先例）。
- **並發閘是 per-instance**（兩個平台都一樣，已線上實測）→ 真正的保護是插件端的「每秒最大請求數 3~5」。
- **從 Cloudflare 出口打不到上游**（412，全站）；從 Vercel 出口可以。原因與可行出口見 `design/egress-options.md`。
- 輸出側截斷：上游預設 2,048 tokens。本代理會補到 4,096，但那只是把問題往後推，不是解決。
  切塊因此是按**估計輸出 tokens**算，不是只看輸入字元。
- 上游偶爾回 `choices: []` 的 200（探測 5/5 重現）→ 本代理**不重試**（規則 6 的代價）。
- 上游模型代幣解碼有缺陷（「秦漢→秦漢」）；本代理是薄代理，不修上游的輸出。
- 上游的 SSE **是真增量**（TTFT 0.2–1.0s，與輸入長度無關），所以串流不只是不斷線；但**非串流**超過 10s 會被 504
  → 一律向上游要串流（規則 3）。

## 授權

MIT（見 [`LICENSE`](LICENSE)）。上游 [bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)
為 Apache-2.0——**只引用其事實、模型名稱與 prompt 結構，沒有逐字複製其程式碼**。

## 來源

- [Index-Translate（bilibili）](https://github.com/bilibili/Index-Translate) — README「Option 1: Free Online
  API (Zero-GPU Setup)」與 `inference/llm/README_zh.md`（`chat_template_kwargs`、`enable_thinking` 的出處）
- 本 repo 的實測：[`design/upstream-probe-2026-10-10.md`](design/upstream-probe-2026-10-10.md)（原始輸出在
  `tests/fixtures/`）
