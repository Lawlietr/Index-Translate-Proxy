# TODO — Index-Translate-Proxy

> 本檔四種區塊：**待做**（依依賴順序，每項再拆成可獨立交付的子項）、**已定案**（不再列為待做、往後也不再重複提問的事）、
> **可選**（明確標為不是待做的備援組）、**已完成**（最多五項，新在上）。
> 更早的完成紀錄查 `git log --oneline`。
> 不可妥協的約束在 [`AGENTS.md`](AGENTS.md)（規則 14＝文件分工），設計與實測紀錄在 `design/`——本檔不重複內容。
>
> **⏱＝預估分鐘數。**每個子項的完成判準都是「一次 commit ＋ 一句結論寫進 `design/` 或測試檔」，
> 所以停在任何兩個子項之間都不留半成品。時間不足時挑**一個完整的子項**做完，不要把某項切一半。

## 待做（依依賴順序）

### T1 補測：把「推定」改成「實測」（燒上游配額；每子項獨立可停）

跑法 `node scripts/probe-upstream.mjs <群組>`；待驗證清單見 `design/upstream-probe-2026-10-10.md` 的「未證明」節。
**只在本地跑，不在 CI 跑**（AGENTS 規則 12：CI 的出口不是生產出口，結果不進事實表）。

- **T1.1** `max_tokens` 是否被鉗在 4,096：加一檔 `max_tokens:16384` 就能判。1 個請求。⏱15
- **T1.2 第二個語言方向**（建議 en→zh）：編號行是否逐行對應 ＋ 輸出膨脹比。2~3 個請求。⏱25
  → T4 的關鍵輸入：目前只測過 zh→en ≈0.83 completion tokens／輸入字元，`MAX_INPUT_CHARS=2500` 的膨脹餘量只有一組數據撐著。
- **T1.3** 第三個方向（zh→ja 或 ja→en；膨脹比可能明顯不同）。⏱25
- **T1.4** 429 的**真實 fixture**：在自己的入口打滿併發（不另外燒上游配額），把真的 body 收進 `tests/fixtures/`——現在測試用手抄 body。⏱20
- **T1.5** Vercel 側 `clientIp()` 實際讀到哪種標頭（只影響 401 限流的鍵，不影響協定）：在 `probe-live` 加一行輸出，跑一次順手記下。⏱15

### T2 `design/quotas-and-chunking.md`：配額與切塊的預算（不燒配額；可停在任一段）

- **T2.1** 建檔，只把**已有**實測數字排成表：一個 2,400 字元的塊 ≈ 1,584 prompt ＋ 2,019 completion ≈ 3.6k tokens
  → 60k tokens/min ≈ 16 塊/分鐘 per IP，而 Vercel 的出口 IP 是共用池（這個額度不是我們獨佔）。⏱30
- **T2.2** 免費層天花板一節：兩個平台都只用免費層、不升級（見「已定案」），所以預算兩側都要寫——
  上游的 60k TPM/IP，以及平台自己的額度上限。與 AGENTS「刻意不做」的付費那條互引。⏱20
- **T2.3** `MAX_INFLIGHT`（預設 4）與上游 429／`retry-after` 的透傳策略寫成結論：讀現碼（`src/lib/limits.js`）
  再落檔，含「調大通常沒用，因為上游近乎串行」的實測根據。⏱20
- **T2.4** 膨脹比 → 塊大小的算式與第二組樣本。**依賴 T1.2／T1.3** 的數字。⏱15

### T3 CI：GitHub Actions（AGENTS 規則 12；先能用，再加檢查）

放在 `.github/workflows/`，跑在 GitHub 托管 runner。`origin` 是自建 Forgejo，`github` 是鏡像 → **推鏡像是 CI 的前置動作**。

- ~~**T3.1** 只跑 `npm test` 的最小 workflow。~~（**已做**，2026-10-11：`.github/workflows/ci.yml`，
  `npm ci --omit=dev` ＋ `npm test`；在 `git archive` 出來的乾淨副本上驗證過 82/82，測試不需要 `wrangler`/`vercel`。）
  → 下一個停點是 **T3.2**；另外鏡像尚未推（T5 的 `git push github main`），不推就不會跑。
