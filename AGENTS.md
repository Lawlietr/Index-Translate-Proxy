# AGENTS.md — Index-Translate-Proxy

> **狀態：第一版已實裝（本地驗證完），尚未部署。** `src/worker.js` + `src/lib/{route,headers,auth,model,chunk,stream,limits}.js`、
> `tests/*.test.mjs`（67 條離線）、`scripts/{smoke-local,probe-live,probe-upstream,lint-zh}.mjs` 都在。
> 本地 `wrangler dev`（miniflare，打真上游）通過 `probe-live` 的 19 項——**但那不是線上**：
> 規則 13 要求的「打真的 worker」還沒跑，因為還沒 `wrangler deploy`。本檔的規則是實作的約束，
> 不是已上線行為的宣傳。

## Project Overview

一個 **Cloudflare Worker**，把 bilibili **Index-Translate** 的免費公網 API 以同源端點對外提供，供
**沉浸式翻譯（Immersive Translate）** 等瀏覽器插件與其他 OpenAI 相容客戶端使用。無 UI、無前端。

存在的理由是上游的 **WAF**：特定機器人 UA 會被 412 擋（見下表），所以瀏覽器以外的 client（插件的背景腳本、
其他 server 端工具）需要一個固定 UA 的出口。除此之外它是**薄代理**——不改 prompt、不換模型、不做快取。

> ⚠️ **2026-10-10 部署後實測**：上面這段在**本機**成立，但**以 Cloudflare Worker 作為出口不成立**——從 Worker
> 出口打上游一律 412（下表「出口可達性」列）。已完成的部分（協定、鑑權、切塊、組包、測試）都可用，
> 但**要先解決出口**才算能用。選項與證據：`design/upstream-probe-2026-10-10.md` §8。

**License: MIT.**（上游是 Apache-2.0，無傳染性；規則 10 講清楚邊界。）

## 上游事實（公網端點實測，非推測）

列末標注實測日期。本表是 2026-10-10 第二輪重測後的結論，已推翻首測（10-08）的「無配額」「SSE 端到端緩衝」「不送 UA → 412」
「未知模型回 404」「輸入 4,000 字元截斷」五條。原始證據（請求形狀、時間、SSE、錯誤 body）在
`design/upstream-probe-2026-10-10.md` 與 `tests/fixtures/`；跑法：`node scripts/probe-upstream.mjs [群組]`。
尚未證明的項目列在同檔「未證明」節，不要當成事實。

| 項目 | 實測結果 |
|---|---|
| 端點 | `POST https://index-translate.bilibili.com/v1/chat/completions` 與 `/v1/responses`（真 SSE，`response.output_text.delta`）均可用；`/v1/completions` 上游**不存在**（404）；`GET /v1/models` 只宣告 `Index-Translate-35B-A3B` 〔2026-10-10〕 |
| **UA 門檻** | 瓶頸是**特定機器人 UA 黑名單**，不是「有沒有 UA」：`python-requests/*`、`Python-urllib/*` → **412**（HTML 網頁，3,400 字元，93ms 內回，沒進模型）；不送 UA（已用回憶服務自證真的沒送）、`UA: ""`、`curl/8.5.0`、瀏覽器 UA、`Cloudflare-Workers`、`Index-Translate-Client/1.0`、自訂 token → 全部 **200**。加 `Referer`/`Accept-Language` 沒影響。首測（10-08）那格「不送 UA → 412」重現不了，標為不可信〔2026-10-10〕 |
| CORS | 帶 `Origin` 時回 `access-control-allow-origin: *`（不帶 `Origin` 時不回此頭 → 用 `curl` 驗證時必須帶 `Origin`，否則會誤判為沒開 CORS）〔2026-10-08〕 |
| 思考標記 | 不帶 `chat_template_kwargs`、明確 `enable_thinking:false`、明確 `true` 三種都**不吐** `<think>`／`<|im_*|>`；`true` 與 `false` 的輸出長度無差異（183 vs 186 字元）→ 公網端點預設已等同關閉。規則 9 的注入是換端點時的保險，不是當下必需〔2026-10-10〕 |
| 多送的欄位 | `n`、`stop`、`presence_penalty`、`frequency_penalty`、`seed`、`user` 與 `Authorization: Bearer <任意字串>` 均可被上游接受（200）→ 純轉發可行〔2026-10-08〕 |
| `usage` | 串流**預設不給**；帶 `stream_options:{include_usage:true}` 就有（含 `prompt_tokens_details.cached_tokens`）；非串流有 → 代理強制串流時要自己補這個參數才拿得到用量〔2026-10-10〕 |
| 字元→token | 比例依文本變動大，**不可用字元換算**：本輪 6,047 字元 → 3,901 prompt tokens（0.65）、2,400 → 1,584（0.66）；早間另一文本 3,800 → 3,644（0.96）〔2026-10-10〕 |
| 行對應 | 帶翻譯指令（`system` 或 `source_language`/`target_translation`）時：編號行會**逐行**回傳（18/18、34/34、51/51 都對過）。
  **只送編號句不帶指令**時不成立：上游會加前言並把每句展開成多語言列表（3 行→8 行、40 行→7 行），
  或只給一行「好的，請提供需要翻譯的文本。」→ 行對應是**提示條件式**的，不是端點保證〔2026-10-08、2026-10-10〕 |
