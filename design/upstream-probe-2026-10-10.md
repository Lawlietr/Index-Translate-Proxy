# design/upstream-probe-2026-10-10.md — 公網端點第二輪探測紀錄

方法：`scripts/probe-upstream.mjs`（本輪新增）。分群組跑，每組只印一行摘要，原始證據寫進 `tests/fixtures/`
（SSE／錯誤 body＋`probe-*.json` 摘要）。所有數字都是本輪實測，時間為 2026-10-10 19:11–19:25（台北）。
UA 相關結論先做 self-check：用 httpbin 回憶標頭，證明 `node:https` 在「不設 UA」時**真的不送**該標頭
（`ua-echo:none → (none → 真的沒送)`），否則「不送 UA 會怎樣」的結論不可信。

請求形狀固定為：`POST /v1/chat/completions`，`stream: true`，`source_language: Chinese`、
`target_translation: English`、`chat_template_kwargs.enable_thinking:false`，輸入是**編號行**
（`1. …\n2. …`）以便用編號回傳判斷行覆蓋率——這正是插件的行對應協定。

## 1. 最重要：截斷發生在**輸出側**，而且是可偵測的

預設完成上限是 **2,048 completion tokens**，用完就停，`finish_reason` 給 **`"length"`**：

| 輸入 | 輸入行數 | 回傳行數 | `finish_reason` | `completion_tokens` | 總時間 |
|---|---|---|---|---|---|
| 1,047 字元 | 18 | 18 ✅ | `stop` | — | 7.9s |
| 1,524 | 26 | 26 ✅ | `stop` | — | 10.2s |
| 2,001 | 34 | 34 ✅ | `stop` | — | 13.9s |
| 2,200 | 38 | 38 ✅ | `stop` | 1,878 | 16.1s |
| 2,400 | 41 | 41 ✅ | `stop` | 2,019 | 16.7s |
| **2,600** | 44 | **42** ❌ | `length` | 2,048 | 16.3s |
| 3,040 | 51 | 42 ❌ | `length` | 2,048 | 17.0s |
| 4,050 | 68 | 42 ❌ | `length` | 2,048 | 18.8s |
| 6,047 | 101 | 42 ❌ | `length` | 2,048 | 17.9s |

三個不同輸入長度都停在**同樣的 10,311 字元輸出／42 行**——所以瓶頸不是輸入字數，是完成長度。
「輸入約 4,000 字元會截斷」這個舊說法（來自未公開的姐妹專案）**不成立**，至少對 zh→en 不是這個機制。

**上限可以抬高**（同一腳本 `raise` 群組）：

| 請求 | 輸入行數 | 回傳 | `finish_reason` | `completion_tokens` | 時間 |
|---|---|---|---|---|---|
| `max_tokens: 40` | 15 | 1 | `length` | 40 | 1.0s |
| `max_tokens: 4096` | 51 | **51 ✅** | `stop` | 2,512 | 35.7s |
| `max_tokens: 8192` | 101 | 83 ❌ | `length` | **4,096** | 47.9s |

- `max_tokens` 被**精確尊重**（要 40 就停在 40）。
- 要 8192 卻停在恰好 4,096 → **推定上游把 max_tokens 鉗在 4,096**（要證明需再測 16384 一檔，見「未證明」）。
- 3,040 字元在 `max_tokens:4096` 下**完整譯完**（51/51 行，2,512 tokens）。由此得 zh→en 的膨脹比
  ≈ **0.83 completion tokens / 輸入字元**（3,040→2,512；6,047→約 5,000）。

**對實作的影響（這條會改設計）：**
1. 只按「輸入字元」切塊是錯的控制量；真正的約束是 `輸出 tokens ≤ 上游上限`。代理一律自己帶
   `max_tokens: 4096`（客戶端有帶就尊重客戶端的），把可用預算從 2,048 抬到 4,096。
2. 在此前提下，單塊輸入 ~3,000 字元（zh→en 實測完整）比原本的 1,500 保守值安全一倍以上；
   `MAX_INPUT_CHARS` 定為 **2,500**（留 margin，見 `design/streaming-and-chunking.md`）。
3. **必須檢查 `finish_reason === "length"`**：它是「尾部被丟」的唯一訊號。出現且不是客戶端自己要求的
   `max_tokens` → 加 `x-proxy-chunk-truncated: <塊序>` ＋ hint，不可當正常完成。
