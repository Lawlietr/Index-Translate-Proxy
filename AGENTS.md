# AGENTS.md — Index-Translate-Proxy

> **狀態：已實裝並已上線。** 已部署的那份是**我自己用的**（`https://index-translate-proxy.vercel.app`）——
> 不是公共實例，也不對外發 key（定位見「刻意不做」）。線上探測 `probe-live` **22 ok / 0 fail / 1 skip**
> （跳過的是 per-instance 併發閘，平台上不可測），`probe-sse-timing` 兩側真增量。
> 2026-10-11 起這件事**由 GitHub Actions 每日排程重跑**，client 端**不是我的網路**（GitHub 托管 runner 的出口）：
> `38107205187` 是 21/0/1；加上建置對應的檢查之後是 22/0/1，而且總結行會印出**跑的是哪個 commit**
> （`38108762173`：`建置 255b30db7f21`，26.3s）。上游那一跳仍是從 Vercel 出口出去（就是生產路徑）。放行清單（規則 1）也已線上驗證
> （含「`index-mt-9b` 經本代理真的能翻」與「`-syllable` 被擋」兩項）。

## Project Overview

一個 **Vercel 上的 Edge 函式**（同一份協定碼也有 **Cloudflare Worker** 入口，因出口 412 暫未啟用），把 bilibili
**Index-Translate** 的免費公網 API 以同源端點對外提供，供
**沉浸式翻譯（Immersive Translate）** 等瀏覽器插件與其他 OpenAI 相容客戶端使用。無 UI、無前端。

存在的理由是上游的 **WAF**：特定機器人 UA 會被 412 擋（見下表），所以瀏覽器以外的 client（插件的背景腳本、
其他 server 端工具）需要一個固定 UA 的出口。除此之外它是**薄代理**——不改 prompt、不換模型、不做快取。

