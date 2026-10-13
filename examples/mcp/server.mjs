#!/usr/bin/env node
// Index-Translate MCP — 把 Index-Translate-Proxy 以 MCP 工具提供給 agent，
// 讓 agent 能把翻譯工作分攤給那個服務，而不是自己逐字翻。
//
// 這一份是 **repo 母本**。裝到哪裡由你的 client 決定（pi 的位置是
// `~/.pi/agent/mcp-servers/index-translate/`）；改完兩邊要同步，或從這裡重新拷一份。
// 設計取捨、實測證據與已知邊界在 `../../design/mcp-client.md`。
//
// 機敏資訊（AGENTS 規則 17）：key 只從環境變數 `ITP_KEY` 讀，不在這個檔裡，也不進
// 任何會被 commit 的設定檔——範本是 `mcp.json.example`（值留空），真實那份已被
// .gitignore 抵掉。這個 repo 是公開可讀的。
//
// 邊界（對照 AGENTS.md 的規則）：
//   規則 3 強制串流、規則 4 行界切塊、規則 8 鑑權 —— 全部在**代理**那側做。
//
// 這裡向上游要 SSE（stream:true），理由不是風格，是躲開 Vercel 的 25s 壁壘：
//   非串流時代理要全部組包完才回，多塊串行一旦越過 25s 就被平台砍。
//   實測（同一份 40 行 / 2,990 字元輸入，2026-10-13）：
//     非串流 18.3s 成功一次、25.5s 失敗一次 → 504，body 是 "An error occurred with
//     your deployment"（Vercel 的錯誤頁，不是上游 openresty 的）
//     stream:true 17s → 200、40/40 行完整
//   即 AGENTS.md 規則 16 記的「25s 內開始回、可串流到 300s」。
//   副作用是這裡要自己 parse SSE；但它順帶給了我更完整的截尾偵測 —— 代理逐塊
//   透傳時**每一塊**的 finish_reason 都在流裡，而組包後的 top-level 只取最後一塊
//   （src/lib/stream.js:171），中間塊被截就看不見。規則 4 要的就是前者。
//   規則 9 的 max_tokens:4096 注入由代理負責，這裡刻意不帶 max_tokens。
//
// 一個必須带的東西：翻譯指令放進 system。AGENTS.md 事實表「行對應」列寫明——
// 只送編號句而不帶指令時，上游會加前言、把每句展開成多語言列表，行對應就破掉。
// 所以本 server 一律帶 system 指令，不讓上游自己決定輸出形狀。

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const BASE = (process.env.ITP_BASE || "https://index-translate-proxy.vercel.app").replace(/\/+$/, "")
const KEY = process.env.ITP_KEY || ""
const FORCED_MODEL = process.env.ITP_MODEL || ""
const UA = "Index-Translate-MCP/0.1 (+https://github.com/Lawlietr/Index-Translate-Proxy)"

// 放行清單的**權威來源是代理的 src/lib/model.js**（規則 1：清單只有一份）。
// 這裡刻意不鏡像那份常數，改成向 GET /v1/models 取：那份清單由代理自己回、
// 不燒上游配額，而鏡像常數會在上游撤回模型時漂移（`index-homura-*` 有先例）。
const MODELS_TTL_MS = 10 * 60 * 1000
let modelsCache = { at: 0, ids: null }

/** stdio 的 stdout 是協議通道，除錯一律走 stderr。 */
function log(msg) {
  process.stderr.write(`[index-translate] ${msg}\n`)
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "user-agent": UA }
  if (KEY) headers["authorization"] = `Bearer ${KEY}`
  if (body) headers["content-type"] = "application/json"

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 上游/代理偶爾回非 JSON（例如 412 的 HTML），text 照原樣用 */
  }
  return {
    status: res.status,
    text,
    json,
    retryAfter: res.headers.get("retry-after"),
  }
}