| 未知模型 | 回 **400**（不是 404），body 用 `detail` 欄位而**不是** OpenAI 的 `error` 形狀，內容自報白名單：`Index-Translate-35B-A3B, index-mt-2b, index-mt-9b, index-mt-2b-syllable, index-mt-9b-syllable`。回顯的 `model` **不可信**：`index-mt-9b` → 200 且回 `qwen35-9b-6624275-iter999`（內部部署名）；`Index-Translate-35B-A3B-preview` → 200 但回 `Index-Translate-35B-A3B`（**靜默退回**）；`model:""` → 靜默用 35B-A3B；已撤回的 `index-homura-*` → 400〔2026-10-10〕 |
| 逾時 | 非串流且輸出超過 **10.0s** → 上游回 **HTTP 504**（openresty）。**SSE 是真增量**：TTFT 170–1,020ms 且**與輸入長度無關**；生成 2,000 tokens 要 16s、2,512 tokens 要 35.7s → 強制串流是必須的（規則 3）〔2026-10-10〕 |
| **輸出上限** | 截斷發生在**輸出側**：預設完成上限 **2,048 tokens**，用完就停並回 **`finish_reason:"length"`**（所以丟尾**可偵測**）。同一份 zh→en 測試文本：輸入 ≤2,400 字元（41 行）完整；≥2,600 字元只回 42 行，且 3,000/4,000/6,000 三者的輸出完全同長。`max_tokens` **被精確尊重**（要 40 就停 40）；`max_tokens:4096` 下 3,040 字元完整譯完（51/51 行、2,512 tokens）；`max_tokens:8192` 停在恰好 4,096 → **推定上游把 max_tokens 鉗在 4,096**（未證實）。zh→en 膨脹比 ≈ 0.83 completion tokens／輸入字元。**舊說法「輸入 4,000 字元會截斷」不成立**〔2026-10-10〕 |
| 可達性 | `index-translate.bilibili.com` CNAME → `bilicdn1.com`（海外節點 `103.151.151.x`，`x-cache-webcdn: BYPASS`）→ 不是只在中國大陸可達〔2026-10-08〕 |
| **出口可達性（致命）** | **從 Worker 出口打上游，全部 412**：任意路徑／方法／UA（含瀏覽器 UA、不設 UA）、走 `http://` 也一樣，`www.bilibili.com/` 同樣 412，而 `api.ipify.org` 正常 200（出口 `2a06:98c0:…`，AS13335）。擋下來的是 **CF 邊緣的 bot 過濾**，條件是出口 IP 的等級，**不是 UA**（UA 在本地能決定 200/412，見上表）。`cf.resolveOverride` 與 `cloudflare:sockets` 直連 bilicdn IP 都不可用（前者仍 412、後者零位元組回應）。上游無 AAAA → 不是 IPv6 問題。出路（未測）：WARP egress／非 CF 中转／上游白名單〔2026-10-10，design/upstream-probe §8〕 |
| 配額 | **有**：`60,000 tokens/min` **per IP**，超出回 **429** + `retry-after: 1`，body 為 `{"error":{"type":"rate_limit_error","code":429,"retry_after":1,…}}`（此形狀為早間實測；同日第二輪堆到 20k tokens/90s 與 36k tokens 併發都**未再觸發 429**，也無配額查詢端點）。**併發不增加吞吐**：10 個併發請求全部成功但總時間 21.9s → 47.8s（≈5 倍），上游近乎串行 → 本地並發上限是必要的（規則 7）。免費、不需金鑰、無 SLA；bilibili 會撤回模型名稱（`index-homura-*` 先例）〔2026-10-10〕 |

