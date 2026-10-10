// 冒煙測試（不是待做 5 的正式測試）：用假 upstream 跑過 worker 每條主要路徑。
// 跑法：node scripts/smoke-local.mjs
import worker from "../src/worker.js"
import { ALLOWED_MODEL } from "../src/lib/model.js"
import { PROXY_UA } from "../src/lib/headers.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch

let calls = []
function sseFrames(frames) {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"
}
function chunkFrame(id, model, content, finish = null) {
  return {
    id, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: { content }, logprobs: null, finish_reason: finish }],
  }
}

/** echo upstream：把每塊 content 前綴 T: 原樣吐回。 */
async function echoFetch(url, init) {
  const body = init?.body ? JSON.parse(init.body) : null
  calls.push({ url, body, headers: init?.headers })
  await sleep(5)
  const text = (body?.messages || []).map((m) => m.content).join("|")
  return new Response(sseFrames([
    chunkFrame("chatcmpl-1", body?.model || ALLOWED_MODEL, "T:" + text),
    chunkFrame("chatcmpl-1", body?.model || ALLOWED_MODEL, "", "stop"),
    { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: body?.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]), { status: 200, headers: { "content-type": "text/event-stream" } })
}

const req = (path, opts = {}) => new Request("https://proxy.example" + path, opts)
// ITP_KEY 是必須的（design/auth.md 定案 1），所以預設就帶 key；只有刻意要驗 401 的那幾條會覆蓋掉它。
const KEY_HDR = { authorization: "Bearer secret" }
const post = (body, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...KEY_HDR, ...headers },
  body: JSON.stringify(body),
})
const chatBody = (content, extra = {}) => ({ model: ALLOWED_MODEL, messages: [{ role: "user", content }], ...extra })
const lines = (n, w = 30) => Array.from({ length: n }, (_, i) => `${i + 1}. ${"x".repeat(w)}`).join("\n")