/** SSE 逐個 yield 出 data: 後面的字串（跨 chunk 邊界要自己緩，否則會漏帧）。 */
async function* sseEvents(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue
        const d = line.slice(5).trim()
        if (d) yield d
      }
    }
  }
  const tail = (buf + dec.decode()).trim()
  if (tail.startsWith("data:")) yield tail.slice(5).trim()
}

/**
 * 翻譯請求走 SSE。理由見檔頭。
 * 代理自己也會補 stream_options.include_usage（規則 9 第三項），這裡照帶是為了
 * 確定拿得到用量：上游串流預設不給 usage。
 */
async function chatRequest(body) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "text/event-stream",
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(180_000),
  })
  const ct = res.headers.get("content-type") || ""
  if (res.status !== 200 || !ct.includes("text/event-stream")) {
    // 第一塊就失敗時根本沒開始串流，代理走普通 JSON 錯誤（規則 6：不改 status、不改 body）。
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON（例如 412 的 HTML）照原樣用 text */
    }
    return { status: res.status, text, json, retryAfter: res.headers.get("retry-after") }
  }

  let content = ""
  const finishReasons = []
  let streamError = null
  const usage = { prompt_tokens: 0, completion_tokens: 0, seen: false }
  for await (const data of sseEvents(res)) {
    if (data === "[DONE]") break
    let obj
    try {
      obj = JSON.parse(data)
    } catch {
      continue
    }
    // 串流已經開始就改不了 status，中途失敗只能進流（src/lib/stream.js:66–72）。
    if (obj.error) {
      streamError = obj.error
      continue
    }
    const delta = obj.choices?.[0]?.delta?.content
    if (typeof delta === "string") content += delta
    const fr = obj.choices?.[0]?.finish_reason
    if (fr) finishReasons.push(fr)
    if (obj.usage) {
      usage.seen = true
      usage.prompt_tokens += obj.usage.prompt_tokens || 0
      usage.completion_tokens += obj.usage.completion_tokens || 0
    }
  }
  return {
    status: 200,
    content,
    finishReasons,
    streamError,
    usage,
    chunks: Number(res.headers.get("x-proxy-chunks")) || 1,
  }
}

