# Index-Translate-Proxy

把 bilibili **Index-Translate**（免費的翻譯模型，OpenAI 相容 API）變成一個**你能直接貼進設定裡**的端點。
它是個薄代理：不改 prompt、不換模型、不快取，只做「能被插件用上」需要的那幾件事
（固定 UA、路徑正規化、強制串流、必要的切塊、一把自己的門）。

能做什麼：

- **網頁翻譯**：沉浸式翻譯（Immersive Translate）的「翻譯服務 → OpenAI → 自訂接口地址」直接填我們的網址。
- **任何 OpenAI 相容 client**：`curl`、OpenAI SDK、LangChain、openclaw 之類的工具，填 base URL 就能用。
- **自己的翻譯後端**：给自家 app／腳本一個不用 GPU、不用 API key 付費的翻譯出口。

為什麼需要代理、它不解決什麼：[`design/why-proxy.md`](design/why-proxy.md)。

## 用法一：直接用這份（最快）

| 欄位 | 值 |
|---|---|
| 接口地址（base URL） | `https://index-translate-proxy.vercel.app/v1` |
| 模型 | `Index-Translate-35B-A3B`（預設）、`index-mt-9b`、`index-mt-2b` — 只這三個，填別的會被 400 |
| API Key | `itp-3c3daf945ef7749f27852d074fb875bb`（示範用、共用；可能隨時輪換，穩定使用請自己部署一把） |

線上狀態：`GET https://index-translate-proxy.vercel.app/` 會回一行說明與 `x-proxy-auth`，不用翻控制台。
要確認某個實例實際放行了哪些模型：`curl -H "Authorization: Bearer $KEY" <base>/v1/models`——由本代理自己回，不轉發上游。

## 用法二：自己部署（Vercel，三分鐘）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy&project-name=index-translate-proxy&repository-name=index-translate-proxy&env=ITP_KEY&envDescription=%E4%BD%A0%E8%87%AA%E5%B7%B1%E8%A8%AD%E5%AE%9A%E7%9A%84%E9%80%9A%E8%A1%8C%E7%A2%BC%EF%BC%88openssl%20rand%20-hex%2032%EF%BC%89&envLink=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy%2Fblob%2Fmain%2FREADME.md)

**只有一個必填項**：`ITP_KEY` —— 你自己隨意定的一串字，客戶端要帶它才能用（這是你的門，**不是上游的 key**；
上游免費、不需 key）。產生一把：

```bash
openssl rand -hex 32     # 輸出就是之後填進插件「API Key」欄位的值
```

按鈕按下去 → 在那個欄位貼上這串 → Deploy，完成。沒有構建步驟，不需要伺服器、不需要 GPU、不需要上游的帳號。

不想用按鈕：Vercel → Import 這個 repo（Framework 選 Other）→ Environment Variables 加 `ITP_KEY` → Deploy。
部署完驗證一下：

```bash
node scripts/probe-live.mjs https://<你的專案>.vercel.app --key <你的 ITP_KEY>
```

<details>
<summary>要放到 Cloudflare Workers／其他平台？（目前不建議，原因在裡面）</summary>

同一份協定碼、同一把 `ITP_KEY`（`npx wrangler secret put ITP_KEY && npx wrangler deploy`）。但 2026-10-10
實測：**從 Cloudflare 的出口打上游會被風控 412**，那個入口現在翻譯不了東西，所以主入口放在 Vercel。
三個出口選項的實測比較在 [`design/egress-options.md`](design/egress-options.md)。

</details>

GitHub 只是公開鏡像；主要開發在自建 Forgejo，issue／PR 請到主 repo。

## 設定

| | 名稱 | 預設 | 說明 |
|---|---|---|---|
| **必填** | `ITP_KEY` | — | 通行碼（Secret）。沒設定 → 所有請求 503，不會變成公開端點 |
| 選填 | `MAX_INFLIGHT` | `4` | 同時在途的請求數（單實例）。閘滿先排隊，等不到才 429 |
| 選填 | `SLOT_WAIT_MS` | `15000` | 排隊的最久時間 |
| 選填 | `MAX_INPUT_CHARS` | `2500` | 切塊大小（上游的截斷在輸出側，這個值是保守邊界） |
| 選填 | `MAX_LINE_CHARS` | `2000` | 單行上限（只在行界切塊，單行超長只能 413 並說明繞法） |
| 選填 | `MAX_TOKENS_DEFAULT` | `4096` | 客戶端沒帶 `max_tokens` 時補的值（上游預設 2,048 會截尾） |
| 選填 | `MAX_BODY_BYTES` | `16384` | 單塊 body 上限，超過 → 413 |

選填全部不調也能跑。**插件端建議把「每秒最大請求數」設 3~5** —— 並發閘在 Vercel／CF 都是 per-instance，
真正的保護在 client 端。