- **T3.2** 加 `npm run lint:readme` 與 `npm run lint:zh`。⏱10
  ← 對這個 repo 價值最高的一網：歷史統計是 92 次文件改動 vs 21 次代碼改動，而規則 11 要求兩份 README 100% 對等——這個不變量目前只靠人腦記得同步。
- **T3.3** 加 `npm run smoke`。⏱5
- **T3.4** 加 `node scripts/probe-live.mjs <生產 URL>`（base URL 與 key 放 GitHub Actions secrets；這是唯一碰 secrets 的一步，可推後）。⏱20
  ← 這是唯一能對抗**上游漂移**的機制：事實表那些 ok/fail 都是某天的快照，而上游有撤回模型名稱的先例（`index-homura-*`）。
- **T3.5** 在 workflow 註解與 `design/` 標明邊界：CI 只跑 `probe-live`（打已部署的入口），**不跑** `probe-upstream`（直接打上游）；CI 出口 ≠ 生產出口。⏱10
- **T3.6（可選，不是待做）** 徽章進兩份 README：那是對外宣稱，等 CI 真的綠過再說。

### T4 依語言方向收參數（只有 T1.2／T1.3 出了結果才動代碼）

- **T4.1** 若某方向膨脹比明顯高於 0.83：把 `MAX_INPUT_CHARS` 調保守，或依方向／模型分設 ＋ 補測試。⏱30
- **T4.2** 把「尾部被截」變成使用者看得到的說明：`x-proxy-chunk-truncated` 標頭已有（`src/worker.js`），但插件不讀標頭
  → README 要寫「最後幾行可能少了，怎麼辦」。兩份 README 必須同步（規則 11）。⏱15

### T5 定期家務

- Vercel token 為 7 天效期（2026-10-10 簽發）：到期或外洩就在 dashboard 撤銷重發。部署走 `npm run deploy:vercel`
  （需 `VERCEL_TOKEN`＋`VERCEL_TEAM_ID`，兩把都不寫進 repo）。`ITP_KEY` 目前兩側共用同一把，若要分開管理，在 Vercel 的
  Settings → Environment Variables 改。⏱5
- 推鏡像：`git push github main`（CI 的載體，規則 12）。⏱1

## 已定案（不再列為待做，往後也不再重複提問）

- **不花錢**：兩個平台都只用免費層；不升級、不加需要付費的狀態服務或跨實例計數。→ 規則 7 的併發閘因此**永久是
  per-instance**，主要防線是插件端「每秒最大請求數」3~5（README 已寫）。已寫進 AGENTS 規則 7 與「刻意不做」。
- **不再追換出口**：CF 入口維持「可選、不啟用」；Tunnel origin、WARP、其他 serverless 平台**不再評估、也不再作為問題提出**。
  理由：要連到上游，上游本來就提供公網端點與官方的呼叫方式；本專案只補一個 client 能用的同形狀端點，
  不自己維護一條網路。Vercel 出口已可用，這就夠 → `design/egress-options.md` §4。
- 既有 `design/` 文件與 `src/worker.js`（CF 入口）**保留不刪**。
- **key 衛生**（2026-10-11 已做）：README 公開過的示範 key 已輪換（Production／Preview／Development 三個環境都換、
  重新部署、`probe-live` 用新 key 重跑 21/0/1），README 裡出現 0 次。往後規則：**實際用的 key 一律不進文件**。
- **一次性探測資源已清理**（2026-10-11，dashboard 手動完成）：Vercel 的 `itp-vercel-probe`／`itp-egress-probe`、
  CF 的 `itp-ua-probe`／`itp-echo`。探測碼在 `probes/`，證據在 `design/`；要重現照 `probes/README.md` 重新部署即可。

## 可選（**不是待做**，也已定案不啟用）：Cloudflare Worker 入口

`src/worker.js` 是**保留的備援出口**，不是需要完成的工作；已實測**從 CF 出口打上游一律 412**
（[`design/egress-options.md`](design/egress-options.md) §8–§9，定案在 §4）。這裡只留「真的啟用時要做什麼」的清單，
**不必再回來問要不要做**：

