# TODO — Index-Translate-Proxy

> 本檔只記錄**待做項目**與下方「已完成」區（最多五項，新在上）；更早的完成紀錄查 `git log --oneline`。
> 不可妥協的約束在 [`AGENTS.md`](AGENTS.md)（規則 14＝文件分工），設計與實測紀錄在 `design/`——本檔不重複內容。

## 待做（依賴順序）

0. **【阻塞】出口問題**：Worker 打上游一律 412，原因是那個 host 從 CF 出去會落進 bilibili 的 **CF 代理邊緣**
   而被 **bilibili 自己的風控** 擋掉（本機直連 bilicdn 是 `server: uvicorn` → 200）。
   證據與判讀見 `design/upstream-probe-2026-10-10.md` §8–§9。先定方向再改 `src/`：
   - (a) **Tunnel origin（自架 connector）** ← 現在的首选：`cloudflared` 跑在既有機器上，zone 開一筆
     Tunnel 記錄；Worker 打它（CF 內部的一跳，不會被擋），最後一跳由本地線路打上游（已證明 200）。
     需要：`cloudflared` 的 tunnel 建立權限（不在現有 token 裡）、一台不关機的機器。
   - (b) **WARP egress（Network egress / connector）**：**只換來源 IP，不換目的地邊緣** → 從 §9 的證據看
     不保證有效，而且 Zero Trust 的 API 回 **403**（看不到也不能建）。排在 (a) 後面。
   - (c) 請上游（bilibili）白名單 CF 出口：成本最低但不可控。
   驗證順序：先做 (a) 的最小驗證 —— 一個只回顯上游回應的 Tunnel 入口，看能不能拿到 200；
   拿到了再決定本代理的 `UPSTREAM_BASE` 要不要做成可配（一個環境變數就能切來源，不動規則 1–9）。
   附記：自己帳號那個 2026-10-06 的 `bil-translate-proxy` 也已 412 → 順便決定它要退役、還是當 (a) 的试验对象。
   另：`itp-ua-probe`、`itp-echo` 兩個一次性 worker 因 token 缺 `Memberships:Read` 刪不掉，需在 dashboard 手动删。
1. **補測（小規模，隨時可跑）** —— `node scripts/probe-upstream.mjs <群組>`，未證明項的完整清單見
   `design/upstream-probe-2026-10-10.md`「未證明」節。優先度：
   - `max_tokens` 是否被鉗在 4,096（一檔 `max_tokens:16384` 就能判）。
   - 其他語言方向的膨脹比（只測過 zh→en ≈0.83 output tokens／輸入字元）→ 直接影響 `MAX_INPUT_CHARS` 的邊界。
   - 429 的真實 fixture（本輪 20k/90s 與 36k 併發都沒觸發；測試先用手抄 body）。
2. `design/quotas-and-chunking.md`：60k TPM/IP 對 CF egress 共用 IP 的影響與預算。可用起點（2026-10-10 實測）：
   一個 2,400 字元的塊 ≈ 1,584 prompt + 2,019 completion ≈ **3.6k tokens** → 60k/min 約 **16 塊/分鐘 per IP**，
   而 Worker 的 egress IP 是共用池 → 這個額度不是我們獨佔的。另寫 `MAX_INFLIGHT` 與上游 429／`retry-after` 的透傳策略。
3. **部署與線上探測**（規則 13）：~~未部署~~ → **已部署**
   `https://index-translate-proxy.yanzilme.workers.dev`（secret `ITP_KEY` 已設）。線上探測 **9/19**，
   失败项全部是上游 412 → 先做待做 0。剩下的真工作：把實際網域補進 `README.md`、
   `wrangler.toml` 明確寫 `workers_dev = true` / `preview_urls`（消除部署警告），以及
   **並發閘在多 isolate 下失效**（本地同 isolate 才過，線上 8 併發不會本地 429）→ 需要 DO 閘門。
4. `.forgejo/workflows/ci.yml`
4. `.forgejo/workflows/ci.yml`（跑離線測試與 `npm run lint:zh`；runner 的 label 與 image 用 `mt`，自有環境既有值）。
5. **Deploy to Cloudflare 按鈕**（[`design/deploy-button.md`](design/deploy-button.md)）：鏡像 `github.com/Lawlietr/Index-Translate-Proxy` 已建、已 public ✓；`main` 已開、`[[ratelimits]]` 已有預設值 → 剩下放按鈕 + 手動三行退路，加上 README 的「官方本機橋（`call_api.py --serve` / `run_proxy_windows.bat`）vs 本 worker」對比章節。
6. **上游其他模型的實際行為**（`index-mt-2b/9b/-syllable` 與 `-preview`）：等 worker 線上可用之後再測，
   測得清楚才考慮放行或做 alias（規則 1 目前一律本地 400）。

## 已完成（最多五項，新在上）

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
- 2026-10-10：定案切塊／串流／失敗語義（計數以塊為單位、中途失敗不補償、跨塊插入分隔符、`usage` 不造假、
  `GET /` 回一行說明、hint 走 `x-proxy-hint`）→ `design/streaming-and-chunking.md`；規則 1/3/4/5/6/7 同步。
- 2026-10-10：盤點官方更新（`/v1/responses`、官方本機橋 `call_api.py`）並重測公網端點 → 配額、串流、
  模型白名單、思考標記四項修正；定案鑑權（`design/auth.md`）與部署按鈕前置（`design/deploy-button.md`）；
  GitHub 鏡像建立並推送（public）。