代理只會補這四項**協定層**參數（你的 prompt 一律不改，規則 9）：`stream: true`、`stream_options.include_usage`、
`chat_template_kwargs.enable_thinking:false`、`max_tokens`（你帶了就不動）。
理由逐項在 [`design/why-proxy.md`](design/why-proxy.md) 與 [`design/streaming-and-chunking.md`](design/streaming-and-chunking.md)。

## 快速驗證（curl）

```bash
B=https://index-translate-proxy.vercel.app
KEY=itp-3c3daf945ef7749f27852d074fb875bb

# 有 key
curl -s -X POST "$B/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[
        {"role":"system","content":"Translate into 繁體中文, keep the numbering."},
        {"role":"user","content":"1. The meeting starts at nine.\n2. Please bring the report."}]}'
# → {"choices":[{"message":{"content":"1. 會議九點開始。\n2. 請把報告帶來。"},"finish_reason":"stop"}]}

# 沒 key（驗證鑑權有在）
curl -s -w "\nHTTP %{http_code}\n" -X POST "$B/v1/chat/completions" -H "content-type: application/json" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[{"role":"user","content":"1. Hi."}]}'
# → 401 {"error":{"message":"未提供 API Key…","type":"authentication_error"}}
```

`Authorization: Bearer` 或 `x-api-key` 都可以；地址帶不帶 `/v1` 都能用（不會補成 `/v1/v1/…`）。

<details>
<summary><b>出錯時怎麼看</b>（status 與標頭對照表）</summary>


錯誤一律是 OpenAI 形狀（`error.message`），插件會直接把 message 顯示出來。回應一律帶：

| 標頭 | 意義 |
|---|---|
| `x-proxy-upstream-stream: forced` | 對上游一律要 SSE（規則 3） |
| `x-proxy-chunks` / `x-proxy-chunk-failed` / `x-proxy-chunk-lines` | 切了幾塊、哪塊失敗、失敗前已譯出幾行 |
| `x-proxy-truncated` | 上游 `finish_reason:"length"`，尾部被截掉了 |
| `x-proxy-auth` | `configured`／`missing`：部署端有沒有設 key |
| `x-proxy-hint` | 只在錯誤回應出現，給建議（不改上游的 status 與 body） |

| 症狀 | 先看什麼 |
|---|---|
| 401 | `x-proxy-auth: missing` → Secret 沒設好；`configured` → 填的不是同一把 key |
| 503 | 沒設 `ITP_KEY`（部署端少了這個變數） |
| 400（模型） | 只放行上面三個模型；訊息會寫「放行的模型：…」 |
| 413 | 單行超長或 body 太大，訊息會說明怎麼繞過 |
| 429 + `Retry-After` | 看 `x-proxy-hint`：是本地閘還是上游回的（上游按 IP 限流，出口共用） |
| 譯到一半就停 | `x-proxy-truncated`／`finish_reason:"length"` |
| 行數對不上 | 上游偶爾回 `choices: []`；代理不重試，原樣傳出去 |

</details>

<details>
<summary><b>開發與測試</b></summary>


```bash
npm run dev       # 本地 miniflare（讀 .dev.vars），打真上游；http://127.0.0.1:8787
npm test          # 81 條離線測試（注入假的 fetch，不碰網路）
npm run smoke     # 51 項端到端冒煙（程序內跑 worker）
npm run serve-bridge  # 用 Node 起 Vercel 入口（不需登入，打真上游）→ 再對 http://127.0.0.1:8788 跑 probe-live
npm run dev:vercel    # 用 Vercel CLI 跑本地（需要 `vercel login`）
npm run lint:zh   # 規則 11：註解與使用者文字一律繁體
node scripts/probe-upstream.mjs --quick   # 上游行為重測，結果存 tests/fixtures/
```

協定碼只有一份（`src/lib/`），入口只做平台橋：`api/index.js`（Vercel Edge，主）、`src/worker.js`（CF）。
設計、實測紀錄與定案在 [`design/`](design/)；不可妥協的規則在 [`AGENTS.md`](AGENTS.md)；待辦在 [`TODO.md`](TODO.md)。

</details>

## 限制（不要假裝比較不脆弱）

- 上游是**免費公網端點**：無 SLA、**60,000 tokens/min per IP** 的配額，而雲端出口 IP 是共用池；模型名稱會被撤回。
- 並發保護是 per-instance（已線上實測），不是全域保證。
- 輸出側截斷：補到 4,096 tokens 只是把問題往後推。
- 從 Cloudflare 出口打不到上游（412）；主入口因此放在 Vercel。
- 上游模型有代幣解碼缺陷（「秦漢→秦漢」）；薄代理不修上游的輸出。

## 授權

MIT（見 [`LICENSE`](LICENSE)）。上游 [bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)
為 Apache-2.0——只引用其事實、模型名稱與 prompt 結構，**沒有逐字複製其程式碼**。