4. 生成到 2,000 tokens 要 16s、2,500 tokens 要 35s → 非串流必定撞上游 10s 504（規則 3 強制串流的理由，再次成立）。

## 2. UA：黑名單是特定機器人字串，不是「沒有 UA」

| UA | 結果 | 延遲 |
|---|---|---|
| 不送（self-check 證明真的沒送） | **200** | 771ms |
| `User-Agent: ""`（空值） | 200 | 421ms |
| `python-requests/2.32.3` | **412** | 93ms |
| `Python-urllib/3.12` | **412** | 75ms |
| `curl/8.5.0` | 200 | 415ms |
| Chrome 126 完整 UA | 200 | 461ms |
| `Cloudflare-Workers` | 200 | 456ms |
| `Index-Translate-Proxy/0.1 (https://github.com/Lawlietr/Index-Translate-Proxy)` | 200 | 413ms |
| `Index-Translate-Client/1.0`（官方客戶端） | 200 | 715ms |
| Chrome UA ＋ `Referer`/`Accept-Language` | 200 | 720ms |

- 2026-10-08 那輪的「不送 UA → 412」**重現不了**；現行政策是**特定機器人 UA 黑名單**（Python 系）。
  舊紀錄可能是當時的請求實際帶著 UA（curl 預設就帶 `curl/x.y`），無法回溯驗證 → 舊那格標為不可信。
- 412 的 body 是 **HTML 網頁（3,400 字元）**，不是 JSON，且 93ms 就回 → 代理**不能假設錯誤是 JSON**，
  透傳時要按 content-type 處理；另外 412 來得這麼快，說明是 WAF 層擋的，沒進模型。
- **決定（規則 2）**：固定用自訂、可識別的 UA：`Index-Translate-Proxy/0.1 (+repo URL)`。
  實測 200，比假裝瀏覽器誠實，也能讓上游看出流量來源。

## 3. 模型：`model` 回顯不可信，白名單外的名字會靜默換模型

| 請求的 model | status | 回顯的 `model` |
|---|---|---|
| `Index-Translate-35B-A3B` | 200 | `Index-Translate-35B-A3B` |
| `index-mt-9b`（400 自報清單裡的） | 200 | **`qwen35-9b-6624275-iter999`**（內部部署名） |
| `Index-Translate-35B-A3B-preview` | 200 | `Index-Translate-35B-A3B` ← **靜默退回** |
| `model: ""` | 200 | `Index-Translate-35B-A3B` |
| `index-homura-35b-a3b`（已撤回） | 400 | — |
| `gpt-4o-mini` | 400 | — |

400 的 body（兩檔相同格式）：`{"detail":"未知模型 '<name>'，公開支持模型: Index-Translate-35B-A3B, index-mt-2b, index-mt-9b, index-mt-2b-syllable, index-mt-9b-syllable"}`

→ 回顯值可能是內部部署名，也可能被換成 35B-A3B，**不能拿來驗證跑的是哪個模型**。規則 1 只放行
`Index-Translate-35B-A3B`、其餘本地 400，這條现在有證據。400 用 `detail` 欄位而不是 OpenAI 的
`error` 形狀 → 若要給客戶端清楚的訊息，得由我們補 hint（規則 6），不能改 body。

## 4. `usage`：預設不給，但可以被要到

| 請求 | usage |
|---|---|
| `stream:true`（不帶其他） | **無** |
| `stream:true, stream_options:{include_usage:true}` | 有：`{"completion_tokens":33,"prompt_tokens":68,"total_tokens":101,"prompt_tokens_details":{"cached_tokens":64}}` |
| 非串流 | 有 |

→ 代理強制串流會把 usage 弄丢，所以自己補 `stream_options:{include_usage:true}`（規則 9 的協議層注入）。
這也讓我們能用**實際 completion tokens** 控制切塊，而不是靠字元猜。
另外 prompt tokens 與字元數的比例依文本而變：本輪 6,047 字元 → 3,901 tokens（0.65），
2,400 字元 → 1,584（0.66）；而 2026-10-10 早間 3,800 字元 → 3,644（0.96）。**所以別用字元換算 token。**

## 5. 思考標記：公網端點沒有可見差異

`enable_thinking:false` 與 `true`：輸出 186 vs 183 字元、41 vs 40 個 delta、**兩者都沒有** `<think>`／`<|im_*|>`
標記。維持早間的結論：公網端點預設已等同關閉，規則 9 的注入是「換端點不漏」的保險，不是當下必需。