/** 取代理的放行清單；成功才快取，失敗時下一次重試。 */
async function allowedModels(force = false) {
  if (!force && modelsCache.ids && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.ids
  const r = await api("/v1/models")
  if (r.status !== 200 || !Array.isArray(r.json?.data)) {
    throw new Error(`讀放行清單失敗（HTTP ${r.status}）：${r.text.slice(0, 200)}`)
  }
  modelsCache = { at: Date.now(), ids: r.json.data.map((m) => m.id) }
  return modelsCache.ids
}

/** 翻譯指令：行對應要靠這段才成立，所以把規則寫死。 */
function buildSystem(to, from, keepNumbering) {
  const src = from ? `The source language is ${from}; do not translate into it.` : "Detect the source language yourself."
  const numbering = keepNumbering
    ? 'If the input contains numbered lines (like "1. foo"), output exactly one translated line per input line, keep every line number and the line order. Never merge lines, never drop a number, never renumber, never add a preamble.'
    : "Preserve the input's line breaks and structure."
  return (
    `You are a professional human-quality translator. Translate the user's text into ${to}. ` +
    `${src} ${numbering} ` +
    "Output only the translation. No commentary, no notes, no alternative versions, no explanations."
  )
}

/** 把 HTTP 狀態轉成 agent 讀得懂的下一步。代理的 400 訊息本身已含可用清單，原樣轉出。 */
function explainFailure(r, model) {
  const detail = r.json?.error?.message || r.json?.detail || r.text.slice(0, 500)
  if (r.status === 401) return `鑑權失敗（401）：ITP_KEY 與那份部署的 ITP_KEY 不同。detail: ${detail}`
  if (r.status === 503) return `那份部署沒有設 ITP_KEY（503）：${detail}`
  if (r.status === 429) {
    const wait = r.retryAfter || "?"
    return `限流（429）：等 ${wait}s 再試。上游按出口 IP 限 60,000 tokens/min；把單次輸入切短、或一次少幾行較有效。detail: ${detail}`
  }
  if (r.status === 413) return `輸入超過單行上限（413）：${detail}`
  if (r.status === 400 && /模型/.test(detail)) return `模型 ${model} 不可用：${detail}`
  if (r.status === 504) {
    // 兩種 504 的成因與對應不同，body 分得出來（實測兩者都遇過）：
    //   - Vercel 的錯誤頁 = 那份 Edge 函式被平台砍（25s 內要開始回），對應是分批。
    //   - openresty 的 504 = 上游本身不可用，分批沒用，等一會兒再試。
    if (/an error occurred with your deployment/i.test(r.text || "")) {
      return `Vercel 那側的 504，不是上游也不是模型問題：那份 Edge 部署被平台砍掉（限制是 25s 內要開始回）。把輸入分批、每次少幾行再試。`
    }
    // 上游對超過 10.0s 的請求回 504（openresty）。但 504 也可能代表上游整體不可用，
    // 此時「縮短輸入」是錯的建議。用 index_translate_models 分辨：它走代理本地、不經上游。
    return `上游 504（未重試、未換模型）。先呼叫 index_translate_models 判斷是哪一側：那個工具成功 = 代理正常、上游 Index-Translate 不可用（等一會兒再試，或改用其他翻譯方式）；它也失敗 = 代理這一跳有問題。${detail.slice(0, 120)}`
  }
  if (r.status >= 500) return `上游/代理錯誤（${r.status}，未重試、未換模型）：${detail}`
  return `HTTP ${r.status}：${detail}`
}

const TOOLS = [
  {
    name: "translate",
    description:
      "把文字交給 Index-Translate 翻譯（bilibili 的開源翻譯模型，經 Index-Translate-Proxy）。" +
      "要翻譯文件、程式註解、README、大段文字時優先用它，不要自己逐字翻。" +
      "含編號的行（1. / 2. …）會逐行對應、保留編號，適合清單與 commit 式列表。" +
      "超長輸入由代理在行界自動切塊再接回，一次傳整段即可；但**單行**不得超過 2000 字元。" +
      "一次上限約 2500 字元後會切塊，輸出若被截尾會明確標示 truncated，那時要分批。" +
      "不做靜默降級：指定的模型不可用就報錯，不會偷偷換別個模型。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要翻譯的原文。可含多行。" },
        to: {
          type: "string",
          description: '目標語言，用明確名稱，例："繁體中文（Traditional Chinese）"、"English (US)"、"日本語"',
        },
        from: { type: "string", description: "來源語言（選填，例：\"English\"）。省略時由模型自行判斷。" },
        model: {
          type: "string",
          description:
            "模型。省略則用清單第一位（主模型，品質最穩）。" +
            "index-mt-9b / index-mt-2b 快約 2 倍、行對應已驗證，但翻譯品質未評量 —— 只有在明確要速度、" +
            "或內容是短句/清單時用。",
        },
        keep_numbering: {
          type: "boolean",
          description: "保留編號行逐行對應（預設 true）。純散文、不想保留行結構時設 false。",
        },
      },
      required: ["text", "to"],
    },
  },
  {
    name: "index_translate_models",
    description:
      "列出這個翻譯服務目前放行的模型與取捨。讀的是代理自己的清單，不消耗上游配額。" +
      "translate 報「模型不可用」時用它確認現在能用哪些。",
    inputSchema: { type: "object", properties: {} },
  },
]