模型可用性的三層證據（declared / 被網關接受但未宣告 / 已撤回）原本在**未公開的姐妹專案**
`translate-cloud/design/model-selector.md`，對外不可查證 → 依規則 15，本表只留「未知模型」那列的自報白名單實測，
其餘要自己重測留證據。

## Non-negotiable rules

1. **不換模型、不降級、不重試別個模型。** 上游對未知模型回 **400**（見上表），就照實回，附一句「只有
   `Index-Translate-35B-A3B` 由 `/v1/models` 宣告，請改用它」。靜默降級會讓使用者以為自己選的模型真的跑過。
   風險來自上游自己就會靜默：`model:""` 直接跑 35B-A3B，`-preview` 這類名字回 200 但不保證跑的是那個。
   **本代理只放行 `Index-Translate-35B-A3B`**：上游 400 自報的其他模型（`index-mt-2b/9b/-syllable`）也一律
   **本地 400**，不做 alias、不做試探——要放行得先自己測過（`TODO.md` 待做 10）。
2. **UA 由本代理固定為一個自訂、可識別的標識，不轉發客戶端 UA。** 上游擋的是**特定機器人 UA 黑名單**
   （`python-requests/*`、`Python-urllib/*` → 412），不是「不像瀏覽器」——自訂 token 實測 200，
   官方自己的客戶端也是自訂 token。固定值：`Index-Translate-Proxy/0.1 (+https://github.com/Lawlietr/Index-Translate-Proxy)`。
   不假裝瀏覽器：讓上游看得出流量來源，比偽裝誠實。
3. **一律向上游要串流**（`stream: true`），非串流的客戶端由代理把 SSE 組回單一 `chat.completion`。
   理由：非串流超過 10.0s 會被 504 砍。回應加 `x-proxy-upstream-stream: forced`，讓這件事在 devtools 可見。
   跨塊的拼接要插入原分隔字元的 delta；`usage` 上游缺就不帶，不造假數字（細節見 `design/streaming-and-chunking.md`）。
4. **超長輸入只在行界切塊**，依序送、**按原本的分隔字元接回**。不得切在行內——插件靠編號行把譯文對應回原文，
   行內切會錯位。**單行本身超過 `MAX_LINE_CHARS` 就不切，回 413 並說明怎麼繞過**（不猜、不悄悄改輸入）。
   代理不重編、不刪編號。
   **上限在輸出側**（預設 2,048 completion tokens），所以切塊大小要按「估計輸出 tokens」算，不是只看輸入字元
   （`design/streaming-and-chunking.md` §1）。**必須檢查 `finish_reason === "length"`**：那是尾部被截掉的唯一訊號，
   出現了就不是正常完成（除非 `max_tokens` 是客戶端自己要的）。
   中途某塊失敗時 v1 不補償：整個請求失敗、沿用那塊的 status（語義與理由見同檔 §3）。