## 6. 配額與併發：沒碰到 429，但併發只增加延遲

- 12 串流請求（每個 900 字元輸入、約 20k tokens／90 秒）：**全 200，未觸發 429**。
- 10 個**併發**請求（每個 2,400 字元、共約 36k tokens）：全 200，但總時間從 21.9s 變成 **47.8s（≈5 倍）**，
  每個的回傳量一模一樣（2,019 tokens）→ **上游大致是串行處理的，併發不增加吞吐，只增加延遲**。
  這是規則 7（本地並發上限 4）與「插件每秒最大請求數 3~5」最直接的證據。
- 本輪未再現 429，也沒有配額查詢端點可查 → 429 的 body 形狀沿用早間記錄（見 `AGENTS.md` 事實表），
  尚未有 429 的 fixture；離線測試先用手抄的真實 body（待做 5）。
- 單發延遲基線：小請求 TTFT 170–560ms／總 400–770ms；900 字元 173–473ms TTFT／6.0–7.2s 總；
  6,047 字元 TTFT 375–1,019ms／17.9–19.0s。**TTFT 與輸入長度無關** → 真增量再次確認（早間那條結論穩）。

## 7. 行對應是**提示條件式**的（第三輪：打 worker 時發現）

用 `scripts/probe-live.mjs` 打本地 worker（miniflare → 真上游）時，兩項行對應檢查失敗：

| 輸入 | 带了什麼 | 輸入行數 | 回傳行數 | 回傳形狀 |
|---|---|---|---|---|
| `1. The cat sleeps.` ×3 | 無 system、無 `target_translation` | 3 | **38** | 「Here are the translations … ### **Spanish** …」：前言 + 每句展開成多語言 |
| 40 行編號句 | 同上 | 40 | **7** | 同上（只處理了一部分） |
| 3 行編號句 | `system`（自寫的翻譯指令）+ `target_translation:"Chinese"` | 3 | **3** ✅ | 逐行譯文 |
| 40 行編號句 | 同上 | 40 | **40** ✅ | 逐行譯文，不黏行 |

結論：**行對應不是端點的保證，是提示的形狀決定的**。上面 §1 那些 18/18、34/34、51/51 都帶了
`system` + `source_language`/`target_translation`；去掉指令後同一個端點就不逐行回。

邊界（誰該做什麼）：插件本來就帶自己的提示模板（所以上面第二行那種輸入在真實流量裡少見），
本代理也不注入 prompt 文字（規則 9）→ 這件事修不了，只能：（a）不讓它更糟（不重編編號、不黏行、
按原分隔接回），（b）用 `x-proxy-chunk-lines` 把「邊側幾行」暴露出來，（c）在 README 寫清楚。

## 8. 致命的第四輪：**從 Cloudflare 出口打上游，一律 412**（已部署後實測）

`wrangler deploy` 上線後跑 `scripts/probe-live.mjs`：本地 miniflare 19/19，**線上只有 9/19**，
所有碰到上游的檢查都是 412。這不是腳本問題，是**路徑問題**。用一個一次性探測 worker
（`itp-ua-probe`，已刪）直接對上游發請求：

| 從 Worker 出口發的請求 | 結果 |
|---|---|
| `GET /v1/models`（不動 UA） | **412**，33–186ms，body 是 bilibili 的簡體擋封頁（`server: cloudflare`、`cf-cache-status: DYNAMIC`） |
| 自訂 token UA / 瀏覽器 UA | **412**（同上） |
| `GET /`、`POST /v1/chat/completions`、走明文 `http://` | **412** |
| `www.bilibili.com/`（對照，同一個站的根） | **412** |
| `api.ipify.org`（對照，非 bilibili） | **200**，出口是 `2a06:98c0:3600::103`（CF AS13335 的 IPv6） |
| `fetch` + `cf.resolveOverride` → `103.151.151.133`（bilibili 自家 CDN IP） | **412** |
| `cloudflare:sockets` 直連 `103.151.151.4/133/134:443`（帶 SNI/Host）與 `:80` | 連得上但**零位元組回應**（不是可用的路徑） |

當下的判讀（**已在 §9 修正**）：擋下來的是 **CF 邊緣的 bot 過濾**，條件是**出口 IP 的等級**，
**不是 UA**——UA 在本地能決定 200/412（§2），在 CF 出口则全被擋。
上游無 AAAA（只 A 記錄），所以不是 IPv6 的問題。

