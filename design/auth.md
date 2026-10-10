# design/auth.md — 本代理的鑑權與配額守門

狀態：**設計定案（2026-10-10）**，尚未實作（見 [`../TODO.md`](../TODO.md)）。
對應 `AGENTS.md` 規則 8（不轉發上游）與規則 7（並發）。

## 為什麼必須有 key（不是裝飾）

| 事實 | 來源 |
|---|---|
| 上游有 **60,000 tokens/min per IP**，超限回 `429` + `retry-after: 1`，body 為 `{"error":{"type":"rate_limit_error","code":429,"retry_after":1,…}}` | 2026-10-10 實測公網端點 |
| Worker 到上游的 egress IP 是共用池 → **所有使用者共用同一份上游配額** | CF 的性質；尚未從 worker 實測（TODO：探測） |
| CF 免費層 100k 請求/天 | 匿名公開的 worker 會被陌生人掃到失效 |

結論：**鑑權是這份配額唯一的門。**

## 定案

1. **單一共用 key**（2026-10-10 決定）。存 `wrangler secret put ITP_KEY`，不做多 key、不用 KV／D1 存 key。
   撤銷＝換一把並重設 secret（`openssl rand -hex 24`，建議加前綴 `itp_`）。
2. **比對用 SHA-256 hex**，不逐字元比較明文（避免時序側信道，也保證日誌不會出現 key）。
   日誌只記 `auth: ok | missing | invalid`。
3. **讀取順序**：`Authorization: Bearer <key>` → 退回 `x-api-key`。**不**支援 query／path 帶 key
   （會留在瀏覽器歷史與 CF 日誌，也可能被 Referer 帶走）。
4. **固定流程順序**（順序错錯會踩坑）：

   ```
   OPTIONS 預檢 → 不鑑權，回 204 + Access-Control-Allow-Headers: authorization, content-type
     ↓
   鑑權 → 失敗即 401（此時尚未碰上游，不消耗 TPM）
     ↓
   規則 7 的並發閘
     ↓
   切塊（規則 4）／强制串流（規則 3）／轉發上游
   ```

   `Access-Control-Allow-Headers` 少了 `authorization` 時，插件只會報 CORS 失敗，不會告訴你原因。
   上游自己回的 `access-control-allow-origin: *` 救不了我們這一層（規則 8 的標頭政策不影響這裡）。
5. **401 必須是 OpenAI 錯誤形狀**，否則插件只显示「請求失敗」無從除錯：

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
   `success: false` → 回 429 + `Retry-After: 60`（同样 OpenAI 錯誤形狀）。
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

## 連動要改的地方

- `AGENTS.md`：規則 8 補充「本地必須驗證 `Authorization`」；規則 13 的探測清單加 401／429 兩條。
- `README.md`：「API Key｜任填」那一列改成「填本代理的 key」（不然是誤導）。
- 新增 `.dev.vars.example`（內容只有 `ITP_KEY=`）——它同時是本機開發的範本與
  「Deploy to Cloudflare」按鈕的必填檔案，見 [`deploy-button.md`](deploy-button.md)。