> ⚠️ **2026-10-10 部署後實測**：上面這段在**本機**成立，但**以 Cloudflare Worker 作為出口不成立**——從 Worker
> 出口打上游一律 412（下表「出口可達性」列）。已完成的部分（協定、鑑權、切塊、組包、測試）都可用，
> 但**要先解決出口**才算能用。原因已定：那個域名**依 client 解析到不同的 CDN 前端**，從 Worker 出去會落到
> bilibili 的 **CF 代理那一側**而被風控擋掉；**已驗證從 Vercel 出口能打到上游**（§10）。
> 選項與證據：`design/upstream-probe-2026-10-10.md` §8–§10、`design/egress-options.md`。
> **這段講的是 CF 那份入口**（代碼保留、不啟用）；現行主入口是 Vercel，已上線可用。換出口的事已定案，
> 不再評估也不再重復提問：`design/egress-options.md` §4。

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
| 未知模型 | 回 **400**（不是 404），body 用 `detail` 欄位而**不是** OpenAI 的 `error` 形狀，內容自報白名單：`Index-Translate-35B-A3B, index-mt-2b, index-mt-9b, index-mt-2b-syllable, index-mt-9b-syllable`。回顯的 `model` **不可信**：`index-mt-9b` → 200 且回 `qwen35-9b-6624275-iter999`（內部部署名）；`Index-Translate-35B-A3B-preview` → 200 但回 `Index-Translate-35B-A3B`（**靜默退回**）；`model:""` → 靜默用 35B-A3B；已撤回的 `index-homura-*` → 400。**逐個實測過**（`probe-upstream.mjs model lines`）：`index-mt-2b`/`index-mt-9b` 200、編號行逐行對應（8/8）、比 35B 快（545ms vs 2,026ms / 8 行）；兩個 `-syllable` 會破掉編號行（9b 只回 1/8 行就 `stop`、2b 把編號丟掉）→ 本代理放行前三者、擋掉 `-syllable`。回顯的內部部署名不能再送回去（會 400）。證據與決定：`design/model-allowlist.md`〔2026-10-10〕 |
| 逾時 | 非串流且輸出超過 **10.0s** → 上游回 **HTTP 504**（openresty）。**SSE 是真增量**：TTFT 170–1,020ms 且**與輸入長度無關**；生成 2,000 tokens 要 16s、2,512 tokens 要 35.7s → 強制串流是必須的（規則 3）〔2026-10-10〕 |
| **輸出上限** | 截斷發生在**輸出側**：預設完成上限 **2,048 tokens**，用完就停並回 **`finish_reason:"length"`**（所以丟尾**可偵測**）。同一份 zh→en 測試文本：輸入 ≤2,400 字元（41 行）完整；≥2,600 字元只回 42 行，且 3,000/4,000/6,000 三者的輸出完全同長。`max_tokens` **被精確尊重**（要 40 就停 40）；`max_tokens:4096` 下 3,040 字元完整譯完（51/51 行、2,512 tokens）。**上游對 `max_tokens` 的硬上限就是 4,096**（已證，不再是推定）：`max_tokens:16384` ＋ 6,000 字元輸入 → 只給**恰好 4,096**、`finish_reason:"length"`、101 行只回 83 行（80.9s、TTFT 1.9s；prompt 4,103/completion 4,096）。〔2026-10-11，`node scripts/probe-upstream.mjs ceiling`，`tests/fixtures/ceiling-16384.summary.json`〕zh→en 膨脹比 ≈ 0.83 completion tokens／輸入字元。**舊說法「輸入 4,000 字元會截斷」不成立**〔2026-10-10〕 |
| 可達性 | `index-translate.bilibili.com` CNAME → `bilicdn1.com`（海外節點 `103.151.151.x`，`x-cache-webcdn: BYPASS`）→ 不是只在中國大陸可達〔2026-10-08〕 |
| **出口可達性（致命）** | **從 Worker 出口打上游，全部 412**：任意路徑／方法／UA（含瀏覽器 UA、不設 UA）、走 `http://` 也一樣，`www.bilibili.com/` 同樣 412，而 `api.ipify.org` 正常 200（出口 `2a06:98c0:…`，AS13335）。`cf.resolveOverride` 與 `cloudflare:sockets` 直連 bilicdn IP 都不能繞過（前者仍 412、後者零位元組回應）。上游無 AAAA → 不是 IPv6 問題〔2026-10-10，§8〕 |
| **兩條路的成因與可用出口** | 412 的 body 是 **bilibili 自己的風控模板**（「触发…安全风控策略」／`{"code":-412,"message":"request was banned"}`），不是 CF 錯誤頁。成因：同一 host **依 client 解析到不同 CDN 前端** —— 從 Worker 落到 **CF 代理**（`server: cloudflare`）→ 風控 412；從**本機**或 **Vercel 出口**（AWS `54.172.44.226`／`iad1`）落到 bilibili 自家 `blzone*` webcdn（`server: uvicorn`、**無 `cf-ray`**）→ **200 ×6**（含 `GET /v1/models` 與真增量 SSE）。→ **已驗證可用的非 CF 出口：Vercel**（到上游 RTT 暖 228–235ms，比本機慢 5–6 倍）〔2026-10-10，§9–§10〕 |
| **為什麼 412（第五輪定案）** | 擋人的**不是 CF 的錯誤頁，是 bilibili 自己的風控**（`由于触发哔哩哔哩安全风控策略，该次访问请求被拒绝`〔上游原文〕、`{"code":-412,"message":"request was banned"}`）。**同一個 host 有兩條路**：本機直連 = `103.151.151.x`（bilicdn）、`server: uvicorn`、`x-cache-webcdn: BYPASS`、**無 `cf-ray`** → **200**；從 Worker 出口 = 落進 bilibili 的 **CF 代理邊緣**（`server: cloudflare`）→ 被它的 origin 風控擋。重點是**目的地走哪條路**，不是 UA、也不只是來源 IP → **WARP egress 只換來源不換目的地**，未測、不保證有效。可行度高的是 **Tunnel origin（自架 connector）**：Worker 打自己 zone 的 Tunnel 入口（CF 內部，不會被擋），由本地機器打上游。自己帳號裡 2026-10-06 的舊 worker `bil-translate-proxy`（同目的地、瀏覽器 UA）現在也是 412 → 與本專案代碼無關〔§8–§9〕 |
| 配額 | **有**：`60,000 tokens/min` **per IP**，超出回 **429** + `retry-after: 1`，body 為 `{"error":{"type":"rate_limit_error","code":429,"retry_after":1,…}}`（此形狀為早間實測；同日第二輪堆到 20k tokens/90s 與 36k tokens 併發都**未再觸發 429**，也無配額查詢端點）。**併發不增加吞吐**：10 個併發請求全部成功但總時間 21.9s → 47.8s（≈5 倍），上游近乎串行 → 本地並發上限是必要的（規則 7）。免費、不需金鑰、無 SLA；bilibili 會撤回模型名稱（`index-homura-*` 先例）〔2026-10-10〕 |

