<h1 align="center">Index-Translate-Proxy</h1>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/%F0%9F%87%B9%F0%9F%87%BC_%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-2ea44f?style=for-the-badge" alt="🇹🇼 繁體中文"></a>
  <a href="README.en.md"><img src="https://img.shields.io/badge/%F0%9F%87%AC%F0%9F%87%A7_English-555555?style=for-the-badge" alt="🇬🇧 English"></a>
</p>

<p align="center"><b>(◕ᴗ◕)</b> <sub>這份 README 有兩個語言版本，內容 100% 對等——改一份會同步另一份</sub></p>

<p align="center">
  把 bilibili <b>Index-Translate</b>（免費的翻譯模型，OpenAI 相容 API）接成一個 OpenAI 相容端點，貼進瀏覽器插件或其他 client 就能用。<br>
  這是一個薄代理：不改 prompt、不換模型、不快取。<br>
  只做能被插件用上需要的那幾件事：固定 UA、路徑正規化、強制串流、行界切塊，外加一把自己的通行碼。
</p>

部署在自己的 Vercel 專案上：免費、不需 GPU、不需上游的帳號，五分鐘跑起來。

用它來做：

- **網頁翻譯**：沉浸式翻譯（Immersive Translate）的「翻譯服務 → OpenAI → 自訂接口地址」填你自己的網址。
- **任何 OpenAI 相容 client**：`curl`、OpenAI SDK、LangChain 之類的工具，填 base URL 就能用。
- **自己的翻譯後端**：給自家 app／腳本一個不用 GPU、不用付費的翻譯出口。

為什麼中間需要一個代理、它不解決什麼：[`design/why-proxy.md`](design/why-proxy.md)（`design/` 這些內部文件目前只有中文）。

## 部署（Vercel，五分鐘）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy&project-name=index-translate-proxy&repository-name=index-translate-proxy&env=ITP_KEY&envDescription=%E4%BD%A0%E8%87%AA%E5%B7%B1%E8%A8%AD%E5%AE%9A%E7%9A%84%E9%80%9A%E8%A1%8C%E7%A2%BC%EF%BC%88openssl%20rand%20-hex%2032%EF%BC%89&envLink=https%3A%2F%2Fgithub.com%2FLawlietr%2FIndex-Translate-Proxy%2Fblob%2Fmain%2FREADME.md)

**必填只有一項：`ITP_KEY`** —— 你自己隨意定的一串字，客戶端要帶它才能用（不是上游的 key，上游不需鑑權）。
產生一把：

```bash
openssl rand -hex 32    # 輸出就是之後填進插件「API Key」欄位的值
```

值本身沒有長度或格式要求（別帶前後空白、建議就用這種純 hex）。改了值之後要**重新部署**才生效。

按按鈕 → 在那個欄位貼上這串 → Deploy。沒有構建步驟，不需要伺服器、不需要 GPU。
不想用按鈕：Vercel → Import 這個 repo（Framework 選 Other）→ Environment Variables 加 `ITP_KEY` → Deploy。

```bash
# 部署完確認一切正常（21 項協定檢查：鑑權、切塊、413、429 透傳、串流…）
node scripts/probe-live.mjs https://<你的專案>.vercel.app --key <你的 ITP_KEY>
```

<details>
<summary>要放到 Cloudflare Workers？（目前不行，原因在裡面）</summary>

同一份協定碼、同一個變數（`npx wrangler secret put ITP_KEY && npx wrangler deploy`）。但 2026-10-10
實測：**從 Cloudflare 的出口打上游會被風控 412**，那個入口翻譯不了東西，所以預設入口放在 Vercel。
三個出口選項的實測比較在 [`design/egress-options.md`](design/egress-options.md)。

</details>

## 部署完：插件怎麼填

| 欄位 | 值 |
|---|---|
| 接口地址（base URL） | `https://<你的專案>.vercel.app/v1`（帶不帶 `/v1` 都能用，不會補成 `/v1/v1/…`） |
| 模型 | `Index-Translate-35B-A3B`（預設）、`index-mt-9b`、`index-mt-2b`（較快）。只這三個，填別的會被 400 |
| API Key | 你剛才那串 `ITP_KEY` |

想看某個實例實際放行了哪些模型：`curl -H "Authorization: Bearer $KEY" <你的網址>/v1/models`
（由本代理自己回，不轉發上游、不消耗配額）。

## 驗證（curl）

```bash
B=https://<你的專案>.vercel.app
KEY=<你的 ITP_KEY>

curl -s -X POST "$B/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[
        {"role":"system","content":"Translate into 繁體中文, keep the numbering."},
        {"role":"user","content":"1. The meeting starts at nine.\n2. Please bring the report."}]}'
# → {"choices":[{"message":{"content":"1. 會議九點開始。\n2. 請把報告帶來。"},"finish_reason":"stop"}]}

# 不帶 key：應該要看到 401（代表門有在）
curl -s -w "\nHTTP %{http_code}\n" -X POST "$B/v1/chat/completions" -H "content-type: application/json" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[{"role":"user","content":"1. Hi."}]}'
# → 401 {"error":{"message":"未提供 API Key…","type":"authentication_error"}}
```

`Authorization: Bearer` 與 `x-api-key` 都接受。開 `https://<你的專案>.vercel.app/` 會回一行說明，
並在 `x-proxy-auth` 告訴你部署端有沒有設好 key——除錯時不用翻控制台。

## 設定

