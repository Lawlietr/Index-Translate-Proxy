# TODO — Index-Translate-Proxy

> 本檔四種區塊：**待做**（依依賴順序，每項再拆成可獨立交付的子項）、**已定案**（不再列為待做、往後也不再重複提問的事）、
> **可選**（明確標為不是待做的備援組）、**已完成**（最多五項，新在上）。
> 更早的完成紀錄查 `git log --oneline`。
> 不可妥協的約束在 [`AGENTS.md`](AGENTS.md)（規則 14＝文件分工），設計與實測紀錄在 `design/`——本檔不重複內容。
>
> **任務編號以本檔為準。**對話裡提到「T5.1」「T4.4」這種本檔沒有的編號，是我口語自創的——出現過兩次，
> 往後一律先用本檔的編號；真要新增工作就先寫進本檔，不靠對話記憶。
>
> **⏱＝預估分鐘數。**每個子項的完成判準都是「一次 commit ＋ 一句結論寫進 `design/` 或測試檔」，
> 所以停在任何兩個子項之間都不留半成品。時間不足時挑**一個完整的子項**做完，不要把某項切一半。

## 待做（依依賴順序）

### T1 補測（燒上游配額）：**只剩一項必要**

原則（2026-10-11 定調）：能合理推斷的就用推斷、把它寫成**顯式假設＋觸發條件**；不能推斷的列可選，
等真的有使用者碰到再測。會燒配額的動作只留「不做就無法決定下一步」的那一個。

- ~~**T1.1（必要，1 個請求）**~~ ⏱15 → **已測，答案是 4,096**：要 `max_tokens:16384` ＋ 6,000 字元，上游只給
  **恰好 4,096**、`finish_reason:"length"`、101 行回 83 行。證據 `tests/fixtures/ceiling-16384.summary.json`、
  論證 `design/upstream-probe-2026-10-10.md` §11。AGENTS 事實表那個「推定」欄位已改成實測。
- ~~**T1.2** 第二個語言方向（en→zh）~~ → **不測，改用顯式假設**：假設 en→zh 的「completion tokens／輸入字元」
  **不高於**已測的 zh→en ≈0.83，所以現行 `MAX_INPUT_CHARS=2500` 對該方向只會更保守（保守方向錯的代价是
  少切一點，不是譯到一半斷掉）。推理鏈：同一份內容譯成中文的字元數遠少於譯成英文，中文的 token 密度高
  但不足以反轉這個差距 → 已測的 zh→en 是**較壞的一側**，以它為準就是保守。
  **觸發條件**（出現就要真的測，不能再拿假設擋）：任何使用者回報「最後幾行不見」，或我們看到
  `x-proxy-chunk-truncated`／`finish_reason:"length"` 出現在一個明顯比 2,500 字元短的請求上。
- ~~**T1.5** Vercel 側 `clientIp()` 讀哪種標頭~~ → **不測**：`src/lib/auth.js:46` 已按 `x-forwarded-for` →
  `x-real-ip` 的順序讀（Vercel 給前者），讀錯也只影響 401 限流的鍵、不影響協定 correctness。花配額換這個資訊不值。
- **T1.3 → 列可選**（這才是「不能猜」的那一類）：zh→ja／ja→en——kanji 加假名的 tokens/字元 可能明顯高於 0.83，
  推理保證不了。等真的有使用者用這個方向再測，那時它才有真實需求。
- **T1.4 → 列可選**：429 的真實 fixture。錯誤形狀已在 AGENTS 事實表留過實測記錄，測試用手抄 body 不影響協定正確性。

> 這段的原則也要寫進 `design/streaming-and-chunking.md`（T2.4 那節）：**假設要寫成假設**，並附「什麼時候必須去測」，
> 不是寫成事實。

### T2 `design/quotas-and-chunking.md`：配額與切塊的預算（不燒配額；可停在任一段）

- **T2.1** 建檔，只把**已有**實測數字排成表：一個 2,400 字元的塊 ≈ 1,584 prompt ＋ 2,019 completion ≈ 3.6k tokens
  → 60k tokens/min ≈ 16 塊/分鐘 per IP，而 Vercel 的出口 IP 是共用池（這個額度不是我們獨佔）。⏱30
- **T2.2** 免費層天花板一節：兩個平台都只用免費層、不升級（見「已定案」），所以預算兩側都要寫——
  上游的 60k TPM/IP，以及平台自己的額度上限。與 AGENTS「刻意不做」的付費那條互引。⏱20
