# AGENTS.md — Index-Translate-Proxy

> **狀態：骨架。** 只有 `package.json`、`wrangler.toml`、`.gitignore`、`LICENSE`、`README.md`、`TODO.md`、
> `design/`（兩份設計檔）與本檔。`src/` 與測試**尚未建立**，因此 `npm run dev`／`npm run deploy`／CI 都還不存在。
> 本檔的規則是實作時的約束，不是已實裝的行為描述。

## Project Overview

一個 **Cloudflare Worker**，把 bilibili **Index-Translate** 的免費公網 API 以同源端點對外提供，供
**沉浸式翻譯（Immersive Translate）** 等瀏覽器插件與其他 OpenAI 相容客戶端使用。無 UI、無前端。

存在的理由是上游的 **WAF**：非瀏覽器 UA 會被 412 擋（下表）。除此之外它是**薄代理**——不改 prompt、
不換模型、不做快取。

**License: MIT.**（上游是 Apache-2.0，無傳染性；規則 10 講清楚邊界。）

## 上游事實（公網端點實測，非推測）

列末標注實測日期。2026-10-10 的重測推翻了首測（2026-10-08）的**配額、串流行為、未知模型的錯誤形狀**三條，
本表已是重測後的結論；原始證據（請求形狀、時間、回應片段）待落成 `design/upstream-probe-2026-10-10.md`
（[`TODO.md`](TODO.md) 待做 1）。

| 項目 | 實測結果 |
|---|---|
| 端點 | `POST https://index-translate.bilibili.com/v1/chat/completions` 與 `/v1/responses`（真 SSE，`response.output_text.delta`）均可用；`/v1/completions` 上游**不存在**（404）；`GET /v1/models` 只宣告 `Index-Translate-35B-A3B` 〔2026-10-10〕 |
| **UA 門檻** | 不送 `User-Agent` → **412**；`User-Agent: ""` → **200**；`Python-urllib/*`、`python-requests/*` → **412**（機器人黑名單）；`curl/8.5.0`、瀏覽器 UA、`Cloudflare-Workers`、自訂 token → **200**。加 `Referer`/`Accept-Language` 不能補救〔2026-10-08〕。官方自己的客戶端用 `Index-Translate-Client/1.0` → 200，所以**不必假裝瀏覽器**（規則 2 的 UA 形式見 `TODO.md` 待做 1） |
| CORS | 帶 `Origin` 時回 `access-control-allow-origin: *`（不帶 `Origin` 時不回此頭 → 用 `curl` 驗證時必須帶 `Origin`，否則會誤判為沒開 CORS）〔2026-10-08〕 |
| 思考標記 | 不帶 `chat_template_kwargs` 與明確傳 `enable_thinking:false` 的輸出**完全相同**，三種模式都不吐 `<think>` → 公網端點預設已等同關閉。開思考的實際風險是**生成變長 → 撞 10s 504** 與摻入非譯文文字，不是標籤洩漏〔2026-10-10〕 |
| 多送的欄位 | `n`、`stop`、`presence_penalty`、`frequency_penalty`、`seed`、`user` 與 `Authorization: Bearer <任意字串>` 均可被上游接受（200）→ 純轉發可行〔2026-10-08〕 |
| 編號批次 | 三行一次送（`1. …\n2. …\n3. …`）→ 上游保留編號 → 插件的行對應協定可用〔2026-10-08〕 |
| 未知模型 | 回 **400**（不是 404），且 400 的 body **自報白名單**：`Index-Translate-35B-A3B, index-mt-2b, index-mt-9b, index-mt-2b-syllable, index-mt-9b-syllable`；`Index-Translate-9B/2B/-preview` 回 200 且 `model` 原樣回顯（實際跑哪個未證明）；`model:""` → 靜默用 35B-A3B〔2026-10-10〕 |
| 逾時 | 非串流且輸出超過 **10.0s** → 上游回 **HTTP 504**（openresty）。**SSE 是真增量**：1,400 字元輸入非串流 → 10.1s / 504；同一輸入 `stream:true` → 6.6s、TTFT 0.64s、757 個 delta（首測「端到端緩衝、TTFT≈總時間」已作廢）〔2026-10-10〕 |
| 長度 | 「35B 輸入約 **4000 字元**會截斷、**1500** 安全」是**引用**（未公開的姐妹專案），本 repo 未重測 → 階梯式重測列在 `TODO.md` 待做 1。另測得 3,800 字元 ≈ 3,644 prompt tokens（CJK ≈ 1.04 token/字元），可用於字元數粗估〔2026-10-10〕 |
| 可達性 | `index-translate.bilibili.com` CNAME → `bilicdn1.com`（海外節點 `103.151.151.x`，`x-cache-webcdn: BYPASS`）→ 不是只在中國大陸可達；但**從 CF edge 的實際延遲未測**〔2026-10-08〕 |
| 配額 | **有**：`60,000 tokens/min` **per IP**，超出回 **429** + `retry-after: 1`，body 為 `{"error":{"type":"rate_limit_error","code":429,"retry_after":1,…}}`。免費、不需金鑰、無 SLA、沒有配額查詢端點；bilibili 會撤回模型名稱（`index-homura-*` 先例）〔2026-10-10〕 |

模型可用性的三層證據（declared / 被網關接受但未宣告 / 已撤回）原本在**未公開的姐妹專案**
`translate-cloud/design/model-selector.md`，對外不可查證 → 依規則 15，本表只留「未知模型」那列的自報白名單實測，
其餘要自己重測留證據。

## Non-negotiable rules