**必填只有一個**：`ITP_KEY`（Secret）。沒設定 → 所有請求 **503**，不會變成公開端點。
**其他全都有預設值，不調也能跑。**

<details>
<summary>選填的微調項（一般不用動）</summary>

| 名稱 | 預設 | 什麼時候需要調 |
|---|---|---|
| `MAX_INFLIGHT` | `4` | 同一個部署要 concurrently 給多個 app 用，或插件並發設得較高 |
| `SLOT_WAIT_MS` | `15000` | 排隊等不到就 429；想更早放手或多等一會兒 |
| `MAX_INPUT_CHARS` | `2500` | 切塊大小（上游的截斷在輸出側，這個值是保守邊界） |
| `MAX_LINE_CHARS` | `2000` | 只在行界切塊，所以這個值是單行上限（超長 → 413 並說明繞法） |
| `MAX_TOKENS_DEFAULT` | `4096` | 客戶端沒帶 `max_tokens` 時補的值（上游預設 2,048 會截尾） |
| `MAX_BODY_BYTES` | `16384` | 單塊 body 上限，超過 → 413 |

要調就在 Vercel 的 Environment Variables 加同名變數，重新部署生效。

</details>

**插件端建議把「每秒最大請求數」設 3~5** —— 並發閘是 per-instance 的，真正的保護在 client 端
（上游按 IP 限流，而雲端出口 IP 是共用池）。

代理只會補這四項**協定層**參數（你的 prompt 一律不改）：`stream: true`、`stream_options.include_usage`、
`chat_template_kwargs.enable_thinking:false`、`max_tokens`（你帶了就不動）。理由在
[`design/why-proxy.md`](design/why-proxy.md) 與 [`design/streaming-and-chunking.md`](design/streaming-and-chunking.md)。

<details>
<summary><b>出錯時怎麼看</b>（status 與標頭對照）</summary>

錯誤一律是 OpenAI 形狀（`error.message`），插件會直接把 message 顯示出來。回應一律帶：

| 標頭 | 意義 |
|---|---|
| `x-proxy-upstream-stream: forced` | 對上游一律要 SSE（非串流會被上游 10s 砍） |
| `x-proxy-chunks` / `x-proxy-chunk-failed` / `x-proxy-chunk-lines` | 切了幾塊、哪塊失敗、失敗前已譯出幾行 |
| `x-proxy-truncated` | 上游 `finish_reason:"length"`，尾部被截掉了 |
| `x-proxy-auth` | `configured`／`missing`：部署端有沒有設 key |
| `x-proxy-hint` | 只在錯誤回應出現，給建議（不改上游的 status 與 body） |

| 症狀 | 先看什麼 |
|---|---|
| 401 | `x-proxy-auth: missing` → Secret 沒設好；`configured` → 填的不是同一串 |
| 503 | 部署端少了 `ITP_KEY` |
| 400（模型） | 只放行上面三個；訊息會寫「放行的模型：…」 |
| 413 | 單行超長或 body 太大，訊息會說明怎麼繞過 |
| 429 + `Retry-After` | 看 `x-proxy-hint`：是本地閘還是上游回的 |
| 譯到一半就停 | `x-proxy-truncated`／`finish_reason:"length"` |
| 行數對不上 | 上游偶爾回 `choices: []`；代理不重試，原樣傳出去 |

</details>

<details>
<summary><b>開發與測試</b></summary>

```bash
npm run dev       # 本地 miniflare（讀 .dev.vars），打真上游；http://127.0.0.1:8787
npm test          # 82 條離線測試（注入假的 fetch，不碰網路）
npm run smoke     # 51 項端到端冒煙（程序內跑 worker）
npm run serve-bridge  # 用 Node 起 Vercel 入口（不需登入，打真上游）→ 再對 http://127.0.0.1:8788 跑 probe-live
npm run dev:vercel    # 用 Vercel CLI 跑本地（需要 `vercel login`）
npm run lint:zh   # 註解與使用者文字一律繁體（規則 11）
node scripts/probe-upstream.mjs --quick   # 上游行為重測，結果存 tests/fixtures/
npm run lint:readme # 兩份 README 的結構對等檢查（改一份要同步另一份）
```

協定碼只有一份（`src/lib/`），入口只做平台橋：`api/index.js`（Vercel，主）、`src/worker.js`（CF，保留）。
設計、實測紀錄與定案在 [`design/`](design/)；不可妥協的規則在 [`AGENTS.md`](AGENTS.md)；待辦在 [`TODO.md`](TODO.md)（這三個都是內部文件，只有中文）。
上游的事實（UA 黑名單、配額、輸出上限…）都是**自己重測過的**，跑法：`node scripts/probe-upstream.mjs`。

</details>

## 限制（不假裝自己比較不脆弱）

- 上游是**免費公網端點**：無 SLA、**60,000 tokens/min per IP**，雲端出口 IP 是共用池；模型名稱會被撤回。
- 並發保護是 per-instance，不是全域保證。
- 輸出側截斷：補到 4,096 tokens 只是把問題往後推。
- 從 Cloudflare 出口打不到上游（412），所以預設入口是 Vercel。
- 上游模型有代幣解碼缺陷（「秦漢→秦漢」）；薄代理不修上游的輸出。

## 授權

MIT（見 [`LICENSE`](LICENSE)）。上游 [bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)
為 Apache-2.0——只引用其事實、模型名稱與 prompt 結構，**沒有逐字複製其程式碼**。

主要開發在自建 Forgejo，GitHub 是公開鏡像；issue／PR 請到主 repo。
