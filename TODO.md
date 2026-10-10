# TODO — Index-Translate-Proxy

> 本檔只記錄**待做項目**與下方「已完成」區（最多五項，新在上）；更早的完成紀錄查 `git log --oneline`。
> 不可妥協的約束在 [`AGENTS.md`](AGENTS.md)（規則 14＝文件分工），設計與實測紀錄在 `design/`——本檔不重複內容。

## 待做（依賴順序）

1. **補測（小規模，隨時可跑）** —— `node scripts/probe-upstream.mjs <群組>`，未證明項的完整清單見
   `design/upstream-probe-2026-10-10.md`「未證明」節。優先度：
   - `max_tokens` 是否被鉗在 4,096（一檔 `max_tokens:16384` 就能判）。
   - 其他語言方向的膨脹比（只測過 zh→en ≈0.83 output tokens／輸入字元）→ 直接影響 `MAX_INPUT_CHARS` 的邊界。
   - 429 的真實 fixture（本輪 20k/90s 與 36k 併發都沒觸發；測試先用手抄 body）。
2. `design/quotas-and-chunking.md`：60k TPM/IP 對 CF egress 共用 IP 的影響與預算。可用起點（2026-10-10 實測）：
   一個 2,400 字元的塊 ≈ 1,584 prompt + 2,019 completion ≈ **3.6k tokens** → 60k/min 約 **16 塊/分鐘 per IP**，
   而 Worker 的 egress IP 是共用池 → 這個額度不是我們獨佔的。另寫 `MAX_INFLIGHT` 與上游 429／`retry-after` 的透傳策略。
3. **部署與線上探測**（規則 13）：`wrangler secret put ITP_KEY` → `npm run deploy` →
   `node scripts/probe-live.mjs https://<worker>`（已在本地 miniflare 跑過 19/19，**不代表線上**）。
   再把實際網域補進 `README.md`。
4. `.forgejo/workflows/ci.yml`（跑離線測試與 `npm run lint:zh`；runner 的 label 與 image 用 `mt`，自有環境既有值）。
5. **Deploy to Cloudflare 按鈕**（[`design/deploy-button.md`](design/deploy-button.md)）：鏡像 `github.com/Lawlietr/Index-Translate-Proxy` 已建、已 public ✓；`main` 已開、`[[ratelimits]]` 已有預設值 → 剩下放按鈕 + 手動三行退路，加上 README 的「官方本機橋（`call_api.py --serve` / `run_proxy_windows.bat`）vs 本 worker」對比章節。
6. **上游其他模型的實際行為**（`index-mt-2b/9b/-syllable` 與 `-preview`）：等 worker 線上可用之後再測，
   測得清楚才考慮放行或做 alias（規則 1 目前一律本地 400）。

## 已完成（最多五項，新在上）

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
- 2026-10-10：文件一致性檢查——`AGENTS.md` 事實表改成重測後的結論、把事實從 `TODO.md` 收攏回 `AGENTS.md`（規則 14）、README 的 API Key 與配額兩列改成現行設計。
- 2026-10-10：定案鑑權與配額守門（共用 key、401 用 OpenAI 錯誤形狀、401 獨立限流）→ `design/auth.md`；查證部署按鈕的前置 → `design/deploy-button.md`；GitHub 鏡像建立並推送（public）。
- 2026-10-10：盤點官方更新（README 的 `/v1/responses`、`call_api.py` 官方橋原始碼）並重測公網端點 → 配額、串流行為、模型白名單、思考標記四項修正（已寫入 `AGENTS.md` 事實表）。