const HANDLERS = {
  translate: async (args) => {
    const text = String(args.text ?? "").trim()
    const to = String(args.to ?? "").trim()
    if (!text) return { content: [{ type: "text", text: "text 是必填。" }], isError: true }
    if (!to) return { content: [{ type: "text", text: "to 是必填（目標語言）。" }], isError: true }

    const ids = await allowedModels()
    const model = String(args.model || FORCED_MODEL || ids[0])
    if (!KEY) return { content: [{ type: "text", text: "沒有 ITP_KEY 環境變數，這個 server 無法鑑權。" }], isError: true }

    log(`translate → ${model} (${text.length} chars → ${to})`)
    const r = await chatRequest({
      model,
      messages: [
        { role: "system", content: buildSystem(to, args.from, args.keep_numbering !== false) },
        { role: "user", content: text },
      ],
    })

    if (r.status !== 200) return { content: [{ type: "text", text: explainFailure(r, model) }], isError: true }

    // 規則 4：第一塊之後失敗改不了 status，只能在流裡放 error 框架。已送出的部分不補償，
    // 所以把它當「半成品」明確交還 agent，不假裝翻完了。
    if (r.streamError) {
      return {
        content: [
          {
            type: "text",
            text: `翻譯中途失敗（未重試、不補償）：${r.streamError.message}\n\n已收到的部分（不完整，不要直接用）：\n\n${r.content}`,
          },
        ],
        isError: true,
      }
    }
    const out = String(r.content || "").trim()
    if (!out) return { content: [{ type: "text", text: "回應沒有內容（HTTP 200，但沒有 delta.content）。" }], isError: true }

    // 規則 4：finish_reason === "length" 是被截尾的訊號。流裡看到的是**每一塊**，
    // 所以中間塊被截也能發現（代理組包的 top-level 只取最後一塊，會漏）。被截就不是正常完成。
    const cut = r.finishReasons.filter((f) => f === "length").length
    const notes = [`模型 ${model}`]
    if (cut) {
      notes.push(`⚠️ truncated：有 ${cut} 塊用完輸出上限被截，那幾段的最後幾行不見 —— 請分批、每次少幾行`)
    } else {
      notes.push(r.chunks > 1 ? `完整（代理切了 ${r.chunks} 塊再接回）` : "完整")
    }
    if (r.usage.seen) notes.push(`tokens ${r.usage.prompt_tokens}/${r.usage.completion_tokens}`)
    return { content: [{ type: "text", text: `翻譯結果（${notes.join("｜")}）：\n\n${out}` }] }
  },

  index_translate_models: async () => {
    const ids = await allowedModels(true)
    const why = {
      "index-mt-9b": "快約 2 倍；行對應已驗證（8/8）；翻譯品質未評量",
      "index-mt-2b": "最快；行對應已驗證（8/8）；翻譯品質未評量",
    }
    const lines = ids.map((id, i) => `- ${id}${i === 0 ? "（預設，唯一由上游 /v1/models 宣告）" : ""}${why[id] ? ` —— ${why[id]}` : ""}`)
    return {
      content: [
        {
          type: "text",
          text:
            `目前放行的模型（代理清單為權威，順序＝建議順序）：\n${lines.join("\n")}\n\n` +
            "不放行：index-mt-9b-syllable（會漏行）、index-mt-2b-syllable（會丟編號）。\n" +
            "注意：上游回顯的 model 欄位不可信（9b 會回 qwen35-9b-… 這類內部部署名），不能拿去驗證跑的是哪個模型。" +
            "上游可能撤回模型名稱（index-homura-* 有先例），所以這份清單要當即時狀態看。",
        },
      ],
    }
  },
}

const server = new Server(
  { name: "index-translate", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const handler = HANDLERS[name]
  if (!handler) return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true }
  try {
    return await handler(req.params.arguments ?? {})
  } catch (err) {
    log(`${name} 失敗：${err?.message}`)
    return {
      content: [{ type: "text", text: `呼叫失敗：${err?.message}\n（base=${BASE}，key ${KEY ? "已設" : "未設"}）` }],
      isError: true,
    }
  }
})

await server.connect(new StdioServerTransport())
log(`stdio 就緒：base=${BASE}，key=${KEY ? "已設" : "未設"}`)