- 先探測證明那條出口能打到上游（`probes/`、`node scripts/probe-upstream.mjs`），再談部署。
- `wrangler.toml` 明確寫 `workers_dev = true` / `preview_urls`（消除部署警告），把預設值寫進 `[vars]`。
- **Deploy to Cloudflare 按鈕**（[`design/deploy-button.md`](design/deploy-button.md)）：鏡像已建、已 public、`main` 已開、
  `[[ratelimits]]` 已有預設值 → 剩下放按鈕與手動三行退路。
- ~~清掉 CF 的一次性資源：`itp-ua-probe`、`itp-echo`~~（**已做**，2026-10-11）。
- 真的啟用了才照規則 13 跑一次 `probe-live`／`probe-sse-timing`，並記錄出口狀態（412 本身也是要記錄的結果）。

## 已完成（最多五項，新在上）

- 2026-10-11：**定位定案＋CI 起點** —— 一次性探測專案（Vercel 兩個、CF 兩個）已全部清理，`probes/README.md` 與
  `design/egress-options.md` 同步為「已刪除、可重新部署」；**CI 改到 GitHub Actions**（AGENTS 規則 12 反轉，
  `github` 鏡像是必需載體，並規定 CI 只跑 `probe-live`、不跑 `probe-upstream`）；「不花錢」「不再追換出口」
  寫入 AGENTS 規則 7／刻意不做／egress §4；待做拆成可分段交付的子任務（T1~T5）；同日 key 輪換結帳（見「已定案」）。
  **T3.1 已交**：`.github/workflows/ci.yml`（只跑 `npm test`，走 `npm ci --omit=dev`）；同時把規則 11 的
  繁簡字檢查限定在 `AGENTS.md`／`TODO.md`／`README.md` 三份，其他檔案不再做繁簡訂正。
- 2026-10-10：**放行清單上線並線上探測** —— 逐個測過 `index-mt-2b/9b/-syllable`（`design/model-allowlist.md`）→
  放行 `Index-Translate-35B-A3B`/`index-mt-9b`/`index-mt-2b`，`-syllable` 因會漏行／丟編號不放行；
  `GET /v1/models` 改由本代理自己回。重新部署後線上 `probe-live` **21 ok / 0 fail / 1 skip**（跳過的是 per-instance 併發閘）、
  `probe-sse-timing` 真增量（跨度 1,114ms ≈ 上游 1,148ms）。另新增 `scripts/serve-vercel-bridge.mjs`（不起 Vercel 也能測「Vercel 這條路徑」）。
- 2026-10-10：**搬到 Vercel 並線上探測** —— `https://index-translate-proxy.vercel.app` 上線（Edge runtime 入口
  `api/index.js`，協定碼不重複），`probe-live` 全過、`probe-sse-timing` 兩側都**真增量**（首塊 434ms、跨度 1,112ms ≈ 上游 1,148ms）。
  同時把 CF 那份也重新部署並探測：本地行為全過、**上游全部 412** → 印證「CF 出口那側被風控擋」。
  新增 `scripts/probe-sse-timing.mjs`（用 curl 當 client，因為本機 JS client 會把 SSE 合併成一批，量出來的「緩衝」是假象）。
- 2026-10-10：**出口可行性實測** —— 一次性 Vercel 探測函式 → **從 Vercel 出口打上游 200 ×6**（`/v1/models` 與 3 行串流翻譯，
  SSE 真增量），並拿到成因：同一 host 依 client 解析到不同 CDN 前端（CF 代理 = 412；bilicdn `uvicorn` = 200）。
  新增 `design/egress-options.md`（五個出口方案的已測/未測/規格）與 probe §10；AGENTS 事實表新增兩列。
- 2026-10-10：部署到 `index-translate-proxy.yanzilme.workers.dev`（`wrangler secret put ITP_KEY` + `deploy`）
  並跑線上探測 → **發現阻塞性事實：從 CF 出口打上游一律 412**（四輪一次性 probe worker 定位：UA 無關、
  全站、`resolveOverride`/raw socket 都不能繞）。已寫入 AGENTS 事實表與 design/upstream-probe §8。

（更早的完成紀錄查 `git log --oneline`——例如第二輪上游探測推翻五條舊事實，關鍵是「截斷在輸出側」。）