模型可用性的三層證據（declared / 被網關接受但未宣告 / 已撤回）原本在**未公開的姐妹專案**
`translate-cloud/design/model-selector.md`，對外不可查證 → 依規則 15，本表只留「未知模型」那列的自報白名單實測，
其餘要自己重測留證據。

## Non-negotiable rules

1. **不換模型、不降級、不重試別個模型。** 上游對未知模型回 **400**（見上表），就照實回，附一句「只有
   `Index-Translate-35B-A3B` 由 `/v1/models` 宣告，請改用它」。靜默降級會讓使用者以為自己選的模型真的跑過。
   風險來自上游自己就會靜默：`model:""` 直接跑 35B-A3B，`-preview` 這類名字回 200 但不保證跑的是那個。
   **放行清單只有一份**（`src/lib/model.js`）：`Index-Translate-35B-A3B`、`index-mt-9b`、`index-mt-2b`——
   這三個是**自己測過能用**（含編號行逐行對應）才進去的，見 `design/model-allowlist.md`。
   兩個 `index-mt-*-syllable` **刻意不放行**：實測會漏行/丟編號，對插件來說比 400 更糟；`-preview`、
   `model:""` 這類**靜默退回**也不放行。不做 alias、不做試探；不在清單上的一律**本地 400**，
   訊息要把可用清單與「為什麼擋掉某個名字」寫清楚（插件會顯示 `error.message`）。
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
   `GET /v1/models` 由**本代理自己回**放行清單（不花上游配額；上游那份只宣告 35B-A3B，照抄會跟實際放行的不一致）。
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
   保護只能自己做；上游回的 429 與 `retry-after` 要原樣透傳（規則 6）。細節在 `design/streaming-and-chunking.md` §2。
   **但這個閘在兩個平台都是 per-instance**（2026-10-10 線上實測：Vercel 把 12 個併發分散到 6+ 個實例，一個都不擋；
   線上探測因此對這一項只驗證 429 的**形狀**，不宣稱全域保護）。真的全域閘需 Durable Objects（CF）或外部計數
   （Vercel，付費）**已定案不做**：這份部署不依賴任何付費服務，也不為一把併發計數升級或換平台。
   因此**規則 7 是 per-instance 的盡力而為**（不是全域保證），主要防線是插件端的並發設定（README 已寫 3~5）；
   錯誤訊息與文件都不宣稱全域保護，往後也不再重新評估這一項。
8. **先鑑權，再轉發；key 不進上游。** worker 必須先驗證**這一份部署的 `ITP_KEY`**（讀 `Authorization: Bearer`，
   退回 `x-api-key`；設計與錯誤形狀見 `design/auth.md`）。**沒有 `ITP_KEY` 就一律回 503**——這個代理是
   給自己部署、自己用的，不做匿名公開端點。鑑權在**任何上游請求之前**完成，401 不消耗上游配額；
   **驗完即丟**——不轉發 `Authorization`、`x-api-key`、`cookie`、CF 的 `x-*` 標頭，對上游只帶
   `content-type` 與 UA（上游不需鑑權）。
9. **不注入 prompt 內容**：不加 system/user 訊息、不改使用者的字。允許的**協定層**注入只有四項，
   每一項都要在 README 看得到：`stream:true`（規則 3）、`chat_template_kwargs.enable_thinking:false`
   （官方要求客戶端顯式關閉，換端點不漏）、`stream_options:{include_usage:true}`
   （上游串流預設不給 `usage`，不補就沒有用量資料）、`max_tokens:4096`（上游預設 2,048 會截尾；
   **客戶端自己帶 `max_tokens` 就尊重，不覆蓋**）。第四項現在有實測支撐：**4,096 同時也是上游的硬上限**
   （見事實表「輸出上限」列），所以這個注入值既不是保守值也不能再抬高。客戶端帶超過 4,096 的值時，上游會
   **靜默**鉗掉 → 本代理不改他的值，只在 `x-proxy-hint` 說明尾部少的是誰造成的（規則 6）。
