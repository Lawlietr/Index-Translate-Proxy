# probes/ — 證據用的探測函式，不是產品的一部分

這裡的東西**不參與 `npm test`、不被入口 import**，存在的唯一理由是：`design/egress-options.md` 裡那條
「從 Vercel 出口打得到上游、從 Cloudflare 出口打不到（412）」的結論要能**重複驗證**，而不是只留在
一次性的 `/tmp` 目錄裡（規則 14：結論在 `design/`，可重跑的程式要在 repo）。

## `vercel-egress/` —— 出口可達性探測（Vercel 側）

> **2026-10-12：這個探測專案已從 Vercel 刪除**，所以下面的 URL 現在不存在。要重現就先跑第一行
> `vercel deploy`，拿到新的 URL 再 curl——它是一次性探測，不是長期服務。

```bash
cd probes/vercel-egress
npx vercel deploy --prod --name itp-egress-probe --scope <你的 team>   # 不需要 ITP_KEY，函式不打自己的鑑權
curl -s "https://itp-egress-probe.vercel.app/api/probe"      # 上游 /v1/models + 回應標頭（server、via、cf-*）
curl -sN "https://itp-egress-probe.vercel.app/api/stream-probe"   # 3 行翻譯，逐塊時間戳 → 看 SSE 是否真增量
curl -s  "https://itp-egress-probe.vercel.app/api/stream-variants" # 同一請求在不同 runtime／標頭下的表現
```

它**故意不帶 `ITP_KEY`**：這是公共端點，但只做探測、不代理使用者流量，配額消耗可控
（一次完整的三檔 ≈ 2 次上游請求）。要關掉就在 Vercel 把專案刪除——結論已經記在
`design/egress-options.md` 與 `design/upstream-probe-2026-10-10.md` §8–§10，刪掉不會讓文件失去依據。
**已做**：2026-10-12 兩個一次性專案（`itp-vercel-probe`、`itp-egress-probe`）已在 dashboard 刪除。

Cloudflare 側的對應探測不在這裡（是 `wrangler dev` 的一次性 worker），當時因 token 缺 `Memberships:Read`
無法用 API 刪，需在 dashboard 手動處理——**已做**（2026-10-12：`itp-ua-probe`、`itp-echo` 已清理）。
CF 出口本身被風控擋（412），所以那個入口的定案見 `../design/egress-options.md` §4；不在這裡重復評估。
