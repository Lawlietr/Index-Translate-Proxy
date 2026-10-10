# design/auth.md — 本代理的鑑權與配額守門

狀態：**設計定案（2026-10-10）**，尚未實作（見 [`../TODO.md`](../TODO.md)）。
對應 `AGENTS.md` 規則 8（不轉發上游）與規則 7（並發）。

## 為什麼必須有 key（不是裝飾）

這個代理是**自己部署、自己用**的：沒有公共實例，也沒有共用示範 key。但那不代表可以省掉鑑權——

| 事實 | 來源 |
|---|---|
| 上游有 **60,000 tokens/min per IP**，超限回 `429` + `retry-after: 1`，body 為 `{"error":{"type":"rate_limit_error","code":429,"retry_after":1,…}}` | 2026-10-10 實測公網端點 |
| 雲端函式的出口 IP 是**共用池**（Vercel／CF 皆然）→ 你的實例花的正是那份 per-IP 配額，而那個 IP 不是只有你在用 | 平台性質；Vercel 側已實測 429 的形狀與 `retry-after` |
| 網址一旦外洩，陌生人掃到就是**免費用你的配額**（還可能掃爆函式額度） | 匿名公開端點的常見結果；`GET /` 自報設定，更容易被認出來 |

結論：**key 是這份配額唯一的門。** 它不是上遊的 key（上游不需鑑權），纯粹是你给自己的部署装的一道門。

## 定案

1. **一份部署一把 key**（2026-10-10 定案；不做多租戶）。存 `wrangler secret put ITP_KEY`，Vercel 則放
   Environment Variables；不做多 key、不用 KV／D1 存 key。撤銷＝換一把並重設（`openssl rand -hex 32`）。
   **不要把實際用的 key 寫進 README 或任何公開文件**——這份文件曾放過一把示範 key，已輪換作廢。
2. **比對用 SHA-256 hex**，不逐字元比較明文（避免時序側信道，也保證日誌不會出現 key）。

   **key 是不透明字串**（2026-10-12 補）：沒有長度上限、沒有字元集驗證，只要不是空白都行——比較的是兩邊的
   SHA-256，所以程式碼這一側故意不設花樣。**實際限制都來自平台與 HTTP 標頭**：

   | 限制 | 值 | 來源 |
   |---|---|---|
   | Vercel 單一環境變數（**edge runtime**） | 5 KB | Vercel 文件（其他 runtime 是每部署合計 64 KB）；我們的入口是 edge |
   | 改動生效 | 改 env **不會**套用到既有 deployment，要重新部署 | Vercel 文件明載 |
   | 標頭安全 | 用 ASCII（hex／base64url）。非 ASCII 走 HTTP 標頭，各 client 處理不同，會以「key 不正確」的形式失敗 | 協定層；非本專案實測 |
   | 前後空白 | 兩側都 `trim()`；**全空白＝未設定 → 503** | 實作（2026-10-12 對齊，含測試） |

   建議產生方式仍是 `openssl rand -hex 32`（64 字元，ASCII、無空白，不會踩到上面任何一條）。
   日誌只記 `auth: ok | missing | invalid`。
3. **讀取順序**：`Authorization: Bearer <key>` → 退回 `x-api-key`。**不**支援 query／path 帶 key
   （會留在瀏覽器歷史與 CF 日誌，也可能被 Referer 帶走）。
4. **固定流程順序**（順序錯了會踩坑）：

   ```
   OPTIONS 預檢 → 不鑑權，回 204 + Access-Control-Allow-Headers: authorization, content-type
     ↓
   鑑權 → 失敗即 401（此時尚未碰上游，不消耗 TPM）
     ↓
   規則 7 的並發閘
     ↓
   切塊（規則 4）／強制串流（規則 3）／轉發上游
   ```

   `Access-Control-Allow-Headers` 少了 `authorization` 時，插件只會報 CORS 失敗，不會告訴你原因。
   上游自己回的 `access-control-allow-origin: *` 救不了我們這一層（規則 8 的標頭政策不影響這裡）。
5. **401 必須是 OpenAI 錯誤形狀**，否則插件只顯示「請求失敗」，無從除錯：

   ```json
   {"error":{"message":"未提供 API Key：請在插件的 API Key 欄位填入本代理的 key","type":"authentication_error","code":401}}
   ```

   加 `WWW-Authenticate: Bearer`。「未提供」與「不正確」給不同 message，但不洩漏哪把 key 有效。
   這是**我們本地**的錯誤，不受規則 6（不改上游 status/body）約束——規則 6 只管上游回來的回應。
6. **401 走獨立限流**（2026-10-10 決定）：用 CF 的 Rate Limiting binding，按客戶端 IP 計，
   不與正常流量的額度混在一起。

   ```toml
   [[ratelimits]]
   name = "AUTH_RL"
   namespace_id = "1001"   # 帳號內唯一即可，用固定值（便於別人一鍵部署）
     [ratelimits.simple]
     limit = 30
     period = 60           # 只允許 10 或 60
   ```

   key 用 `request.headers.get("cf-connecting-ip")`；不可用時退回 `request.ip`。
   `success: false` → 回 429 + `Retry-After: 60`（同樣的 OpenAI 錯誤形狀）。
7. **規則 8 不變**：驗完即丟，絕不轉發 `Authorization`／`x-api-key`／`cookie`／CF `x-*` 給上游
   （上游不需鑑權，填的 key 對上游無意義）。README 要明寫「這個 key 是我們的門，不是上游的」。

## 配額守門的殘留缺口（要誠實寫出來）

請求級限流擋不住真正的稀缺資源：**4 個 4000 字元的塊就能吃掉一分鐘的 TPM**。
實測 3,800 字元 ≈ 3,644 prompt tokens（CJK ≈ 1.04 token/字元）→ 代理內可以用字元數粗估，
做 per-minute 軟預算。但要「精確」必須跨 isolate 共享計數（Durable Objects），那是另一個複雜度。

第一版只做：字元數粗估的軟預算 + 上游 `429`/`retry-after` 原樣透傳（規則 6），
hint 建議使用者把插件的「每秒最大請求數」降到 2~3。是否需要升級到 DO，
由 `scripts/probe-live.mjs` 的「同一 worker 兩次請求是否被上游算進同一個 IP 配額」結果決定。

## 刻意不做

| 做法 | 理由 |
|---|---|
| Cloudflare Access／Zero Trust service token | 插件只能填 API Key，無法加自訂 header 或走 IdP → 打不通 |
| Turnstile | 瀏覽器插件不會跑 widget |
| HMAC 簽名／短效 token | 插件算不出簽名，只有靜態 key 欄位 |
| KV／D1 存 key 與使用統計 | 一把共用 key 不需要存儲；免費層 KV 寫入 1k/天也不夠做 token 計數 |
| 多把 key（per-device） | 自用量小，只增加維護成本；若之後要區分裝置再改 |

## 連動

- `AGENTS.md`：規則 8（先鑑權、key 不進上游）與規則 13（探測清單加 401／429）**已改**。
- 尚未做的兩項列在 [`../TODO.md`](../TODO.md)：README 的「API Key｜任填」要改成「填本代理的 key」，
  以及新增 `.dev.vars.example`（只有 `ITP_KEY=`）——後者同時是「Deploy to Cloudflare」按鈕的必填檔案，
  見 [`deploy-button.md`](deploy-button.md)。本檔不重複它們的細節。
