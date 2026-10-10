# design/why-proxy.md — 為什麼需要這個代理（以及它不解決什麼）

> 這裡只寫**論證**。具體數字與原始證據在 [`upstream-probe-2026-10-10.md`](upstream-probe-2026-10-10.md)、
> [`egress-options.md`](egress-options.md)、[`model-allowlist.md`](model-allowlist.md)；
> 不可妥協的約束在 `../AGENTS.md`。README 不重複這些（規則 14）。

## 上游是免費公網端點，但不是誰都能直接用

`https://index-translate.bilibili.com/v1` 免費、不需金鑰、OpenAI 相容。但從瀏覽器以外的 client 直接打它會碰到四件事
（都是實測，不是猜測）：

1. **UA 黑名單**：`python-requests/*`、`Python-urllib/*` 這類機器人 UA 會被 WAF 回 **412**（HTML，沒進模型）。
   插件的背景腳本、server 端工具、腳本試探都屬於這一類 → 需要一個**固定 UA** 的出口。
2. **出口在哪**：同一個域名依 client 解析到不同的 CDN 前端。從 **Cloudflare Worker 出口打過去一定 412**，
   從 **Vercel 出口可以**（成因與選項見 egress-options.md）。這就是主入口在 Vercel 的原因。
3. **非串流會被砍**：非串流請求生成超過 10 秒 → 上游回 504。所以代理**一律向上游要 SSE**，
   非串流的客戶端再由代理組回單一 `chat.completion`（規則 3）。
4. **截斷在輸出側**：預設完成上限 2,048 tokens，用完就 `finish_reason:"length"`。不檢查這個欄位，
   「譯到一半」看起來就像正常完成（規則 4）。

## 代理只做這四件事，其餘都不做

固定 UA、路徑正規化（插件填的網址形狀跟上游不一樣）、強制串流／必要時在**行界**切塊再接回、
以及一把自己的門（`ITP_KEY`）。不改 prompt、不換模型、不快取、不改上游的 status 與 body。

**它不解決的**：上游的配額（60k tokens/min **按 IP**，而雲端出口是共用池）、上游模型的代幣解碼缺陷、
翻譯品質、以及「上游哪天撤回某個模型名稱」這種事。這些只能誠實標出來，不能假裝不存在。