- **T2.3** `MAX_INFLIGHT`（預設 4）與上游 429／`retry-after` 的透傳策略寫成結論：讀現碼（`src/lib/limits.js`）
  再落檔，含「調大通常沒用，因為上游近乎串行」的實測根據。⏱20
- **T2.4** 把「膨脹比 → 塊大小」的算式寫清楚，並把 T1 那條**顯式假設＋觸發條件**收錄進去（不是新增實測）。⏱15

### T3 CI：GitHub Actions（AGENTS 規則 12；先能用，再加檢查）

放在 `.github/workflows/`，跑在 GitHub 托管 runner。`origin` 是自建 Forgejo，`github` 是鏡像 → **推鏡像是 CI 的前置動作**（已成習慣：commit → 推 `origin` → 推 `github`）。

- ~~**T3.1** 只跑 `npm test` 的最小 workflow。~~（**已做**，2026-10-11：`.github/workflows/ci.yml`，
  `npm ci --omit=dev` ＋ `npm test`；首跑 `38105304395` 10 秒內綠。）
- ~~**T3.2** 加 `npm run lint:readme` 與 `npm run lint:zh`。~~ ・ ~~**T3.3** 加 `npm run smoke`。~~（**已做**，
  2026-10-11，`da441ca`）→ `ci.yml` 現在是四步：`lint:zh` → `lint:readme` → `smoke` → `npm test`，全部離線
  （`smoke` 用假 upstream）、不碰 secrets、不花上游配額。線上 run `38105805272` 已按步驟核對過（lint 兩步綠、
  `smoke` 51 ok/0 fail、`# pass 82`），不是只有「本地跑過」（規則 13）。
- ~~**T3.4** `probe-live` 打已部署入口（唯一碰 secrets 的一步）。~~（**已做**，2026-10-11，`fbf0e5a`：
  `.github/workflows/live-probe.yml`，排程每日 07:17 UTC ＋ 可手動觸發。）放排程而不是放 push，三個理由：
  它花**真的上游配額**（上游按出口 IP 限流，Vercel 的出口 IP 是共用池）；漂移按天發生、不按 commit 發生；
  混進 push 的臨界路徑只會讓 CI 變成隨機紅。它的輸出是**漂移警示**，不進 `design/` 事實表（規則 12）。
  （T3.4 與它的 secret 都已就緒：見已完成 2026-10-11。排程每日 07:17 UTC 自己跑，不用人盯。）
- ~~**T3.5** 在 workflow 註解與 `design/` 標明 CI 出口邊界（只跑 `probe-live`、不跑 `probe-upstream`）。~~
  （**已做**：檔頭註解兩個 workflow 都有，結論在 AGENTS 規則 12；`design/` 依規則 14 不重複同一件事。）
  （T3.5／T3.6 已定案，見下方「已定案」：CI 只有一條路，不加徽章。）

### T4 依語言方向收參數 —— 本輪不觸發（結算寫在下方「已定案」）

- ~~**T4.2** 把「尾部被截」變成使用者看得到的說明~~ ⏱15 → **已做**（README 兩份的「最後幾行少了，怎麼辦」＋
  `x-proxy-hint` 在 `max_tokens` 超過上游上限時也會出現；標頭插件不讀，所以文字必須在 README）。
- **T4.1 不觸發**（不是取消）：T1.1 的實測把邊界變成明確算式——`塊輸入字元 × 0.83 ≤ 4,096`（上游硬上限），
  現行 `MAX_INPUT_CHARS=2,500` 預估只用到一半。**只有在某方向的實際膨脹比明顯高於 0.83 時**才需要收緊，
  而收緊的方向是安全的（少切一點，不會譯到一半斷）。觸發條件就是 T1.2/T1.3 那兩條。

### T5 定期家務

- **Vercel token：要用的時候現簽，別存著** ⏱5：2026-10-11 這一次用的是**只有 24 小時**壽命的 token（簽了就用、
  不進 repo、不進文件）。之前那把號稱 7 天的沒有留記錄，事後也不知道在哪 → 家務規則改成「**部署前現簽、
  用完不留**」，而不是養一把長期 token。`VERCEL_TEAM_ID` 這把實際上不需要（個人帳號，API 不帶 teamId 就行）。
  `ITP_KEY` 若要與 GitHub 那把分開管理：Vercel 的 Settings → Environment Variables 改。