**這動到專案的立論**：AGENTS 的第一段說「上游 WAF 擋特定機器人 UA，所以非瀏覽器的 client 需要一個
固定 UA 的出口」——這句話在**本機**成立（官方那個 `call_api.py --serve` 就是這個用途），
但**以 Cloudflare Worker 作為出口不成立**。可行的出路（未測）：
（a）Cloudflare Network egress／WARP connector 把出口換成 AS9009 的 IP；
（b）中转放在非 CF 出口（自有機器／隧道），Worker 只做鑑權＋切塊＋組包；
（c）請上游白名單 CF 出口。選 (a) 前要確認 Zero Trust 有 seat 與 token 權限（本輪那兩個 API 回 403）。

## 9. 第五輪：擋人的是 **bilibili 自己的風控**，而且兩條路的前端不同（§8 判讀修訂）

§8 的「CF 邊緣 bot 過濾」這個判讀**不對**，重測後：

| 證據 | 內容 |
|---|---|
| 擋封頁的文字（上游原文，簡體） | `出错啦! - bilibili.com` … 「由於触发哔哩哔哩安全风控策略，该次访问请求被拒绝。The request was rejected because of the bilibili security control policy.」——這是 **bilibili 的 412 模板**，不是 Cloudflare 的錯誤頁 |
| 第二種 body | 有些請求回 `{"code":-412,"message":"request was banned","ttl":1}`（JSON），也是 bilibili 風控的形狀 |
| **本機直連上游** | `HTTP/2 200`、`server: uvicorn`（就是 Index-Translate 那個 FastAPI）、`x-cache-webcdn: BYPASS from blzone09`，**完全沒有 `cf-ray`** → 本機這條路**不經過 Cloudflare** |
| 從 Worker 出去 | `server: cloudflare` → 落進 bilibili 的 **CF 代理邊緣**，再被它的 origin 風控擋掉 |

所以：**不是「我們把請求帶壞了」，而是同一個 host 有兩條路**：
bilibili 自家 CDN（`103.151.151.x`，能通）與 Cloudflare 代理邊緣（從 CF 出口必經，被風控擋）。

**對三條出路的影響**（重要）：
- **WARP egress 不一定有用**：WARP 只換**來源 IP**（AS9009），不會換**目的地邊緣**；如果擋人的是 bilibili 的
  CF zone 對「來自 CF 內部／資料中心來源」的規則，換來源 IP 無效。**未測**（Zero Trust API 回 403）。
- **Tunnel origin（自架 connector）可行度高**：Worker → 自己 zone 的 Tunnel origin（這一段在 CF 內部，不會被擋）
  → connector 在本地機器打上游（就是上面那條 200 的路）。計算還是 serverless，出口是自有線路。
- 舊證據：自己帳號裡 2026-10-06 就有一個同目的地的 worker `bil-translate-proxy`（瀏覽器 UA + `origin: translate-cloud.pages.dev`），
  現在也是 **412** → 這個問題比本 repo 早，不是新代碼造成的。
- 使用者在 `*.dpdns.org` / `avpclub.eu.org` / `avpclub.uk` 這些**自己的 zone** 上的規則（如「擋中國 IP」）
  **不會作用在對外的請求**上（zone 規則只管進入該 zone 的流量），而 `*.workers.dev` 與 `*.pages.dev`
  本來就沒有 zone 可設規則；`firewall/rules` API 回 403，看不到那些規則（無法進一步查證）。
## 未證明（下一輪再補，成本都不高）

1. `max_tokens` 是否被鉗在 4,096：只需一檔 `max_tokens:16384` ＋ 6,000 字元輸入。
2. 429 的真實 fixture：要把 token 堆到 60k/min 才會觸發（估計要 ~25 個 2,400 字元請求在一分鐘內）。
3. 其他語言方向的膨脹比：只測了 zh→en；`en→zh`、`ja→zh` 的 output/input 比例可能差很多，
   直接影響 `MAX_INPUT_CHARS` 的邊界（對繁體中文→中文這種不翻譯的情況還沒看過）。
4. ~~從 Cloudflare edge 打上游的實際延遲~~ → 已測：**打不到**（§8，412）。要改成「换出口後能不能打到」。
5. 上游是否會因 `max_tokens:4096` 這類注入而改變其他行為（只測過 2,512 tokens 的成功案例）。
