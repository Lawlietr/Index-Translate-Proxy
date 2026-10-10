# TODO — Index-Translate-Proxy

> 本檔只記錄**待做項目**與下方「已完成」區（最多五項，新在上）；更早的完成紀錄查 `git log --oneline`。
> 不可妥協的約束在 [`AGENTS.md`](AGENTS.md)（規則 14＝文件分工），設計與實測紀錄在 `design/`——本檔不重複內容。

## 待做（依賴順序）

0. **線上探測的收尾**（規則 13 已做一半）：
   - `wrangler.toml` 明確寫 `workers_dev = true` / `preview_urls`（消除部署警告）。
   - 一次性資源清掉（**本次的 Vercel token 沒有 `Projects:Read`，列表/刪除都回 403 → 只能在 dashboard 手動做**）：
     Vercel 的 `itp-vercel-probe`／`itp-egress-probe` 兩個探測專案（探測碼已收進 `probes/`，刪專案不會讓證據丟失）、
     CF 的 `itp-ua-probe` 與 `itp-echo`。保留 `itp-egress-probe` 也可以——它是目前唯一「從我們實際出口驗上游通不通」的探測。
   - **阻塞項：Vercel token 已失效**（`invalidToken`／CLI 回「Not authorized」）→ main 上的新版（放行清單、
     本地 `/v1/models` 清單）**目前無法部署**，線上仍是舊版（`GET /v1/models` 可辨認版本）。
     需要一組新的帳號 Token（或把 repo 連到 Vercel 的 Git 整合，讓 push 觸發部署）。
   - **安全性家務**：本次會話用過的 Vercel 帳號 Token 已出現在對話裡（現已失效），請在 dashboard 撤銷重發；
     `ITP_KEY` 目前 CF 與 Vercel 共用同一把，若要分開管理，Vercel 那側在 Settings → Environment Variables 改。
1. **規則 7 的並發閘在兩個平台都是 per-instance**（2026-10-10 線上實測：Vercel 把 12 個併發分散到 6+ 個實例，
   一個都不擋；CF 多 isolate 同理）。v1 的保護因此主要落在**插件端「每秒最大請求數」3~5**（README 已寫）。
   要真的全域閘：CF 需要 Durable Objects 計數、Vercel 需要外部計數（付費）→ 目前不值得，但**别再把它當成全局保證**。
2. **補測（小規模，隨時可跑）** —— `node scripts/probe-upstream.mjs <群組>`，未證明項清單見
   `design/upstream-probe-2026-10-10.md`「未證明」節。優先度：
   - `max_tokens` 是否被鉗在 4,096（一檔 `max_tokens:16384` 就能判）。
   - 其他語言方向的膨脹比（只測過 zh→en ≈0.83 output tokens／輸入字元）→ 直接影響 `MAX_INPUT_CHARS` 的邊界。
   - 429 的真實 fixture（本輪 20k/90s 與 36k 併發都沒觸發；測試先用手抄 body）。
   - Vercel 側 `clientIp()` 實際讀到哪種標頭（只影響 401 限流的鍵，不影響協定）—— 探測時順手記。
3. `design/quotas-and-chunking.md`：60k TPM/IP 對共用出口 IP 的影響與預算。可用起點（2026-10-10 實測）：
   一個 2,400 字元的塊 ≈ 1,584 prompt + 2,019 completion ≈ **3.6k tokens** → 60k/min 約 **16 塊/分鐘 per IP**，
   而 Vercel/CF 的 egress IP 都是共用池 → 這個額度不是我們獨佔的。另寫 `MAX_INFLIGHT` 與上游 429／`retry-after` 的透傳策略。
4. `.forgejo/workflows/ci.yml`（跑離線測試與 `npm run lint:zh`；runner 的 label 與 image 用 `mt`，自有環境既有值）。
   CI 現在也能順跑 `node scripts/probe-live.mjs <Vercel URL>`——線上探測已有可重複的腳本。