5. **路徑：**接受 `/v1/*`（插件形狀，自訂地址以 `/v1` 結尾）與 `/api/*`（內部另一專案的寫法）；
   **已帶 `/v1` 的路徑絕不再補前綴**（會變成 `/v1/v1/…` → 上游 404）。`/v1/responses` 只透傳、不組包。
   上游沒有的路徑（`/v1/completions`）與其他一切路徑由本代理**本地 404**，不丟給上游白費一次配額。
   唯一例外是 `GET /`：回一行文字說明這是 API、地址要填 `…/v1`，並用 `x-proxy-auth: configured|missing`
   讓部署者一眼看出自己有沒有設 key（不碰上游，不算「健康檢查」）。
6. **上游錯誤不改 status、不改 body**，只在同一回應加 **`x-proxy-hint` 標頭**（我們的建議）。不包層、不重寫成 500、
   不在上游的 JSON 裡塞欄位。要讓**使用者**看到的話就放進我們自己產生錯誤的 `error.message`（OpenAI 客戶端會顯示），
   header 只給 devtools 用——插件不會讀 body 裡的自訂欄位。
7. **並發有上限**（預設 4，`MAX_INFLIGHT` 可調）。閘門計的是**同時在途的請求**（一個 request 持有一個 slot，
   切塊依序送、同時只有一塊在途），不是上游塊；一個拆三塊的請求仍只佔一個 slot，但消耗三次上游配額。
   閘滿先在**本地排隊**（`SLOT_WAIT_MS`，預設 15 秒），等不到才回 **429 + `Retry-After: 2`**，並建議把插件的
   「每秒最大請求數」設 3~5。上游的配額是**按 IP** 的（見上表「配額」列），而 Worker 的 egress IP 是共用池 →
   保護只能自己做；上游回的 429 與 `retry-after` 要原樣透傳（規則 6）。细节在 `design/streaming-and-chunking.md` §2。
8. **先鑑權，再轉發；key 不進上游。** worker 必須先驗證**共用的 `ITP_KEY`**（讀 `Authorization: Bearer`，
   退回 `x-api-key`；設計與錯誤形狀見 `design/auth.md`）。驗證在**任何上游請求之前**完成，
   401 不消耗上游配額；**驗完即丟**——不轉發 `Authorization`、`x-api-key`、`cookie`、CF 的 `x-*` 標頭，
   對上游只帶 `content-type` 與 UA（上游不需鑑權）。
9. **不注入 prompt 內容**：不加 system/user 訊息、不改使用者的字。允許的**協定層**注入只有四項，
   每一項都要在 README 看得到：`stream:true`（規則 3）、`chat_template_kwargs.enable_thinking:false`
   （官方要求客戶端顯式關閉，換端點不漏）、`stream_options:{include_usage:true}`
   （上游串流預設不給 `usage`，不補就沒有用量資料）、`max_tokens:4096`（上游預設 2,048 會截尾；
   **客戶端自己帶 `max_tokens` 就尊重，不覆蓋**）。
10. **授權邊界：**MIT。上游 `bilibili/Index-Translate` 為 Apache-2.0、姐妹專案 `translate-cloud` 為 AGPL-3.0 →
    **可共用事實、概念與 prompt 結構，不得逐字複製兩者的程式碼**，除非先在授權層面做決定（保留出處聲明 /
    統一授權）。要複用就重寫。
11. **所有使用者可見文字與程式註解一律繁體中文**（與姐妹專案規則 15 相同）。上游的簡體模板原文照引時標注出處。
12. **CI 放 `.forgejo/workflows/`，不放 `.github/workflows/`**（`origin` 是自建 Forgejo 15.0.9）。
    程式碼已在，所以 CI 是該補的一項（見 TODO）；但在它之前，**部署與線上探測優先**。
13. **部署是測試環的一環：**`wrangler deploy` 之後必須用**真的 worker** 跑一次探測，至少覆蓋
    插件的 `/v1` 路徑形狀、UA（腳本 UA 打 worker 不該 412）、未知模型的 400、超長段的切塊接回、
    **拆塊請求中途失敗時的 status 與 `x-proxy-chunk-failed`**、**`GET /` 的一行回應與 `x-proxy-auth`**、
    未帶 key 的 401 形狀、上游 429 的 `retry-after` 是否原樣送出。
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
