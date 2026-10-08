# AGENTS.md — Index-Translate-Proxy

> **狀態：骨架。** 只有 `package.json`、`wrangler.toml`、`.gitignore`、`LICENSE`、`README.md` 與本檔。
> `src/` 與測試**尚未建立**，因此 `npm run dev`／`npm run deploy`／CI 都還不存在。
> 本檔的規則是實作時的約束，不是已實裝的行為描述。

## Project Overview

一個 **Cloudflare Worker**，把 bilibili **Index-Translate** 的免費公網 API 以同源端點對外提供，供
**沉浸式翻譯（Immersive Translate）** 等瀏覽器插件與其他 OpenAI 相容客戶端使用。無 UI、無前端。

存在的理由是上游的 **WAF**：非瀏覽器 UA 會被 412 擋（下表）。除此之外它是**薄代理**——不改 prompt、
不換模型、不做快取。

**License: MIT.**（上游是 Apache-2.0，無傳染性；規則 10 講清楚邊界。）

## 上游事實（本 session 實測於 2026-10-08，非推測）

| 項目 | 實測結果 |
|---|---|
| 端點 | `POST https://index-translate.bilibili.com/v1/chat/completions`；`GET /v1/models` 只宣告 `Index-Translate-35B-A3B` |
| **UA 門檻** | 不送 `User-Agent` → **412**；`User-Agent: ""` → **200**；`Python-urllib/*`、`python-requests/*` → **412**（機器人黑名單）；`curl/8.5.0`、瀏覽器 UA、`Cloudflare-Workers`、自訂 token → **200**。加 `Referer`/`Accept-Language` 不能補救 |
| CORS | 帶 `Origin` 時回 `access-control-allow-origin: *`（不帶 `Origin` 時不回此頭 → 用 `curl` 驗證時必須帶 `Origin`，否則會誤判為沒開 CORS） |
| 思考標記 | **不帶** `chat_template_kwargs.enable_thinking` 也不漏 `<think>`（官方 FAQ 說的「偶爾出現」在公網端點重現不了） |
| 多送的欄位 | `n`、`stop`、`presence_penalty`、`frequency_penalty`、`seed`、`user` 與 `Authorization: Bearer <任意字串>` 均可被上游接受（200）→ 純轉發可行 |
| 編號批次 | 三行一次送（`1. …\n2. …\n3. …`）→ 上游保留編號 → 插件的行對應協定可用 |
| 逾時 | 非串流且輸出超過 **10.0s** → 上游回 **HTTP 504**；SSE 端到端緩衝（TTFT ≈ 總時間） |
| 長度 | 35B 輸入約 **4000 字元**會截斷，**1500** 安全（姐妹專案 `design/model-selector.md`） |
| 可達性 | `index-translate.bilibili.com` CNAME → `bilicdn1.com`（海外節點 `103.151.151.x`，`x-cache-webcdn: BYPASS`）→ 不是只在中國大陸可達；但**從 CF edge 的實際延遲未測** |
| 配額 | 無公開配額、無 SLA、免費、不需金鑰；bilibili 會撤回模型名稱（`index-homura-*` 先例） |

模型可用性的三層證據（declared / 被網關接受但未宣告 / 已撤回）在姐妹專案
`translate-cloud/design/model-selector.md`；這個 repo 只引用，不重複寫。

## Non-negotiable rules

1. **不換模型、不降級、不重試別個模型。** 上游回 400/404（未知模型）就照實回，附一句「只有
   `Index-Translate-35B-A3B` 由 `/v1/models` 宣告，請改用它」。靜默降級會讓使用者以為自己選的模型真的跑過。
2. **UA 由本代理固定為瀏覽器樣式 UA，不轉發客戶端 UA。** 這是這個代理存在的主因（見上表）。
3. **一律向上游要串流**（`stream: true`），非串流的客戶端由代理把 SSE 組回單一 `chat.completion`。
   理由：非串流超過 10.0s 會被 504 砍。回應加 `x-proxy-upstream-stream: forced`，讓這件事在 devtools 可見。
4. **超長輸入只在行界切塊**，依序送、**按原本的分隔字元接回**。不得切在行內——插件靠編號行把譯文對應回原文，
   行內切會錯位；只有單行本身超長時才硬切，該處分隔用空字串。
5. **路徑：**接受 `/v1/*`（插件形狀，自訂地址以 `/v1` 結尾）與 `/api/*`（姐妹專案的寫法）；
   **已帶 `/v1` 的路徑絕不再補前綴**（會變成 `/v1/v1/…` → 上游 404）。其他路徑由本代理**本地 404**，不丟給上游。
6. **上游錯誤不改 status、不改 body**，只在同一回應裡加 `hint`（我們的建議）。不包層、不重寫成 500。
7. **並發有上限**（預設 4，`MAX_INFLIGHT` 可調），超過回 **429 + `Retry-After: 2`** 並建議把插件的
   「每秒最大請求數」設 3~5。上游無配額可查，保護只能自己做。
8. **不轉發 `Authorization`、`cookie`、CF 的 `x-*` 標頭**；對上游只帶 `content-type` 與 UA。
   插件填的 key 是假的，沒必要帶進上游。
9. **不注入 prompt 內容**；唯一允許的注入是 `chat_template_kwargs.enable_thinking:false`（上游目前預設已關，
   但官方文件要求客戶端顯式關閉，換端點時不會漏）。除此之外 prompt 是使用者的輸入，不改。
10. **授權邊界：**MIT。上游 `bilibili/Index-Translate` 為 Apache-2.0、姐妹專案 `translate-cloud` 為 AGPL-3.0 →
    **可共用事實、概念與 prompt 結構，不得逐字複製兩者的程式碼**，除非先在授權層面做決定（保留出處聲明 /
    統一授權）。要複用就重寫。
11. **所有使用者可見文字與程式註解一律繁體中文**（與姐妹專案規則 15 相同）。上游的簡體模板原文照引時標注出處。
12. **CI 放 `.forgejo/workflows/`，不放 `.github/workflows/`**（`origin` 是自建 Forgejo 15.0.9）。
    但**先有程式碼才建 CI**——骨架階段加 CI 是假工。
13. **部署是測試環的一環：**`wrangler deploy` 之後必須用**真的 worker** 跑一次探測，至少覆蓋
    插件的 `/v1` 路徑形狀、UA（腳本 UA 打 worker 不該 412）、未知模型的 400、超長段的切塊接回。
    「本機跑過」在這種上傳產物／edge 部署的情境裡不代表線上。

## 待辦（骨架 → 第一版）

1. `src/worker.js` + `src/lib/{route,headers,stream,limits}.js`（對應規則 2–6）。
2. `tests/*.test.mjs`：用 `node --test` 打真實模組、注入假的 `fetch`，離線覆蓋規則 1–7。
3. `scripts/probe-live.mjs`：規則 13 的探測。
4. `.forgejo/workflows/ci.yml`（跑離線測試；label 與 image 沿用姐妹專案的 `mt`）。
5. 部署與 `README` 補上實際 worker 網域。

## 刻意不做

- KV / Cache 快取（免費層寫入配額低，翻譯請求重複率低）。
- DeepL／其他協定的適配層——只做 OpenAI 相容這一條。
- 上游健康檢查或模型探測（`/v1/models` 查不出未宣告模型的可用性，白花一次請求；見姐妹專案規則 12）。
