# TODO — Index-Translate-Proxy

> **本檔只記錄待做項目**，加上下方「已完成」區（最多五項，新在上）。
> 設計／實作相關的說明文件一律放 `design/`；更早的已完成項目查 `git log --oneline`。
> 規則與不可妥協的約束在 [`AGENTS.md`](AGENTS.md)，事實來源在 `design/`，本檔不重複內容。

## 待做（依依賴順序）

1. **修正 `AGENTS.md` 的上游事實表**（2026-10-10 實測推翻三條）：
   - 上游**有配額**：`429` + `retry-after: 1`，body 為 `{"error":{"type":"rate_limit_error","code":429,"retry_after":1,"message":"…TPM limit of 60000 tokens/min exceeded for IP …"}}` → 「無配額可查」作廢。
   - **SSE 是真增量**：1400 字元輸入非串流 → 504（10.1s，openresty）；同一輸入 `stream:true` → 6.6s、TTFT 0.64s、757 個 delta → 「端到端緩衝（TTFT≈總時間）」作廢。
   - **未知模型回 400（非 404）**，且 400 body 自報白名單：`Index-Translate-35B-A3B, index-mt-2b, index-mt-9b, index-mt-2b-syllable, index-mt-9b-syllable`；`Index-Translate-9B/2B/-preview` 回 200 且 `model` 原樣回顯、`model:""` → 靜默用 35B-A3B（規則 1 的風險來源）。
   - `/v1/responses` 上游**已支援**（真 SSE，`response.output_text.delta`）；`/v1/completions` 上游**不存在**（404）；`GET /v1/models` 仍只宣告 35B-A3B。
   - UA 不必假裝瀏覽器：官方自己用 `Index-Translate-Client/1.0` → 200（規則 2 建議改成可識別的自訂 UA）。
   - **規則 9 的理由要改寫**：公網端點預設已等同 `enable_thinking=false`（不帶參數與明確 false 的輸出完全相同），
     三種模式都不吐 `<think>`；開思考的實際風險是**生成變長→撞 10s 504**與摻入非譯文文字，不是標籤泄漏。
   - **重測長度上限**：「4000 字元截斷、1500 安全」引自未公開的姐妹專案，對外無法查證 → 本 repo 自己跑一次
     阶梯式長度（500/1000/2000/4000 字元）留證據，再把 `MAX_INPUT_CHARS` 的預設值定下來。
2. **把實測落成 `design/upstream-probe-2026-10-10.md`**：附請求形狀、狀態碼、時間、回應片段與日期；`AGENTS.md` 只留結論與引用連結（避免兩處真相）。
3. **`design/quotas-and-chunking.md`**：60k TPM/IP 對 CF egress 共用 IP 的影響、切塊預算（1500 字元 ≈ ~1.1k tokens → 全 worker 約 50 塊/分鐘）、`MAX_INFLIGHT` 與 429/`retry-after` 的透傳策略。
4. `src/worker.js` + `src/lib/{route,headers,stream,limits}.js`（規則 2–6；規則 5 需放行 `/v1/responses` 純透傳）。
5. **鑑權（定案見 [`design/auth.md`](design/auth.md)）**：共用 `ITP_KEY`（SHA-256 比對）、`Authorization: Bearer` → `x-api-key` 的讀取順序、
   OPTIONS 不鑑權且 `Access-Control-Allow-Headers` 含 `authorization`、401 用 OpenAI 錯誤形狀、
   `[[ratelimits]]`（`namespace_id = "1001"`，per-IP）只限 401；新增 `.dev.vars.example`（`ITP_KEY=`）。
6. `tests/*.test.mjs`：`node --test` 打真實模組、注入假的 `fetch`，離線覆蓋規則 1–7 與鑑權（含 401/429 透傳與 `<think>` 防禦性剥离）。
7. `scripts/probe-live.mjs`（規則 13），新增探測：**未帶 key → 401 形狀**、**從 CF egress 打到的 429 形狀與 `retry-after`**、
   同一 worker 兩次請求是否被計入同一 IP 配額、`/v1/responses` 透傳。
8. `.forgejo/workflows/ci.yml`（跑離線測試；runner 的 label 與 image 用 `mt`，自有環境既有值）。
9. 部署並把實際 worker 網域補進 `README.md`；README 增加「官方本機橋（`call_api.py --serve` / `run_proxy_windows.bat`）vs 本 worker」的對比章節，
   並把「API Key｜任填」改成「填本代理的 key」（[`design/auth.md`](design/auth.md)）。
10. **Deploy to Cloudflare 按鈕**（[`design/deploy-button.md`](design/deploy-button.md)）：鏡像已定 `git@github.com:Lawlietr/Index-Translate-Proxy.git`（自建 Forgejo 不支援按鈕），
    剩下：GitHub 設為 public → 打開 `wrangler.toml` 的 `main`、確認 `[[ratelimits]]` 有預設值 → 放按鈕 + 手動三行退路。

## 已完成（最多五項，新在上）

- 2026-10-10：定案鑑權與配額守門（共用 key、401 用 OpenAI 錯誤形狀、401 獨立限流）→ `design/auth.md`；
  查證 Deploy to Cloudflare 按鈕的可行性與前置條件 → `design/deploy-button.md`。
- 2026-10-10：盤點官方更新（README 的 `/v1/responses`、`call_api.py` 官方橋原始碼）並重測公網端點 → 得到配額、串流行為、模型白名單、思考標記四項修正（結論見上方待做 1）。
- 2026-10-10：建立 `TODO.md`（規則 14：待辦只這一處）與 `design/` 目錄慣例。
- 2026-10-09：建立骨架（`package.json`、`wrangler.toml`、`LICENSE` MIT、`README.md`、`AGENTS.md`）— commit `264dc51`。