let pass = 0
let fail = 0
const check = (name, cond, info = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${info ?? ""}`) }
}
const textDelta = (line) => {
  try { return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "" } catch { return "" }
}

async function main() {
  globalThis.fetch = echoFetch
  // ITP_KEY 是必須的（design/auth.md 定案 1）：沒設定時 worker 一律 503，
  // 所以下面每個會進上游的呼叫都帶上它；只有刻意要驗 401／未設定的段落不用。
  const K = { ITP_KEY: "secret" }

  console.log("1) OPTIONS 預檢")
  const o = await worker.fetch(req("/v1/chat/completions", { method: "OPTIONS" }), {})
  check("204 + allow-headers 含 authorization", o.status === 204 && (o.headers.get("access-control-allow-headers") || "").includes("authorization"), o.status)

  console.log("2) 根路徑")
  const root = await worker.fetch(req("/"), {})
  check("200 text/plain + x-proxy-auth: missing", root.status === 200 && root.headers.get("x-proxy-auth") === "missing" && (await root.text()).includes(ALLOWED_MODEL))
  const rootCfg = await worker.fetch(req("/"), { ITP_KEY: "abc" })
  check("設了 key → x-proxy-auth: configured", rootCfg.headers.get("x-proxy-auth") === "configured" && (await rootCfg.text()).includes("已啟用"))

  console.log("3) 路徑（規則 5）")
  for (const p of ["/foo", "/v1", "/v1/chat", "/completions"]) {
    const r = await worker.fetch(req(p, post({ model: "x" })), {})
    check(`本地 404：${p}`, r.status === 404 && (await r.json()).error.message.includes("本代理沒有這個路徑"), r.status)
  }
  calls = []
  await worker.fetch(req("/v1/models", { headers: KEY_HDR }), K)
  check("GET /v1/models 透傳到上游", calls[0]?.url === "https://index-translate.bilibili.com/v1/models", calls[0]?.url)
  calls = []
  await worker.fetch(req("/api/chat/completions", post(chatBody("hi"))), K)
  check("/api/chat/completions → 上游 /v1/chat/completions", calls[0]?.url === "https://index-translate.bilibili.com/v1/chat/completions", calls[0]?.url)

  console.log("4) 鑑權（規則 8）")
  const noKey = await worker.fetch(req("/v1/chat/completions", post(chatBody("你好"), { authorization: "" })), { ITP_KEY: "secret" })
  check("缺 key → 401", noKey.status === 401 && (await noKey.json()).error.code === 401, noKey.status)
  const badKey = await worker.fetch(req("/v1/chat/completions", post(chatBody("你好"), { authorization: "Bearer nope" })), { ITP_KEY: "secret" })
  check("錯 key → 401", badKey.status === 401, badKey.status)
  const goodKey = await worker.fetch(req("/v1/chat/completions", post(chatBody("你好"), { authorization: "Bearer secret" })), { ITP_KEY: "secret" })
  const gj = await goodKey.json()
  check("對 key（含 Bearer 前綴）→ 200", goodKey.status === 200 && gj.choices[0].message.content === "T:你好", gj?.error?.message)

  console.log("5) 模型閘（規則 1）")
  calls = []
  const badModel = await worker.fetch(req("/v1/chat/completions", post(chatBody("hi", { model: "gpt-4o-mini" }))), K)
  const bm = await badModel.json()
  check("非白名單模型 → 本地 400", badModel.status === 400 && bm.error.message.includes(ALLOWED_MODEL), bm?.error?.message)
  check("不消耗上游配額", calls.length === 0)

  console.log("6) 協定層注入（規則 9）")
  calls = []
  await worker.fetch(req("/v1/chat/completions", post(chatBody("hi"))), K)
  const sent = calls[0].body
  check("強制 stream:true", sent.stream === true)
  check("stream_options.include_usage", sent.stream_options?.include_usage === true)
  check("chat_template_kwargs.enable_thinking:false", sent.chat_template_kwargs?.enable_thinking === false)
  check("max_tokens 預設 4096", sent.max_tokens === 4096, sent.max_tokens)
  check("只帶 UA 與 content-type", Object.keys(calls[0].headers).sort().join(",") === "content-type,user-agent", JSON.stringify(calls[0].headers))
  check("UA 是自報家門的（不假裝瀏覽器，也不是機器人黑名單）", calls[0].headers["user-agent"] === PROXY_UA, calls[0].headers["user-agent"])
  calls = []
  await worker.fetch(req("/v1/chat/completions", post(chatBody("hi", { max_tokens: 300 }))), K)
  check("客戶帶 max_tokens 就不覆蓋", calls[0].body.max_tokens === 300)
  check("多送的欄位原樣帶上", calls[0].body.model === ALLOWED_MODEL)

  console.log("7) 切塊 ＋ 非串流組包（規則 3、4）")
  // MAX_INPUT_CHARS 明確調小：預設 2,500 是線上的保守邊界，拿來跑測試會要幾十塊。
  const SPLIT = { ITP_KEY: "secret", MAX_INPUT_CHARS: "600" }
  calls = []
  const input = lines(60)
  const long = await worker.fetch(req("/v1/chat/completions", post(chatBody(input, { stream: false }))), SPLIT)
  const lj = await long.json()
  const n = calls.length
  check(`切成多塊（60 行 → ${n} 塊）`, n > 1)
  const chunkTexts = calls.map((c) => c.body.messages.at(-1).content)
  check("每塊都在行界（不切行內）", chunkTexts.every((t) => !t.startsWith("\n") && !t.endsWith("\n") && !t.includes("\n\n")))
  check("塊內容拼回 = 原文", chunkTexts.join("\n") === input, `${chunkTexts.join("\n").length} vs ${input.length}`)
  const expected = chunkTexts.map((t) => "T:" + t).join("\n")
  check("譯文按原分隔接回（無黏行）", lj.choices[0].message.content === expected, JSON.stringify(lj.choices[0].message.content.slice(0, 80)))
  check("行數不減", lj.choices[0].message.content.split("\n").length === 60, String(lj.choices[0].message.content.split("\n").length))
  check("usage 加總", lj.usage?.total_tokens === 15 * n, JSON.stringify(lj.usage))
  check("x-proxy-upstream-stream: forced", long.headers.get("x-proxy-upstream-stream") === "forced")
  check(`x-proxy-chunks = ${n}`, Number(long.headers.get("x-proxy-chunks")) === n, long.headers.get("x-proxy-chunks"))
  check("id / model 保留", lj.id === "chatcmpl-1" && lj.model === ALLOWED_MODEL)
  check("finish_reason 取 stop", lj.choices[0].finish_reason === "stop")
  check("object 是 chat.completion", lj.object === "chat.completion")

  console.log("8) finish_reason: length → 標頭（design §1）")
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    return new Response(sseFrames([
      chunkFrame("c2", body.model, body.messages.at(-1).content),
      chunkFrame("c2", body.model, "", "length"),
    ]), { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  const t2 = await worker.fetch(req("/v1/chat/completions", post(chatBody(lines(60), { stream: false }))), SPLIT)
  check("x-proxy-chunk-truncated", /^\d+$/.test(t2.headers.get("x-proxy-chunk-truncated") || ""), t2.headers.get("x-proxy-chunk-truncated"))
  const t3 = await worker.fetch(req("/v1/chat/completions", post(chatBody(lines(60), { stream: false, max_tokens: 100 }))), SPLIT)
  check("客戶自己帶 max_tokens 時不報 truncated", t3.headers.get("x-proxy-chunk-truncated") === null, t3.headers.get("x-proxy-chunk-truncated"))

  console.log("9) 串流客戶端")
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    // 上游會整塊回傳、保留換行（2026-10-10 實測）→ 假上游照這個形狀，不自己造行。
    const frames = [chunkFrame("c3", body.model, body.messages.at(-1).content.split("\n").map((l) => ">" + l).join("\n"))]
    return new Response(sseFrames(frames), { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  const input9 = lines(40)
  const st = await worker.fetch(req("/v1/chat/completions", post(chatBody(input9, { stream: true }))), SPLIT)
  check("SSE content-type", (st.headers.get("content-type") || "").includes("text/event-stream"))
  const raw = await st.text()
  const dataLines = raw.split("\n").filter((l) => l.startsWith("data:"))
  const joined = dataLines.filter((l) => !l.includes("[DONE]")).map(textDelta).join("")
  // 行對應是插件的協定：還原出來的每一行必須與原文一一對應，不能黏行、不能少行。
  const expected9 = input9.split("\n").map((l) => ">" + l)
  check("串流逐行還原（無黏行、無缺行）", joined.split("\n").join("\n") === expected9.join("\n"),
    `${joined.split("\n").length} 行 vs ${expected9.length} 行`)
  check("[DONE] 只出現一次", dataLines.filter((l) => l.includes("[DONE]")).length === 1)
  check("確實切成多塊（否則分隔的檢查沒有意義）", st.headers.get("x-proxy-chunks") !== null, st.headers.get("x-proxy-chunks"))

  console.log("10) 並發閘（規則 7）")
  globalThis.fetch = async () => { await sleep(80); return new Response(sseFrames([chunkFrame("x", ALLOWED_MODEL, "ok", "stop")]), { status: 200 }) }
  const NO_WAIT = { ITP_KEY: "secret", MAX_INFLIGHT: "1", SLOT_WAIT_MS: "0" }
  const a = worker.fetch(req("/v1/chat/completions", post(chatBody("hello"))), NO_WAIT)
  await sleep(10)
  const b = await worker.fetch(req("/v1/chat/completions", post(chatBody("hello"))), NO_WAIT)
  check("閘滿且不排隊 → 429", b.status === 429, b.status)
  check("Retry-After: 2", b.headers.get("retry-after") === "2")
  check("message 說明原因", (await b.json()).error.message.includes("並發上限已滿"))
  check("第一個請求不受影響", (await a).status === 200)
  const c = await worker.fetch(req("/v1/chat/completions", post(chatBody("hello"))), NO_WAIT)
  check("釋放後可再用", c.status === 200, c.status)
  // design §2：允許排隊時不該回 429，要等得到 slot
  const WAIT = { ITP_KEY: "secret", MAX_INFLIGHT: "1", SLOT_WAIT_MS: "5000" }
  const d = worker.fetch(req("/v1/chat/completions", post(chatBody("hello"))), WAIT)
  await sleep(10)
  const e = await worker.fetch(req("/v1/chat/completions", post(chatBody("hello"))), WAIT)
  check("允許排隊時：第二個等到 slot，不是 429", e.status === 200, e.status)
  check("排隊不會弄壞第一個", (await d).status === 200)

  console.log("11) 上游錯誤透傳（規則 6）")
  globalThis.fetch = async () => new Response("<html>412</html>", { status: 412, headers: { "content-type": "text/html", "retry-after": "5" } })
  const err = await worker.fetch(req("/v1/chat/completions", post(chatBody("hi"))), K)
  check("status 不變（412 不改寫成 500）", err.status === 412)
  check("body 原樣", (await err.text()).includes("<html>412</html>"))
  check("hint 放標頭", (err.headers.get("x-proxy-hint") || "").includes("UA"), err.headers.get("x-proxy-hint"))
  check("retry-after 透傳", err.headers.get("retry-after") === "5")

  console.log("12) <think> 剝離（規則 9 的防御處理）")
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    return new Response(sseFrames([
      chunkFrame("c4", body.model, "<think>"),
      chunkFrame("c4", body.model, "1. 思考中"),
      chunkFrame("c4", body.model, "</think>1. 你好"),
      chunkFrame("c4", body.model, "", "stop"),
    ]), { status: 200 })
  }
  const th = await worker.fetch(req("/v1/chat/completions", post(chatBody("你好", { stream: false }))), K)
  const thj = await th.json()
  check("非串流：思考內容被丟掉", thj.choices[0].message.content === "1. 你好", JSON.stringify(thj.choices[0].message.content))

  globalThis.fetch = realFetch
  console.log(`\n${pass} ok / ${fail} fail`)
  if (fail) process.exitCode = 1
}

main().catch((e) => { console.error("smoke crashed:", e); process.exitCode = 2 })