10. **授權邊界：**MIT。上游 `bilibili/Index-Translate` 為 Apache-2.0、姐妹專案 `translate-cloud` 為 AGPL-3.0 →
    **可共用事實、概念與 prompt 結構，不得逐字複製兩者的程式碼**，除非先在授權層面做決定（保留出處聲明 /
    統一授權）。要複用就重寫。
11. **所有使用者可見文字與程式註解一律繁體中文**（與姐妹專案規則 15 相同）。上游的簡體模板原文照引時標注出處。
    唯一例外是 `README.en.md`——它是 `README.md` 的英文版，兩者**內容必須 100% 對等**（同一份文件的兩個語言版本，
    不是兩份不同的文件）。改一份就同步改另一份；結構對等由 `node scripts/readme-parity.mjs`（`npm run lint:readme`）
    檢查：章節序列、表格行列與其中的代幣、非註解指令、連結、`<details>` 數量、正文的數字都要一致，只有散文可以不同。
    兩個刻意不同的地方：部署按鈕的 `envDescription`/`envLink`（各語言一份），以及徽章的顯示文字。
    **例外：`README.en.md` 是對外英文版**（2026-10-11）。兩份 README 是同一份文件的兩個語言版本，
    **內容必須 100% 對等**——改一份就同步改另一份，結構對等由 `npm run lint:readme`
    （`scripts/readme-parity.mjs`）檢查：章節序列、表格行列與其中的代幣、非註解指令、連結、`<details>` 數量、
    正文中的數字（預設值／上限／測試數）都要一致；只有散文可以不同。部署按鈕的 `envDescription`／`envLink`
    是刻意各語言一份（指向自己那份 README），檢查器已正當化這兩項。
    **繁簡字檢查只跑三份文件**（2026-10-11，重要的範圍限定）：`npm run lint:zh` 預設只掃 `AGENTS.md`、`TODO.md`、
    `README.md`。其他檔案（`design/`、`probes/`、`src/`、`scripts/`、`tests/`）**不做繁簡字訂正**——
    那裡繁簡混雜沒人在意，為一個字形去改檔是白花的時間；要掃別的自己帶路徑參數，但**不要把那種結果當成交付**。
    **兩項檢查都在 CI 跑**（`.github/workflows/ci.yml` 的 `lint:zh`／`lint:readme` 兩步，2026-10-11）：
    這條規則不再只靠人腦記得同步。
12. **CI 放 `.github/workflows/`（GitHub Actions），不放 `.forgejo/workflows/`。**
    `origin` 是自建 Forgejo 15.0.9，`github` remote 是它的鏡像（`Lawlietr/Index-Translate-Proxy`，已與 `main` 同步）——
    CI 用 GitHub 托管 runner，因為自建 runner 不是「常開就在那裡」的資源。**鏡像因此是必需的載體：
    `git push github main` 要跟著推，不是可選。**（本條 2026-10-11 反轉：原寫「放 `.forgejo/workflows/`」。）
    **CI 的出口不是生產出口**：CI 只跑 `probe-live`（打已部署的入口），**不跑** `probe-upstream`（直接打上游）——
    同一 host 依 client 解析到不同的 CDN 前端（見上表「為什麼 412」那列），從 CI 出口拿到的結果不進 `design/` 的
    事實表。部署與線上入口都已在，所以 CI 現在可以排（見 TODO）。
    **CI 只有一條路（2026-10-11 定案）**：GitHub Actions 一份 `ci.yml`＋一份 `live-probe.yml`。自建 Forgejo
    不放 workflow、不加 runner，README 不加狀態徽章——所以往後不必再問「要不要補 Forgejo 的 CI」。
 `.github/workflows/live-probe.yml`（一天一次 07:17 UTC，需 repository secret
    `ITP_PROBE_KEY` = 那份部署的 `ITP_KEY`；它打的是已部署入口，輸出同為**漂移警示**，不進事實表）。
    已接通並跑綠（2026-10-11，`38107205187`）。**踩過的坑（留起來）**：首跑 15 個 401——Vercel 複製環境變數
    時會把**變數名稱一起複製**，所以貼進去的 secret 帶著 `ITP_KEY=` 前綴。判別方法：401 的 body 是本代理自己的
    文案而 `GET /` 回 `x-proxy-auth: configured` → 兩邊是不同的 key，不是端點壞了。