1. **不換模型、不降級、不重試別個模型。** 上游對未知模型回 **400**（見上表），就照實回，附一句「只有
   `Index-Translate-35B-A3B` 由 `/v1/models` 宣告，請改用它」。靜默降級會讓使用者以為自己選的模型真的跑過。
   風險來自上游自己就會靜默：`model:""` 直接跑 35B-A3B，`-preview` 這類名字回 200 但不保證跑的是那個。
2. **UA 由本代理固定為一個自己挑的 UA，不轉發客戶端 UA。** 這是本代理存在的主因（見上表：機器人 UA 會 412）。
   字面值尚未定——上游並不要求瀏覽器樣式（官方自己的 `Index-Translate-Client/1.0` 也回 200），改成可識別的
   自訂 UA 比較誠實；決定要做的補測列在 `TODO.md` 待做 1。
3. **一律向上游要串流**（`stream: true`），非串流的客戶端由代理把 SSE 組回單一 `chat.completion`。
   理由：非串流超過 10.0s 會被 504 砍。回應加 `x-proxy-upstream-stream: forced`，讓這件事在 devtools 可見。
4. **超長輸入只在行界切塊**，依序送、**按原本的分隔字元接回**。不得切在行內——插件靠編號行把譯文對應回原文，
   行內切會錯位；只有單行本身超長時才硬切，該處分隔用空字串。
5. **路徑：**接受 `/v1/*`（插件形狀，自訂地址以 `/v1` 結尾）與 `/api/*`（內部另一專案的寫法）；
   **已帶 `/v1` 的路徑絕不再補前綴**（會變成 `/v1/v1/…` → 上游 404）。`/v1/responses` 只透傳、不組包。
   上游沒有的路徑（`/v1/completions`）與其他一切路徑由本代理**本地 404**，不丟給上游白費一次配額。
6. **上游錯誤不改 status、不改 body**，只在同一回應裡加 `hint`（我們的建議）。不包層、不重寫成 500。
7. **並發有上限**（預設 4，`MAX_INFLIGHT` 可調），超過回 **429 + `Retry-After: 2`**，並建議把插件的
   「每秒最大請求數」設 3~5。上游的配額是**按 IP** 的（見上表「配額」列），而 Worker 的 egress IP 是共用池
   → 保護只能自己做；上游回的 429 與 `retry-after` 要原樣透傳（規則 6）。
8. **先鑑權，再轉發；key 不進上游。** worker 必須先驗證**共用的 `ITP_KEY`**（讀 `Authorization: Bearer`，
   退回 `x-api-key`；設計與錯誤形狀見 `design/auth.md`）。驗證在**任何上游請求之前**完成，
   401 不消耗上游配額；**驗完即丟**——不轉發 `Authorization`、`x-api-key`、`cookie`、CF 的 `x-*` 標頭，
   對上游只帶 `content-type` 與 UA（上游不需鑑權）。
9. **不注入 prompt 內容**；唯一允許的注入是 `chat_template_kwargs.enable_thinking:false`（上游目前預設已關，
   但官方文件要求客戶端顯式關閉，換端點時不會漏）。除此之外 prompt 是使用者的輸入，不改。
10. **授權邊界：**MIT。上游 `bilibili/Index-Translate` 為 Apache-2.0、姐妹專案 `translate-cloud` 為 AGPL-3.0 →
    **可共用事實、概念與 prompt 結構，不得逐字複製兩者的程式碼**，除非先在授權層面做決定（保留出處聲明 /
    統一授權）。要複用就重寫。
11. **所有使用者可見文字與程式註解一律繁體中文**（與姐妹專案規則 15 相同）。上游的簡體模板原文照引時標注出處。
12. **CI 放 `.forgejo/workflows/`，不放 `.github/workflows/`**（`origin` 是自建 Forgejo 15.0.9）。
    但**先有程式碼才建 CI**——骨架階段加 CI 是假工。
13. **部署是測試環的一環：**`wrangler deploy` 之後必須用**真的 worker** 跑一次探測，至少覆蓋
    插件的 `/v1` 路徑形狀、UA（腳本 UA 打 worker 不該 412）、未知模型的 400、超長段的切塊接回、
    **未帶 key 的 401 形狀**、上游 429 的 `retry-after` 是否原樣送出。
    「本機跑過」在這種上傳產物／edge 部署的情境裡不代表線上。
14. **文件分工：**`TODO.md` 只放待做項目與最多五項已完成（置底）；設計、實測紀錄、規格拆解一律放
    `design/`；更早的完成紀錄查 `git log --oneline`。同一件事的真相只能有一處——`AGENTS.md` 寫結論，
    證據與細節放 `design/`，`TODO.md` 只寫「要做什麼」。
15. **對外文件不提未公開的專案：**姐妹專案仍在開發、短時間不會公開 → `README.md`（還有未來網站／說明檔）
    **不出現其名稱與內網 URL**（`192.168.x.x` 那種連結對外一定是碎的）。`AGENTS.md`、`design/` 這些 contributor
    文件可以提，但首次提到要標「未公開」，而且**引用過的事實要在本 repo 留下自己的實測證據**，
    不然是無法查證的引用。

## 待辦

見 [`TODO.md`](TODO.md)（規則 14：待辦只在那一處）。

## 刻意不做

- KV / Cache 快取（免費層寫入配額低，翻譯請求重複率低）。
- DeepL／其他協定的適配層——只做 OpenAI 相容這一條。
- 上游健康檢查或模型探測（`/v1/models` 查不出未宣告模型的可用性，白花一次請求；姐妹專案規則 12 同一結論）。