5. **Deploy to Cloudflare 按鈕**（[`design/deploy-button.md`](design/deploy-button.md)）：鏡像 `github.com/Lawlietr/Index-Translate-Proxy`
   已建、已 public ✓；`main` 已開、`[[ratelimits]]` 已有預設值 → 剩下放按鈕 + 手動三行退路。
   **注意**：CF 出口打上游 412（見 `design/egress-options.md`），所以在出口問題解決前，按鈕部署出來的實例**打不到上游**；
   要做的是「Deploy to Vercel」為主、CF 按鈕為附。
6. ~~上游其他模型的實際行為~~（**已做**）：`index-mt-2b`/`index-mt-9b` 可用且編號行逐行對應 → **已放行**；
   兩個 `-syllable` 會漏行／丟編號 → 不放行。證據與決定：`design/model-allowlist.md`。
   仍待測：其他語言方向的行對應與品質（目前只測過 zh→en、8 行）。

## 已完成（最多五項，新在上）
- 2026-10-10：**搬到 Vercel 並線上探測** —— `https://index-translate-proxy.vercel.app` 上線（Edge runtime 入口
  `api/index.js`，協定碼不重複），`probe-live` **19 ok / 0 fail / 1 skip**（跳過的是 per-instance 併發閘，平台上不可測），
  `probe-sse-timing` 兩側都**真增量**（首塊 434ms、跨度 1,112ms ≈ 上游 1,148ms）。同時把 CF 那份也重新部署並探測：
  本地行為全過、**上游全部 412** → 印證「CF 出口那側被風控擋」。新增 `scripts/probe-sse-timing.mjs`（用 curl 當 client，
  因為本機 JS client 會把 SSE 合併成一批，量出來的「緩衝」是假象）。
- 2026-10-10：**出口可行性實測** —— 一次性 Vercel 探測函式（repo 外 `/tmp/itp-vercel-probe`）→
  **從 Vercel 出口打上游 200 ×6**（`/v1/models` 與 3 行串流翻譯，SSE 真增量），拿到成因：
  同一 host 依 client 解析到不同 CDN 前端（CF 代理 = 412；bilicdn `uvicorn` = 200）。
  新增 `design/egress-options.md`（五個出口方案的已測/未測/規格）與 probe §10；AGENTS 事實表新增兩列。

- 2026-10-10：部署到 `index-translate-proxy.yanzilme.workers.dev`（`wrangler secret put ITP_KEY` + `deploy`）
  並跑線上探測 → **發現阻塞性事實：從 CF 出口打上游一律 412**（四轮一次性 probe worker 定位：UA 無關、
  全站、`resolveOverride`/raw socket 都不能繞）。已寫入 AGENTS 事實表與 design/upstream-probe §8。

- 2026-10-10：實作完成 —— `src/worker.js` + `src/lib/{route,headers,auth,model,chunk,stream,limits}.js`、
  `tests/*.test.mjs`（67 條離線）、`scripts/smoke-local.mjs`（51 項）、`scripts/probe-live.mjs`（19 項，本地 miniflare 全過）、
  `scripts/lint-zh.mjs`（規則 11）。定案：單行超 `MAX_LINE_CHARS` → **本地 413**（不硬切）、
  並發閘先排隊（`SLOT_WAIT_MS`）再 429、計「請求」不計塊。新事實：**行對應是提示條件式的**
  （不帶翻譯指令時上游會展開多語言列表／前言），見 design/upstream-probe §1。

- 2026-10-10：第二輪上游探測（`scripts/probe-upstream.mjs` ＋ `design/upstream-probe-2026-10-10.md` ＋ `tests/fixtures/`）。
  推翻五條舊事實；關鍵是**截斷在輸出側**（預設 2,048 completion tokens、`finish_reason:"length"` 可偵測、
  `max_tokens` 被尊重且可能鉗在 4,096）→ `MAX_INPUT_CHARS` 1500→2500、新增 `MAX_TOKENS_DEFAULT=4096`、
  規則 9 開放四項協定層注入、規則 2 的 UA 定案為自訂標識、事實表新增 `usage` 與「字元→token 不可換算」兩列。