13. **部署是測試環的一環：**部署後必須用**真的線上入口**跑一次探測（`node scripts/probe-live.mjs <base>`；主入口現為
    Vercel；CF 入口是可選的備援、因出口 412 未啟用，只有在真的啟用時才需要跑一輪），至少覆蓋
    插件的 `/v1` 路徑形狀、UA（腳本 UA 打 worker 不該 412）、**放行清單真的能用（含 `index-mt-9b`）與不放行的名字回 400**、超長段的切塊接回、
    **拆塊請求中途失敗時的 status 與 `x-proxy-chunk-failed`**、**`GET /` 的一行回應與 `x-proxy-auth`**、
    未帶 key 的 401 形狀、上游 429 的 `retry-after` 是否原樣送出，以及**串流是真的增量**
    （`node scripts/probe-sse-timing.mjs <base>`；**量測 client 要用 curl**，本機 JS client 會把小塊合併，
    量出來的「緩衝」是假象——這個誤判發生過一次）。
    「本機跑過」在這種上傳產物／edge 部署的情境裡不代表線上。
    **線上問題要能對應到某一次部署**（同一條規則的另一半）：所有回應帶 **`x-proxy-build`**（12 字元 commit，`src/lib/build-info.js`）。
    值是**部署前**由 `scripts/deploy-ref-vercel.mjs` 寫進 Vercel 的 `GIT_COMMIT`（`npm run deploy:vercel` 會先跑它）——
    平台自己的 `VERCEL_GIT_COMMIT_SHA` 只有由 Git 觸發的部署才有值，本專案走 CLI 上傳，所以不能假裝那裡有東西；
    它只作為後備讀取順序裡的第二項。**沒有就不帶標頭**（不造假），`probe-live` 在沒有標記時把這一項記 **skip**
    而不是 fail。標記加在 `worker.fetch` 的出口，因此 401／404／429 這些本地錯誤也有——排程探測紅的時候多半就是那些。
    已上線（2026-10-11）：排程探測的總結行變成「22 ok / 0 fail / 1 skip（平台：vercel，**建置 255b30db7f21**）」。
    順帶一個**可重現的實測**，支持「為什麼要自己設」：`vercel env pull --environment=production` 拉出來的
    `VERCEL_GIT_COMMIT_SHA` 是**空字串**（值只有兩個字元＝一對引號），而 `GIT_COMMIT` 是 42 字元 →
    CLI 上傳的部署確實拿不到那個值，不是推測。
    另：標記是在出口**重新包一層 Response**，包錯會讓 Edge 上變成緩衝而內容檢查看不出來 → 部署後必須跑
    `probe-sse-timing`（2026-10-11 跑過：上游 152 行跨 2,715ms、經代理 147 行跨 3,233ms，兩側真增量）。

14. **文件分工：**`TODO.md` 只放待做項目、一個**明確標為「可選／不是待做」**的區塊（目前放 CF 入口那組：代碼保留、但不排進工作），與最多五項已完成（置底）；設計、實測紀錄、規格拆解一律放
    `design/`；更早的完成紀錄查 `git log --oneline`。同一件事的真相只能有一處——`AGENTS.md` 寫結論，
    證據與細節放 `design/`，`TODO.md` 只寫「要做什麼」。**可重跑的程式也在 repo**：證據用的一次性探測放
    `probes/`、client 範例放 `examples/`（兩者都不參與 `npm test`、不被入口 import）——`/tmp` 裡的腳本
    撐不過一次會話，而 `design/` 的結論要能被別人重跑。
    **給 agent 用的東西放 `.agents/skills/<名字>/`**（Agent Skills 規格：pi 與其他 client 會從工作目錄往上找到
    `.agents/skills/`，所以 clone 即被發現）。那個目錄的 `README.md`（中英兩份）是 **agent 用法的唯一入口**，
    含一段可以直接貼給使用者 agent 的提示詞（兩份裡逐字相同——提示詞只該有一份）；**根目錄的 README 對這件事只跳轉、
    不重複說明**。那對 README 由同一個 `scripts/readme-parity.mjs` 檢查（帶兩個路徑就能比任何成對的 README），
    `npm run lint:readme` 已同時跑根目錄與技能目錄兩對。