- **CI 的 runner 注記**（不碰協定碼）⏱5：`actions/checkout@v4`／`actions/setup-node@v4` 會自報「Node 20 已棄用」
  警告（不影響結果）；`ubuntu-latest` 將於 2026-10-19 轉 Ubuntu 26 → 哪天換 `@v5` 即可。
- **推鏡像** ⏱1：`git push github main`（CI 的載體，規則 12）。
- （T5.1 已做完並線上驗證：見已完成 2026-10-11。要重現標記就用 `npm run deploy:vercel`——它會先設 `GIT_COMMIT`。）

## 已定案（不再列為待做，往後也不再重複提問）

- **切塊與輸出參數維持現值（2026-10-11，有實測）**：`MAX_INPUT_CHARS=2500`、`MAX_TOKENS_DEFAULT=4096`
  不動。理由是一条明確的算式，不是感覺：上游對 `max_tokens` 的硬上限是 4,096 completion tokens（實測），
  已測最壞的膨脹比是 0.83 tokens／輸入字元 → 4,096 對應約 4,900 字元，而 2,500 字元的塊預估 ~2,075 tokens。
  `MAX_TOKENS_DEFAULT` 的上界因此夾在 4,096（設更大在上游不會發生作用）。要動這組數字的前提是
  「某方向膨脹比被實測明顯高於 0.83」或「上游改了上限」，兩者都要先重測（`node scripts/probe-upstream.mjs ceiling`）。

- **不花錢**：兩個平台都只用免費層；不升級、不加需要付費的狀態服務或跨實例計數。→ 規則 7 的併發閘因此**永久是
  per-instance**，主要防線是插件端「每秒最大請求數」3~5（README 已寫）。已寫進 AGENTS 規則 7 與「刻意不做」。
- **不再追換出口**：CF 入口維持「可選、不啟用」；Tunnel origin、WARP、其他 serverless 平台**不再評估、也不再作為問題提出**。
  理由：要連到上游，上游本來就提供公網端點與官方的呼叫方式；本專案只補一個 client 能用的同形狀端點，
  不自己維護一條網路。Vercel 出口已可用，這就夠 → `design/egress-options.md` §4。
- 既有 `design/` 文件與 `src/worker.js`（CF 入口）**保留不刪**。
- **key 衛生**（2026-10-11 已做）：README 公開過的示範 key 已輪換（Production／Preview／Development 三個環境都換、
  重新部署、`probe-live` 用新 key 重跑 21/0/1），README 裡出現 0 次。往後規則：**實際用的 key 一律不進文件**。
- **CI 只有一條路（2026-10-11 定案）**：GitHub Actions。自建 Forgejo **不放 workflow**、不加 runner、
  不做 CI 的複製品；兩份 README 也**不加狀態徽章**（本專案定位是自己用，徽章會讓人以為在比別人的部署）。
  `github` 鏡像仍是**必需載體**——CI 就跑在上面，所以 `git push github main` 照舊要推。原本的可選項 T3.5／T3.6
  因此結案，往後不再提。
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
- 2026-10-11：**上游 `max_tokens` 硬上限證實 ＋「尾部少了」變成使用者能照做的說明**（`3f4b42a`、`6a82d93`）——
  一檔 `max_tokens:16384` 把 AGENTS 事實表最後一個「推定」換成實測（4,096 是硬上限，證據
  `tests/fixtures/ceiling-16384.summary.json` + `design/upstream-probe-2026-10-10.md` §11）；由它推出來的是
  **算式而不是猜測**（`塊輸入字元 × 0.83 ≤ 4,096` → 現行 2,500 只用一半，所以不調，見「已定案」）。
  客戶端帶超過上限會被上游**靜默**鉗掉 → 不覆蓋他的值（規則 9），改用 `x-proxy-hint` 說明誰丟的尾部（規則 6）；
  `MAX_TOKENS_DEFAULT` 的可調上界夾到 4,096；README 兩份新增「最後幾行少了，怎麼辦」三種情況三種處理，
  順帶修掉「`x-proxy-hint` 只在錯誤回應出現」這處文件錯。測試 96 pass／0 fail、smoke 51 ok、兩份 README 對等。
  同批把 README 的 tagline **取消置中**（只置中標題與語言按鈕——三行置中讀起來很吃力，使用者回饋）。

