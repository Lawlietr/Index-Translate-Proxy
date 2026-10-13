# 把這個代理接給 agent：技能（SKILL.md）與 MCP

這裡放的是**給 agent 用的兩樣東西**：一份技能（`SKILL.md`——什麼時候該用翻譯服務、怎麼用、哪裡會錯），和它所依賴的 MCP server 的接法。
兩者都不屬於產品本身：放着給人照做，也放着給 agent 自己照做。

## 這裡有什麼

- `SKILL.md`：技能本體，採 [Agent Skills](https://agentskills.io/specification) 的形狀（一個目錄 + frontmatter）。pi 與支援 Agent Skills 的 client 會從工作目錄往上找到 `.agents/skills/`，所以 **clone 這個 repo 之後技能通常已經被發現**，不需要另外安裝。
- `README.md`：這份。它跟 `SKILL.md` 一樣是給 agent 讀的，**只有一份**。人讀的是「自己接的三條路」，agent 讀的是下一節那段提示詞。
- MCP server 的母本在同 repo 的 [`examples/mcp/`](../../../examples/mcp/README.md)：`server.mjs`、`mcp.json.example`（值留空）。

## 給 agent 的提示詞（直接貼給你自己的 agent）

這段只有一份，**也不翻譯**——提示詞翻譯它反而會漂移。

```text
You have a translation service available through this repo. Set it up, don't just read about it.

0. First check whether it is already wired up: search your tool list for a tool named "translate"
   (in pi: describeNamespace("mcp__index-translate") / searchTools("translate")). If the tools are
   there, skip to step 5.

1. Otherwise: read .agents/skills/index-translate/SKILL.md and examples/mcp/README.md.
2. Ask me for two values if you don't already have them: the base URL of MY OWN deployed instance,
   and its ITP_KEY. Prefer environment variables you can already see over asking.
3. Install the MCP server for THIS client (for pi: copy examples/mcp/server.mjs into
   ~/.pi/agent/mcp-servers/index-translate/, add an "index-translate" entry to
   ~/.pi/agent/mcp.json with env ITP_BASE/ITP_KEY, then reload). For other clients use the
   equivalent stdio server config. Do it in the client's own config location, not in this repo.
4. Secrets rule: never write ITP_KEY into source files, docs, commit messages, or any file git
   tracks. Put it in the client's config file or the environment. If a linter in this repo flags a
   key, that is intentional.
5. Verify before you trust it: run the server's handshake, then translate two numbered lines and
   check the line count came back as 2. If any step fails, say which step failed and stop; do not
   retry blindly.
6. Once it works: use its translate tool for prose (docs, comments, READMEs, commit messages),
   keep the numbered lines, and re-check the output yourself before landing it.
```

它會做什麼：先查（避免重複安裝）→ 要值 → 裝 → 守 key 的界 → 驗證 → 才真的用。
第 0 步和第 5 步是重點：**查不到工具就別假裝成功**，而且**沒有驗證過就不算接好**。

## 自己接：三條路

### 一、只要技能（已經有 MCP 的 agent）

技能就是這個目錄。pi 放個人層（跨專案可用）：

```bash
mkdir -p ~/.pi/agent/skills
cp -r .agents/skills/index-translate ~/.pi/agent/skills/
```

放專案層（只在這個 repo 裡可用）：把整個目錄放到專案的 `.agents/skills/` 之下——本 repo 已經在那裡了，clone 即用。

### 二、只要 MCP（不需要技能）

```bash
cd examples/mcp && npm install
cp mcp.json.example mcp.json      # 填 ITP_BASE / ITP_KEY（mcp.json 已被 .gitignore 抵掉）
ITP_BASE=https://<你的網址> ITP_KEY='<你的 ITP_KEY>' npm run handshake
```

客戶端設定怎麼寫見 [`examples/mcp/README.md`](../../../examples/mcp/README.md) 與 [`examples/mcp/mcp.json.example`](../../../examples/mcp/mcp.json.example)。

### 三、兩者都要（新 agent 從零接上）

照上面那段提示詞做，或按它的順序自己走一遍。pi 的兩步是：

```bash
mkdir -p ~/.pi/agent/mcp-servers/index-translate
cp examples/mcp/server.mjs ~/.pi/agent/mcp-servers/index-translate/server.mjs
cd ~/.pi/agent/mcp-servers/index-translate && npm install
```

再把 `examples/mcp/mcp.json.example` 的內容貼進 `~/.pi/agent/mcp.json` 的 `servers` 陣列，填值，重啟。

## 怎麼確認接上了

```bash
# 1. 交握：兩行 tools/list 就代表 server 與協定通了
cd examples/mcp && ITP_BASE=... ITP_KEY=... npm run handshake
```

然後在你的 client 裡叫一次 `index_translate_models`（它走代理本地，不消耗上游配額）與一次兩行短句的翻譯，
**行數要回來 2 行**。兩邊都過才算接好。更完整的線上探測見 [`examples/mcp/README.md`](../../../examples/mcp/README.md)
與 [`design/mcp-client.md`](../../../design/mcp-client.md)。

## 用之前要知道的邊界

- **要有自己部署的一份**：這個專案不提供共用實例或示範 key。`ITP_BASE` 是你自己部署的網址。
- **key 只放三處**：部署平台的 Secret、本地不被追蹤的設定檔（`~/.pi/agent/mcp.json`、`examples/mcp/mcp.json`）、client 的環境變數。repo 裡不出现明文，`npm run lint:secret` 會守。
- **超過長文要分批**：輸出側有上限（`max_tokens` 4096），到上限只從尾部截，但會明寫 `truncated` 與有幾塊被截——那是可偵測的，別假裝拿到完整譯文。
- **這個服務不降級、不重試別個模型**：指定的模型不可用就報錯，由你決定換不換。
- 翻譯結果要自己複核。它不懂專案的慣用詞；雙語文件落地前要跑專案自己的對等檢查（如 `npm run lint:readme`）。

## 在 repo 裡的分工

- 本目錄：技能本體 + 這份入口說明（人和 agent 都從這裡進），**兩個檔都只有繁中一份**。repo 根目錄的 README 只跳到這裡，不重複說明。
- `examples/mcp/`：MCP server 的碼與最小接法（不含邊界與坑的說明，那些只寫一處）。
- [`design/mcp-client.md`](../../../design/mcp-client.md)：實測證據與由來（含 25s 那道上限的前後對照、截尾偵測的兩條路）。
- 個人層安裝處（例如 `~/.pi/agent/skills/index-translate/`）是**複本**，母本在這裡。改這裡，別改複本。
