# TODO — Index-Translate-Proxy

> 本檔只記錄**待做項目**與下方「已完成」區（最多五項，新在上）；更早的完成紀錄查 `git log --oneline`。
> 不可妥協的約束在 [`AGENTS.md`](AGENTS.md)（規則 14＝文件分工），設計與實測紀錄在 `design/`——本檔不重複內容。

## 待做（依依賴順序）

1. **把 2026-10-10 的重測落成 `design/upstream-probe-2026-10-10.md`**（結論已在 `AGENTS.md` 事實表，這裡只補證據）：
   附請求形狀、狀態碼、時間、回應片段與日期，並補三項目前未測的：
   - **長度階梯**（500/1000/2000/4000 字元）：「4000 截斷／1500 安全」是引用、對外不可查證 → 自己測完才定 `MAX_INPUT_CHARS` 預設值。
   - **規則 2 的 UA 形式**：官方自己用 `Index-Translate-Client/1.0` → 200，所以不必假裝瀏覽器 → 決定採可識別的自訂 UA 或維持瀏覽器樣式，並同步改規則 2。
   - **模型可用性三層證據**（declared／被網關接受但未宣告／已撤回）自己測一輪，取代對未公開姐妹專案的引用。
2. `design/quotas-and-chunking.md`：60k TPM/IP 對 CF egress 共用 IP 的影響、切塊預算（1,500 字元 ≈ 1.1k tokens → 全 worker 約 50 塊/分鐘）、`MAX_INFLIGHT` 與上游 429／`retry-after` 的透傳策略。
3. `src/worker.js` + `src/lib/{route,headers,stream,limits}.js`（規則 2–6；規則 5 的 `/v1/responses` 純透傳）。
4. **鑑權**（定案見 [`design/auth.md`](design/auth.md)）：共用 `ITP_KEY`（SHA-256 比對）、`Authorization: Bearer` → `x-api-key` 的讀取順序、OPTIONS 不鑑權且 `Access-Control-Allow-Headers` 含 `authorization`、401 用 OpenAI 錯誤形狀、`[[ratelimits]]`（`namespace_id = "1001"`，per-IP）只限 401；新增 `.dev.vars.example`（`ITP_KEY=`）。
5. `tests/*.test.mjs`：`node --test` 打真實模組、注入假的 `fetch`，離線覆蓋規則 1–7 與鑑權（含 401／429 透傳與 `<think>` 的防禦性剝離）。
6. `scripts/probe-live.mjs`：清單以 `AGENTS.md` 規則 13 為準（不在這裡重複），只再加兩條那個清單沒列的——同一 worker 的兩次請求是否被上游算進同一個 IP 配額、`/v1/responses` 的透傳是否原樣。
7. `.forgejo/workflows/ci.yml`（跑離線測試；runner 的 label 與 image 用 `mt`，自有環境既有值）。
8. 部署並把實際 worker 網域補進 `README.md`，並增加「官方本機橋（`call_api.py --serve` / `run_proxy_windows.bat`）vs 本 worker」的對比章節。
9. **Deploy to Cloudflare 按鈕**（[`design/deploy-button.md`](design/deploy-button.md)）：鏡像 `github.com/Lawlietr/Index-Translate-Proxy` 已建、已 public ✓；剩下打開 `wrangler.toml` 的 `main`、確認 `[[ratelimits]]` 有預設值、放按鈕 + 手動三行退路。

## 已完成（最多五項，新在上）

- 2026-10-10：文件一致性檢查——`AGENTS.md` 事實表改成重測後的結論（原表的「無配額／SSE 端到端緩衝／未知模型 404」與規則 1、7 互相矛盾）、把事實從 `TODO.md` 收攏回 `AGENTS.md`（規則 14）、README 的 API Key 與配額兩列改成現行設計、修正若干簡體字與錯字。
- 2026-10-10：定案鑑權與配額守門（共用 key、401 用 OpenAI 錯誤形狀、401 獨立限流）→ `design/auth.md`；查證部署按鈕的前置 → `design/deploy-button.md`；GitHub 鏡像建立並推送（public）。
- 2026-10-10：盤點官方更新（README 的 `/v1/responses`、`call_api.py` 官方橋原始碼）並重測公網端點 → 配額、串流行為、模型白名單、思考標記四項修正（已寫入 `AGENTS.md` 事實表）。
- 2026-10-10：建立 `TODO.md`（規則 14）與 `design/` 目錄慣例。
- 2026-10-09：建立骨架（`package.json`、`wrangler.toml`、`LICENSE` MIT、`README.md`、`AGENTS.md`）— commit `264dc51`。