- 2026-10-11：**定位定案＋ CI 起跑（T3.1→T3.3）** —— 一次性探測專案（Vercel 兩個、CF 兩個）已全部清理，`probes/README.md` 與
  `design/egress-options.md` 同步為「已刪除、可重新部署」；**CI 改到 GitHub Actions**（AGENTS 規則 12 反轉，
  `github` 鏡像是必需載體，並規定 CI 只跑 `probe-live`、不跑 `probe-upstream`）；「不花錢」「不再追換出口」
  寫入 AGENTS 規則 7／刻意不做／egress §4；待做拆成可分段交付的子任務（T1~T5）；同日 key 輪換結帳（見「已定案」）。
  **T3.1→T3.3 已交**：`.github/workflows/ci.yml` 現在是 `lint:zh` → `lint:readme` → `smoke` → `npm test` 四步，
  全部離線（`smoke` 用假 upstream）、不碰 secrets、不花上游配額——規則 11 的兩個不變量自此由機器守，不靠人腦記得同步。
  線上 `38105805272` 按步驟核對過（`smoke` 51 ok/0 fail、`# pass 82`）。
  另：繁簡字檢查限定在 `AGENTS.md`／`TODO.md`／`README.md` 三份，其他檔案不再做繁簡訂正；
  四處 `2026-10-12` 的時間戳結帳為 2026-10-11（用 commit 時戳核對，不是肉眼看）。
  **T3.4 已交**：`.github/workflows/live-probe.yml` —— 排程 `probe-live` 打已部署入口，缺 `ITP_PROBE_KEY`
  就明確失敗（不假裝測過）；只差把那把 secret 設進去（見待做 T3.4a）。
  **T3.4a 同日結帳，而且原因值得留**：Vercel 的「複製環境變數」會把**變數名稱一起複製** → 貼進 secret 的值帶著
  `ITP_KEY=` 前綴，所以首跑 `38106853772` 是 `6 ok / 15 fail`（全部 401，而 401 的 body 是我們自己的文案、
  `GET /` 又回 `x-proxy-auth: configured` → 判別是「兩邊是不同的 key」，不是端點壞了）。重貼後
  **`38107205187`：21 ok / 0 fail / 1 skip（探測本身 27.2s）**，而 client 是 **GitHub 托管 runner 的出口**，
  不是我的網路——同一把數字換一個出口還是同一把，這是「已線上驗證」最強的一次證據。
  規則 7 那項照樣如實 skip（Vercel 把 12 個併發分散到多個實例，per-instance 的閘不會擋）。
  **T5.1（同日的另一項）**：加了 `x-proxy-build`（12 字元 commit）與 `scripts/deploy-ref-vercel.mjs`，
  排程探測紅的時候才能說「是哪一份代碼在那個網址上」。本地 runtime 已證（200／401／204 都帶、沒設 `GIT_COMMIT`
  就不帶），測試 +9（91 全過），兩份 README 的標頭表同步——順帶修掉一個文件錯：README 寫的是 `x-proxy-truncated`，
  代碼實際發的是 `x-proxy-chunk-truncated`。線上那一半要用 `VERCEL_TOKEN` 部署才能驗（見待做 T5.1）。
  **T5.1 同日線上結帳**（一把只有 24 小時的 `VERCEL_TOKEN`，不進 repo、不進文件）：先用 `vercel env pull` 證實
  `VERCEL_GIT_COMMIT_SHA` 是**空字串**（值只有兩個字元＝一對引號）而 `GIT_COMMIT` 42 字元 → 「自己要設」有實據。
  部署後 `GET /` 回 `x-proxy-build: 255b30db7f21`（＝當時 HEAD），排程探測 `38108762173` 的總結行印出
  「22 ok / 0 fail / 1 skip（平台：vercel，**建置 255b30db7f21**，26.3s）」。
  **時序那一項是必經的**：標記是在出口重新包一層 Response，包錯的話內容檢查不會紅。`probe-sse-timing` 兩側真增量
  （上游 152 行跨 2,715ms、經代理 147 行跨 3,233ms）。順帶修掉該腳本的判定錯誤：固定 800ms 的地板會把
  「83 行跨 610ms」這種**快但真的增量**判成 FAIL；改成 `max(250ms, (行數-1)×6ms)`，並用「72 行同一瞬間 → 拒」
  這種形狀核過規則本身（不燒配額）。
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
