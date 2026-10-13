# examples/mcp/ —— 把這個代理接成 agent 的翻譯工具（MCP）

這裡的東西**不參與 `npm test`、不被入口 import**，也不改變部署。存在的理由是兩件事：
`design/mcp-client.md` 裡那幾條結論要能**重複驗證**（規則 14：結論在 `design/`，可重跑的程式要在 repo），
以及別人要接自己的 agent 時不用從零寫一遍。

它做的事只有一件：把 `translate` 與 `index_translate_models` 兩個工具接到你那份部署的 `/v1`。
**切塊、鑑權、強制串流全在代理那側**（AGENTS 規則 3／4／8），這個 client 不重複實作協定。

**要從 agent 那一側看這件事**（技能怎麼裝、可以直接貼給 agent 的提示詞、完整的邊界與模型速度）：
那份說明只寫一處，在 [`.agents/skills/index-translate/README.md`](../../.agents/skills/index-translate/README.md)（跟 `SKILL.md` 一樣只有繁中一份：那是給 agent 讀的，規則 11）。
這裡只留這份碼怎麼裝、怎麼接、怎麼驗、哪裡壞了。

## 接進你的 client

```bash
cd examples/mcp
npm install                 # 只裝 @modelcontextprotocol/sdk，無其他依賴
cp mcp.json.example mcp.json   # 然後把 ITP_KEY 與 ITP_BASE 填上
```

`mcp.json` 已被 `.gitignore` 抵掉——**這個 repo 是公開可讀的，key 只該出現在你本地的副本**（AGENTS 規則 17）。
`mcp.json.example` 裡值刻意留空，就是要你填在自己那份，而不是改這份被 commit 回去。
key 就是你部署時設的 `ITP_KEY`（產生：`openssl rand -hex 32`）。

各 client 的設定檔位置不同（pi 是 `~/.pi/agent/mcp.json`，Claude Desktop／其他 client 各有各的檔），
但條目形狀一樣：`command` + `args` 指向 `server.mjs`，`env` 給 `ITP_KEY` 與 `ITP_BASE`。

## 驗證它通了（不燒上游配額）

```bash
cd examples/mcp && npm install
ITP_KEY=<你的 ITP_KEY> npm run handshake   # initialize + tools/list，不碰上游
```

看到 `serverInfo` 與兩個工具的名字就是通的。真的翻譯要自己發一次 `tools/call`（或從 client 裡叫），
它會走 SSE——這是刻意的，理由與實測數字在 [`../../design/mcp-client.md`](../../design/mcp-client.md) §2。

## 用之前要知道的邊界（只留與這份碼有關的兩條）

- **翻譯指令由這個 client 放進 `system`**：只送編號句而不帶指令時，上游會加前言、把每句展開成多語言列表，
  編號對應就破掉（AGENTS 事實表「行對應」列）。所以這裡一律帶指令，不讓上游自己決定輸出形狀。
- **編號行逐行對應**：`keep_numbering`（預設 true）保留 `1.` `2.` 這種行結構，適合清單、步驟、commit 式列表。

其餘的邊界（分批與單行 2,000 字元、輸出側上限與 `truncated`、不降級、429 怎麼做）只寫一處：
見 [`.agents/skills/index-translate/README.md`](../../.agents/skills/index-translate/README.md) 與同目錄的 `SKILL.md`。

## 想改它

`examples/mcp/server.mjs` 是母本。你裝到自己 client 的那一份是它的副本——**改母本，再重拷**，
不要兩份各改各的（那份漂移過一次，代價是「測的是舊檔」）。
