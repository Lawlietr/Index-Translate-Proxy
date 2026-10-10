# 出口方案比較（2026-10-10）

> 起因：部署後發現**從 Cloudflare 出口打上游一律 412**（證據見 `upstream-probe-2026-10-10.md` §8–§9）。
> 本檔只比較「換出口」的選項；**同一個 host 有兩條路**這個事實已定案，不在這裡重複。
> 標注：**已測**／**未測**／**規格**（文件上的限制，不是實測）。

## 0. 已知的事實基線

- 本機直連（解析到 bilicdn `103.151.151.x`）→ `server: uvicorn`、**無 `cf-ray`** → **200**。已測
- 從 CF Worker 出口 → 落進 bilibili 的 **CF 代理邊緣**（`server: cloudflare`）→ **412**（bilibili 風控頁）。已測
- 從 **Jina 的資料中心**（`r.jina.ai` 抓 `…/v1/models`）→ **200 + 原生 body**（`{"object":"list","data":[{"id":"Index-Translate-35B-A3B"…`）。已測
  → **不是所有資料中心出口都被擋**；CF 自己那條路才是問題。這是本檔最重要的新事實。
- 上游只有 A 記錄（無 AAAA）。已測
- 強制串流是必須的：非串流 >10s 會被 openresty 504（AGENTS 事實表）。已測（本機路徑）
- 最長一次生成：2,512 tokens / 35.7s。已測（本機路徑）

## 1. 選項與成本

### A. Vercel（函式即代理，整個出口換掉）— **已實測可用，目前唯一驗證過的可行出口**
- **已測（2026-10-10，§10）**：從 `iad1` 函式打上游 → `GET /v1/models` **200 ×4**（`server: uvicorn`、
  `x-cache-webcdn: BYPASS from blzone01/02`、無 `cf-ray`）；`POST /v1/chat/completions`（`stream:true`）
  **200 ×3**，SSE **真增量**（6–7 塊）。出口 IP `54.172.44.226`，連續請求**不輪換**。
- **已測的代價**：到上游 RTT **暖 228–235ms**（本機同一條路 35–45ms）。切塊越多，這個固定成本乘得越多。
- **規格**：Hobby 函式 300s 預設且上限 → 我們最長 36s，餘力夠。Edge runtime 要在 25s 內開始回，之後可串流到 300s → 上游 TTFT 0.17–1.0s，沒問題。
- **規格**：**等待 I/O 不計 active CPU**（官方明寫「calling AI models 不算」）→ 對翻譯代理這種純 I/O 負載正好。
- **規格**：預設單一 region（`iad1`）。已測：從 us-east-1 到 bilicdn 邊緣 230ms —— 比本機慢，但**至少這是一條能量出延遲的路**（Workers 那條路是 412，不是慢）。
- **規格**：**Static IPs 只有 Pro/Enterprise**（要固定出口 IP 就得付費）。Hobby 用的是共用 AWS 出口池。
- **規格**：Proxied Request Timeout 120s（經 Vercel 代理時）。
- **未測**：長輸出（`max_tokens:4096`）經 Vercel 的實際耗時與 `finish_reason` 透傳；共用池下的 429。這兩項要拿本專案的 `probe-live` 打 Vercel 版才算驗證過。
- 遷移成本：低。本專案的 `src/lib/*` 全是純 JS + Web Streams，`fetch`/`Headers`/`ReadableStream` 在 Vercel 都有；
  要改的只有入口（`export default {fetch}` → Vercel 的 route handler）與設定載入。
  實際踩到的坑（已驗）：`api/[[...slug]].js` 這種參數檔名在 CLI 上傳後**不會**被編譯成函式（`functions: null`）；
  改成 `api/probe.js` + `vercel.json` 的 `builds:[{"src":"api/**","use":"@vercel/node"}]` 與顯式 `routes` 才可用。

### B. 其他非 CF 的免費 serverless（同類替代品）
Netlify / Deno Deploy / Fastly Compute：**未測**，但它們同樣是「非 CF 的出口」，Jina 那條 200 對它們是正面訊號。
代價與 A 相同（換平台、多 region 問題）。列在這裡是為了**不要過早押定 Vercel**。

### C. Tunnel origin（自架 `cloudflared` connector）
- 機制：Worker → 自己 zone 的 Tunnel 入口（CF 內部一跳，不會被擋）→ connector 在本地機器打上游（已證明 200 的路）。
- **已測的部分**：最後一跳（本地 → 上游）可用；CF 內部那一段本身不會被擋（打自己 zone 正常）。
- **未測**：端到端。
- **成本**：需要一台不關機的機器 + `cloudflared` 權限。
- **判斷**：若**本來就有**常開機器，這條最省；若**為了這個專案才開一台**，就是本末倒置（使用者的判斷，我同意）。

### D. WARP egress（Cloudflare Network egress / WARP connector）
- **只換來源 IP，不換目的地邊緣** → 依 §9 的證據，很可能**無效**。
- Zero Trust API 目前回 **403**（看不了也建不了）。
- 判断：**降級**，除非 A/B/C 都失敗再回來試。

### E. 完全不部署（退回本機橋）
官方的 `call_api.py --serve` / `run_proxy_windows.bat` 已經就是這個。若接受「每台裝置自己跑一個本機橋」，
本 repo 沒有存在必要。**這是一條正經的出路，不是失敗**——它的代價是每台裝置都要裝、都要開。

## 2. 建議的驗證順序（每步都是幾分鐘的成本）

1. ~~Vercel 最小探測~~ → **已做，通過**（探測碼在 `probes/vercel-egress/`，當時部署為 `itp-egress-probe.vercel.app`；2026-10-10）。
   下一步是**把本代理移到 Vercel**（保留 `src/lib/*` 不動，只換入口與環境變數載入），再用
   `scripts/probe-live.mjs` 打它 —— 那才會涵蓋切塊、413、401、429 透傳、`finish_reason`、放行清單等 21 項。
2. 若 1 通：決定 A（把本專案改成 Vercel 版）**或**保留 CF Worker 的協定碼、只把上游換成 Vercel 上的中轉。
   我傾向**整個換到 A**：兩層 serverless 只是多一跳和兩個部署。
3. 若 1 不通但有常開機器：走 C。
4. 都不行：E，並在 README 寫清楚「本 repo 是協定與設計的參考實作，不保證任何雲端出口可用」。

## 3. 還沒回答的問題（要測才知道）

- 非 CF 出口到上游的**延遲**（Vercel 在 us-east-1 → bilibili 邊緣的 RTT）。
- 共用出口池會不會**被別人用壞**（bilibili 按 IP 的 60k TPM：共用池代表我們跟這池的其他人共享配額，
  與 CF 的共用池是同一個結構問題，換平台不解決它）。
- 換出口後，AGENTS 規則 2（固定自訂 UA）還有沒有效用——在 bilicdn 那條路上 UA 是否仍決定 200/412（本機測過是），
  但在 Vercel 出口下是否需要另外條件，未知。