15. **對外文件不提未公開的專案：**姐妹專案仍在開發、短時間不會公開 → `README.md`（還有未來網站／說明檔）
    **不出現其名稱與內網 URL**（`192.168.x.x` 那種連結對外一定是碎的）。`AGENTS.md`、`design/` 這些 contributor
    文件可以提，但首次提到要標「未公開」，而且**引用過的事實要在本 repo 留下自己的實測證據**，
    不然是無法查證的引用。

16. **一份協定碼、兩個入口：**協定邏輯只存在 `src/lib/`，入口只做平台橋──`api/index.js`（Vercel
    Edge runtime，**現行主入口**：原生 `Response`、不寫 `module.exports`、不用 Node API）、
    `src/worker.js`（CF Worker，因出口 412 暫不啟用）、`api/probe.js`（一次性探測）。
    新增入口不得複製協定碼，只准接環境差異（變數讀取、URL 前綴、標頭），並為橋接本身寫測試
    （`tests/vercel-bridge.test.mjs`）。**入口用 Edge runtime 不是風格選擇，是 constraint**：
    Vercel 的 Node/serverless runtime 會把 SSE 緩衝（純 SSE 探測函式亦復如此），而規則 3 要靠真串流
    避開上游 10s 的 504；Edge 的限制是「25s 內開始回、可串流到 300s」，上游 TTFT 0.2–1.0s 因此余裕很大。
    `src/lib/vercel-node-adapter.js`（Node 版）留著但不部署──它是那場誤判的標本。

17. **通行碼不進 repo（2026-10-13）。**這個鏡像是**公開可讀**的（規則 12），所以 `ITP_KEY` 只存在三處：
    Vercel 的 Secret、本地的 `.dev.vars`／`mcp.json`（兩者已被 `.gitignore` 抵掉）、client 的環境變數。
    **不寫進程式、不寫進文件、不貼進 issue 或 commit 訊息**；範本檔的值一律留空
    （`.dev.vars.example`、`examples/mcp/mcp.json.example`）。這條由 `npm run lint:secret`（CI 第一步）守，
    不靠人記得：它掃 `git ls-files` 找 64 位 hex（`openssl rand -hex 32` 的形狀）與 `ITP_KEY=<真值>` 的賦值；
    commit sha 與測試用的假 sha 都是 40 位，不在這個形狀裡 → 不會出現那種逼人關掉的假警報。
    **負向測試做過**：拿真的 client 設定檔對它跑 → 紅、抓到兩處 64-hex。「它現在是綠的」不等於
    「這個檢查有效」，兩件事要分開證。理由：key 一旦進去就要改歷史，不是改一個檔就能了結。

## 待辦

見 [`TODO.md`](TODO.md)（規則 14：待辦只在那一處）。

## 刻意不做

- **公共共用實例與示範 key**：本專案的用途就是讓使用者自己部署一份自己用。README 不給「拿來就用」的網址，
  也不公開實際的 key（公開過的那把已輪換作廢）。
- KV / Cache 快取（免費層寫入配額低，翻譯請求重複率低）。
- **需要付費的服務，與自建出口設施**：兩個平台都只用免費層，不為快取、跨實例計數或任何狀態服務升級；
  也不自架 connector、不追加一條自己維護的網路去連上游——要連到上游，上游本來就提供公網端點與官方呼叫方式，
  本專案只補一個 client 能用的同形狀端點。理由與證據：`design/egress-options.md` §4。
- DeepL／其他協定的適配層——只做 OpenAI 相容這一條。
- 上游健康檢查或模型探測（`/v1/models` 查不出未宣告模型的可用性，白花一次請求；姐妹專案規則 12 同一結論）。
