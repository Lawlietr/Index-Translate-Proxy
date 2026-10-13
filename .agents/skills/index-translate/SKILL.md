---
name: index-translate
description: 把翻譯工作分攤給 Index-Translate（bilibili 的開源翻譯模型，經 Index-Translate-Proxy）。要翻譯文件、README、程式註解、commit 訊息、大段文字，或做中英雙語同步時用它的 translate 工具，不要自己逐字翻。含編號的行會逐行對應、保留編號。
license: MIT
compatibility: 先為 agent 配好這個 MCP（pi 是 `~/.pi/agent/mcp.json` 的 `index-translate` 條目，其他 client 各有各的設定檔）與其中的 `ITP_KEY`。沒配好時這些工具根本不會出現 → 先查再呼叫，別假裝成功。上游不可用時 `index_translate_models` 仍會成功（它走代理本地），可用來分辨故障在哪一側。
---

# Index-Translate 翻譯

本技能假定 agent 已接好一個 MCP server（母本在 repo 的 `examples/mcp/server.mjs`；`ITP_BASE` 填你自己那份部署的網址、`ITP_KEY` 填你設過的通行碼）。
提供兩個工具：`translate`、`index_translate_models`。
**設定步驟、邊界，以及一段可以直接交給你自己的 agent 的提示詞，在同目錄的 `README.md`；本檔只講怎麼用。**

## 先確認它在不在（不要假裝成功）

工具的暴露方式與名稱前綴取決於 client 的設定與版本，**先查再呼叫**：

```js
(await describeNamespace("mcp__index-translate")).tools   // 實際工具名
await searchTools("translate", { namespace: "mcp__index-translate" })
```

若是 codemode 暴露（跟 `obscura`／`playwright` 一樣），從 codemode 呼叫：

```js
const r = await tools.mcp__index_translate__translate({
  text: "1. The meeting starts at nine.\n2. Please bring the report.",
  to: "繁體中文（Traditional Chinese）",
  from: "English",
});
```

工具清單會隨 server 更新而改變，不要在腦中記一份固定的清單。
**查不到任何工具 = 這個 MCP 根本沒設定**（或 client 沒重載）。那種時候不要空轉重試：照同目錄 `README.md`
的提示詞把 MCP 與技能設好（通行碼只放環境變數或不被 git 追蹤的檔），或者這一輪自己翻、並說明你沒用到服務。

## 使用方式

`to` 是必填，用明確的語言名（`"繁體中文（Traditional Chinese）"`、`"English (US)"`、`"日本語"`）。
`from` 可省略，模型會自行判斷——但雙語文件這種「兩邊都是同一種語言、只差方向」的場景要**明確帶 `from`**，否則模型可能翻成同一邊。

**該用它的時刻**：內容是給人讀的自然語言——文件、註解、README、錯誤訊息、UI 字串、commit 訊息。
**不該用**：程式碼本身、單一識別符、API 參數名、要保留原字的引用。那些直接搬過去，或只翻註解那一段。

模型預設是清單第一位（`Index-Translate-35B-A3B`，品質最穩）。只有在**明確要速度**或內容是短句/清單時才換 `index-mt-9b`／`index-mt-2b`——兩者的翻譯品質未評量過，只是快（實測 3 行短文本串行：9b 2.0×、2b 3.2×，行對應不輸）。這個服務不做靜默降級：指定的模型不可用就報錯，不會偷偷換別個模型，所以報錯時要自己決定換不換。

## 該注意的點

- **被截尾會明寫 `truncated`，並講有幾塊被截**：輸出到上游的 `max_tokens` 上限（4,096 tokens）就會停，而且只從輸出側截。看到 `truncated` 就是那幾段的最後幾行不見了，要分批、每次少幾行。不要假設拿到的是完整譯文。
- **單行不得超過 2,000 字元**，超了會 413。長篇在約 2,500 字元後由代理在**行界**切塊再接回，所以**整段一次傳即可**（實測 40 行 / 2,990 字元一次傳入，切 2 塊再接回，40/40 行完整、編號無缺）。但不要自己把一段拉成超長單行。
- **編號行是它的強項**（預設 `keep_numbering: true`）：`1.` `2.` 這種會逐行對應、編號不亂。純散文、不想保留行結構時設 `false`。
- **504 有兩種，server 會指出是哪一種**，對應完全不同：body 是 Vercel 的錯誤頁 = 那份 Edge 部署被平台砍（25s 內要開始回）→ 把輸入分批；body 是 openresty = 上游本身不可用 → 分批沒用，等一會兒再試。分不清時先叫 `index_translate_models`：它成功 = 代理正常、問題在上游那一跳；它也失敗 = 代理這一跳有問題。
- **429 要照它的建議做**：上游按出口 IP 限 60,000 tokens/min。縮短單次輸入、分批，比 retries 有效。
- 翻譯結果要自己複核再落地。這個服務不保證用語一致，也不懂專案的慣用詞（例如同一個詞在中英兩份文件要對應到同一個譯字）。
- 上游可能撤回模型名稱（`index-homura-*` 有先例），所以模型清單要當**即時狀態**看，不要照抄舊紀錄。

## 雙語文件同步（中英對等）

翻完**一定要跑專案自己的對等檢查**，不能只信譯文。例如 Index-Translate-Proxy 的 `npm run lint:readme` 會檢查章節序列、表格代幣、連結、`<details>` 數量與正文數字——那些正是翻譯容易悄悄改掉的地方（數字、代幣、code fence 內容）。

做法：把需要對等的段落逐段傳過去（帶 `from` 與 `keep_numbering: true`），落地後跑 lint，再把 lint 指出的差異人工修正。翻譯是起草，不是交付。
