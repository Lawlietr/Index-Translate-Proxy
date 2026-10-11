// 端到端（離線）：打真的 worker 模組，注入假的 fetch。覆蓋 AGENTS.md 規則 1–9。
// 跑法：npm test
import { test, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import worker from "../src/worker.js"
import { ALLOWED_MODEL, ALLOWED_MODELS } from "../src/lib/model.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch

let calls = []
let upstream = null // 每個測試換的假上游：(url, init) => Response

globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null
  calls.push({ url, method: init?.method, headers: init?.headers, body })
  if (!upstream) throw new Error("test forgot to set upstream()")
  return upstream(url, init)
}

beforeEach(() => {
  calls = []
  upstream = null
})

function chunkFrame(id, model, content, finish = null) {
  return {
    id, object: "chat.completion.chunk", created: 100, model,
    choices: [{ index: 0, delta: { content }, logprobs: null, finish_reason: finish }],
  }
}
const sseBody = (frames, withDone = true) =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + (withDone ? "data: [DONE]\n\n" : "")

/** echo 上游：把該塊 content 前綴 T: 原樣吐回（含 usage）。 */
function echoUpstream({ finish = "stop", sleepMs = 0, status = 200 } = {}) {
  upstream = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.at(-1).body = body
    if (sleepMs) await sleep(sleepMs)
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "上游說不" } }), { status, headers: { "content-type": "application/json" } })
    const text = body.messages.map((m) => m.content).join("|")
    return new Response(sseBody([
      chunkFrame("chatcmpl-1", body.model, "T:" + text),
      chunkFrame("chatcmpl-1", body.model, "", finish),
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 100, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]), { status: 200, headers: { "content-type": "text/event-stream" } })
  }
}

const ENV = { ITP_KEY: "test-key" }
const AUTH = { authorization: "Bearer test-key" }
const req = (path, opts = {}) => new Request("https://proxy.example" + path, opts)
const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify(body) })
const chatBody = (content, extra = {}) => ({ model: ALLOWED_MODEL, messages: [{ role: "user", content }], ...extra })
const lines = (n, w = 30) => Array.from({ length: n }, (_, i) => `${i + 1}. ${"x".repeat(w)}`).join("\n")
const call = (path, opts = {}, env = ENV) => worker.fetch(req(path, opts), env)
const deltas = (raw) =>
  raw.split("\n").filter((l) => l.startsWith("data:")).filter((l) => !l.includes("[DONE]"))
    .map((l) => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "" } catch { return "" } }).join("")

test("規則 2／8：向上游只帶 UA 與 content-type；UA 是本代理自報的，客戶端 UA 不轉發", async () => {
  echoUpstream()
  await worker.fetch(new Request("https://proxy.example/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, "user-agent": "python-requests/2.31", cookie: "a=b", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(chatBody("hi")),
  }), ENV)
  const h = calls[0].headers
  assert.deepEqual(Object.keys(h).sort(), ["content-type", "user-agent"])
  assert.match(h["user-agent"], /^Index-Translate-Proxy\//)
  assert.ok(!String(h["user-agent"]).includes("python-requests"))
})

test("規則 8／定案：key 用 ITP_KEY；缺 key、錯 key 都 401，且不消耗上游配額", async () => {
  echoUpstream()
  const missing = await call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody("你好")) })
  assert.equal(missing.status, 401)
  assert.equal((await missing.json()).error.code, 401)
  const bad = await call("/v1/chat/completions", post(chatBody("你好"), { authorization: "Bearer wrong" }))
  assert.equal(bad.status, 401)
  assert.equal(calls.length, 0, "401 不該打上游")
})

test("ITP_KEY 兩邊都 trim：貼進環境變數時多出的空白/換行不該一直 401", async () => {
  echoUpstream()
  const padded = { ...ENV, ITP_KEY: "  test-key\n" } // 部署端多空白
  const r = await worker.fetch(req("/v1/chat/completions", post(chatBody("你好"), AUTH)), padded)
  assert.equal(r.status, 200, "客戶端帶的是 test-key，比對要能過")
  // 反向：客戶端多空白（某些插件會這樣帶）也要能過
  const r2 = await call("/v1/chat/completions", post(chatBody("你好"), { authorization: "Bearer   test-key  " }), ENV)
  assert.equal(r2.status, 200)
  // 只有空白＝沒設
  const blank = await worker.fetch(req("/v1/chat/completions", post(chatBody("hi"), AUTH)), { ...ENV, ITP_KEY: "   " })
  assert.equal(blank.status, 503, "全空白視為未設定")
})

test("未設 ITP_KEY → 503（不是變公開），而且根路徑看得見原因", async () => {
  echoUpstream()
  const r = await worker.fetch(req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody("hi")) }), {})
  assert.equal(r.status, 503)
  assert.match((await r.json()).error.message, /未設定 ITP_KEY/)
  const root = await worker.fetch(req("/"), {})
  assert.equal(root.headers.get("x-proxy-auth"), "missing")
})

test("根路徑：GET 回一行設定說明；設了 key 就標明已啟用", async () => {
  const off = await worker.fetch(req("/"), {})
  assert.equal(off.status, 200)
  assert.match(off.headers.get("content-type"), /text\/plain/)
  assert.equal(off.headers.get("x-proxy-auth"), "missing")
  assert.match(await off.text(), /請填 https:\/\/proxy\.example\/v1/)
  const on = await worker.fetch(req("/"), ENV)
  assert.equal(on.headers.get("x-proxy-auth"), "configured")
  assert.match(await on.text(), /已啟用/)
})

test("規則 5：/v1、/api 兩種寫法都到同一個上游路徑；未帶 /v1 絕不補成 /v1/v1", async () => {
  echoUpstream()
  for (const [path, expect] of [
    ["/v1/chat/completions", "/v1/chat/completions"],
    ["/api/chat/completions", "/v1/chat/completions"],
    ["/chat/completions", "/v1/chat/completions"],
  ]) {
    const r = await call(path, post(chatBody("hi")))
    assert.equal(r.status, 200, path)
    assert.equal(calls.at(-1).url, "https://index-translate.bilibili.com" + expect, path)
  }
  const dbl = await call("/v1/v1/chat/completions", post(chatBody("hi")))
  assert.equal(dbl.status, 404)
  assert.equal(calls.length, 3, "404 不該打上游")
})

test("規則 5：白名單外路徑一律本地 404（/v1/completions 上游不存在）", async () => {
  echoUpstream()
  for (const p of ["/foo", "/v1", "/v1/completions", "/completions", "/v1/embeddings"]) {
    const r = await call(p, post({ model: ALLOWED_MODEL }))
    assert.equal(r.status, 404, p)
    assert.match((await r.json()).error.message, /本代理沒有這個路徑/)
  }
  assert.equal(calls.length, 0)
})

test("/v1/models 由本代理自己回放行清單（不花上游配額）", async () => {
  upstream = async () => new Response("{}", { status: 200 })
  const r = await worker.fetch(req("/v1/models", { headers: { ...AUTH } }), ENV)
  assert.equal(r.status, 200)
  const ids = await r.json().then((j) => j.data.map((d) => d.id))
  assert.deepEqual(ids, ALLOWED_MODELS)
  assert.equal(calls.length, 0, "模型清單不透傳上游")
  const post_ = await worker.fetch(req("/v1/models", { method: "POST", headers: { ...AUTH } }), ENV)
  assert.equal(post_.status, 405)
})

test("未鑑權時 /v1/models 也要先 401（鑑權在任何回應之前）", async () => {
  const r = await worker.fetch(req("/v1/models"), ENV)
  assert.equal(r.status, 401)
})

test("規則 1：放行清單上的名字都通，body.model 原樣帶到上游與回包", async () => {
  echoUpstream()
  for (const m of ALLOWED_MODELS) {
    const r = await call("/v1/chat/completions", post(chatBody("hi", { model: m })))
    assert.equal(r.status, 200, m)
    assert.equal(calls.at(-1).body.model, m, m)
    assert.equal(await r.json().then((j) => j.model), m, m)
  }
})

test("規則 1：其他模型本地 400；-syllable 额外說明為什麼不放行", async () => {
  echoUpstream()
  for (const m of ["gpt-4o-mini", "Index-Translate-18B", "index-en-to-zh", ""]) {
    const r = await call("/v1/chat/completions", post(chatBody("hi", { model: m })))
    assert.equal(r.status, 400, m)
    const j = await r.json()
    assert.match(j.error.message, new RegExp(`放行的模型：${ALLOWED_MODELS.join("、")}`))
    assert.match(j.error.message, /不做靜默降級/)
    assert.equal(j.error.param, "model")
  }
  for (const m of ["index-mt-9b-syllable", "index-mt-2b-syllable"]) {
    const r = await call("/v1/chat/completions", post(chatBody("hi", { model: m })))
    assert.equal(r.status, 400, m)
    const j = await r.json()
    assert.match(j.error.message, /我們測過/, m)
  }
  assert.equal(calls.length, 0, "模型閘不消耗上游配額")
})


test("規則 3／9：一律向上游要串流，並只做四項協定層注入", async () => {
  echoUpstream()
  await call("/v1/chat/completions", post(chatBody("hi", { stream: false, temperature: 0.1 })))
  const b = calls[0].body
  assert.equal(b.stream, true)
  assert.equal(b.stream_options.include_usage, true)
  assert.equal(b.chat_template_kwargs.enable_thinking, false)
  assert.equal(b.max_tokens, 4096, "未帶 max_tokens 時補 4096")
  assert.equal(b.temperature, 0.1, "其他欄位原樣")
  const r = await call("/v1/chat/completions", post(chatBody("hi")))
  assert.equal(r.headers.get("x-proxy-upstream-stream"), "forced")
})

test("客戶帶 max_tokens 就聽客戶的（不覆蓋）", async () => {
  echoUpstream()
  await call("/v1/chat/completions", post(chatBody("hi", { max_tokens: 300 })))
  assert.equal(calls[0].body.max_tokens, 300)
})

test("規則 4／3：超長輸入按行切塊、依原分隔接回；非串流客戶得到單一 completion", async () => {
  echoUpstream()
  const input = lines(60, 40)
  const r = await call("/v1/chat/completions", post(chatBody(input, { stream: false })))
  assert.ok(calls.length > 1, "應該切多塊")
  const texts = calls.map((c) => c.body.messages.at(-1).content)
  assert.equal(texts.join("\n"), input, "每塊都在行界，拼回無損")
  const j = await r.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.choices[0].message.content, texts.map((t) => "T:" + t).join("\n"))
  assert.equal(j.choices[0].message.content.split("\n").length, 60)
  assert.equal(j.choices[0].finish_reason, "stop")
  assert.equal(j.usage.total_tokens, 15 * calls.length)
  assert.equal(Number(r.headers.get("x-proxy-chunks")), calls.length)
  assert.equal(r.headers.get("x-proxy-chunk-truncated"), null)
})

test("多塊是**依序**送，不是併發（上游無配額可查）", async () => {
  let live = 0
  let peak = 0
  upstream = async (url, init) => {
    live++
    peak = Math.max(peak, live)
    await sleep(20)
    live--
    const body = JSON.parse(init.body)
    return new Response(sseBody([chunkFrame("c", body.model, body.messages.at(-1).content, "stop")]), { status: 200 })
  }
  await call("/v1/chat/completions", post(chatBody(lines(160, 40), { stream: false })))
  assert.ok(calls.length > 2, "要切多塊才有意義")
  assert.equal(peak, 1, `同時進上游的請求數應為 1，實際 ${peak}`)
})

const decodedHint = (r) => {
  const raw = r.headers.get("x-proxy-hint")
  return raw ? decodeURIComponent(raw) : ""
}

test("T1.1 實測：上游把 max_tokens 靜默鉗在 4,096 → 不覆蓋客戶的值，但要在標頭說清楚", async () => {
  echoUpstream()
  const r = await call("/v1/chat/completions", post(chatBody("hi", { max_tokens: 16384, stream: false })))
  assert.equal(calls[0].body.max_tokens, 16384, "規則 9：不覆蓋客戶端自己帶的值")
  const hint = decodedHint(r)
  assert.match(hint, /16384/, "要點名客戶帶的值，不然不知道在講什麼")
  assert.match(hint, /4096/, "要寫出上游的硬上限")
  assert.match(hint, /本代理不覆蓋/)
  assert.match(hint, /不是本代理切掉的/)
})

test("低於上限的 max_tokens 不該嘮叨；沒帶也不該有 hint（預設注入就是上限）", async () => {
  echoUpstream()
  const r1 = await call("/v1/chat/completions", post(chatBody("hi", { max_tokens: 512, stream: false })))
  assert.equal(decodedHint(r1), "")
  const r2 = await call("/v1/chat/completions", post(chatBody("hi", { stream: false })))
  assert.equal(calls.at(-1).body.max_tokens, 4096, "沒帶時注入的就是上限，沒有更高的空間")
  assert.equal(decodedHint(r2), "", "注入的是我們自己选的默认值，不該叫客戶為他沒帶的值負責")
})

test("串流客戶也看得到這個 hint（看得到 finish_reason，看不到原因）", async () => {
  echoUpstream({ finish: "length" })
  const r = await call("/v1/chat/completions", post(chatBody("hi", { stream: true, max_tokens: 9000 })))
  assert.equal(r.status, 200)
  assert.match(decodedHint(r), /4096/)
})

test("別名 max_output_tokens 也算客戶帶的值（與 injectProtocolDefaults 一致），超過上限一樣給 hint", async () => {
  echoUpstream()
  const r = await call("/v1/chat/completions", post(chatBody("hi", { max_output_tokens: 7000, stream: false })))
  assert.equal(calls[0].body.max_tokens, undefined, "帶了別名就不該再注入 max_tokens")
  assert.match(decodedHint(r), /4096/)
})

test("規則 4：finish_reason:length 是可偵測的 —— 帶 x-proxy-chunk-truncated", async () => {
  echoUpstream({ finish: "length" })
  const r = await call("/v1/chat/completions", post(chatBody(lines(60, 40), { stream: false })))
  assert.match(r.headers.get("x-proxy-chunk-truncated") || "", /^\d+$/)
  // 客戶自己設了 max_tokens：截斷是他的決定，不報錯
  const r2 = await call("/v1/chat/completions", post(chatBody(lines(60, 40), { stream: false, max_tokens: 50 })))
  assert.equal(r2.headers.get("x-proxy-chunk-truncated"), null)
})

test("design §3：其中一塊失敗 → 沿用該塊 status，並標明是哪一塊、之前成功幾行", async () => {
  let n = 0
  upstream = async (url, init) => {
    n++
    if (n === 2) return new Response(JSON.stringify({ error: { message: "上游 429" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } })
    const body = JSON.parse(init.body)
    return new Response(sseBody([chunkFrame("c", body.model, body.messages.at(-1).content, "stop")]), { status: 200 })
  }
  const r = await call("/v1/chat/completions", post(chatBody(lines(60, 40), { stream: false })))
  assert.equal(r.status, 429, "規則 6：不改 status")
  assert.equal(r.headers.get("x-proxy-chunk-failed"), "2/" + n)
  assert.ok(Number(r.headers.get("x-proxy-chunk-lines")) > 0)
  assert.match(decodeURIComponent(r.headers.get("x-proxy-hint") || ""), /每秒最大請求數/)
  assert.equal(r.headers.get("retry-after"), "3", "上游的 Retry-After 原樣透傳")
  const body = await r.json()
  assert.equal(body.error.message, "上游 429", "不改 body")
})

test("規則 6：上游錯誤不改 status、不改 body，建議放 x-proxy-hint", async () => {
  upstream = async () => new Response("<html>412 Precondition Failed</html>", { status: 412, headers: { "content-type": "text/html" } })
  const r = await call("/v1/chat/completions", post(chatBody("hi")))
  assert.equal(r.status, 412)
  assert.match(await r.text(), /412 Precondition Failed/)
  assert.match(decodeURIComponent(r.headers.get("x-proxy-hint") || ""), /WAF/)
  assert.equal(r.headers.get("x-proxy-upstream-stream"), "forced")
})

test("規則 7：閘滿時先本地排隊；等不到才 429（design §2）", async () => {
  upstream = async (url, init) => {
    await sleep(120)
    const body = JSON.parse(init.body)
    return new Response(sseBody([chunkFrame("c", body.model, "ok", "stop")]), { status: 200 })
  }

  // (a) 不給排隊時間（SLOT_WAIT_MS=0）→ 429，而且要是 OpenAI 錯誤形狀
  const envNoWait = { ITP_KEY: "test-key", MAX_INFLIGHT: "1", SLOT_WAIT_MS: "0" }
  const a = worker.fetch(req("/v1/chat/completions", post(chatBody("a"))), envNoWait)
  await sleep(20)
  const b = await worker.fetch(req("/v1/chat/completions", post(chatBody("b"))), envNoWait)
  assert.equal(b.status, 429)
  assert.equal(b.headers.get("retry-after"), "2")
  const gateBody = await b.json()
  assert.match(gateBody.error.message, /並發上限已滿/)
  assert.match(gateBody.error.message, /每秒最大請求數/)
  assert.equal(gateBody.error.code, 429)
  assert.equal((await a).status, 200)

  // (b) 同樣的上限，但允許排隊 → 前一個結束後第二個應該拿到 slot，而不是 429
  const envWait = { ITP_KEY: "test-key", MAX_INFLIGHT: "1", SLOT_WAIT_MS: "5000" }
  const c = worker.fetch(req("/v1/chat/completions", post(chatBody("c"))), envWait)
  await sleep(20)
  const d = await worker.fetch(req("/v1/chat/completions", post(chatBody("d"))), envWait)
  assert.equal(d.status, 200, "120ms 內拿到 slot，不該回 429")
  assert.equal((await c).status, 200)
})

test("串流客戶端：逐塊透傳、塊間插回分隔、[DONE] 只給一次", async () => {
  // 上游會保留原文的行結構（2026-10-10 實測）：這裡照樣吐整塊內容，只差前綴。
  upstream = async (url, init) => {
    const body = JSON.parse(init.body)
    const text = body.messages.at(-1).content.split("\n").map((l) => ">" + l).join("\n")
    return new Response(sseBody([chunkFrame("c3", body.model, text)]), { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  const r = await call("/v1/chat/completions", post(chatBody(lines(40, 40), { stream: true })))
  assert.match(r.headers.get("content-type"), /text\/event-stream/)
  assert.equal(r.headers.get("x-proxy-upstream-stream"), "forced")
  const raw = await r.text()
  const got = deltas(raw)
  assert.equal(got.split("\n").length, 40, "每行都在，且沒有黏行")
  assert.equal(raw.split("\n").filter((l) => l.includes("[DONE]")).length, 1)
})

test("串流客戶端：後面的塊失敗時改不了 status，只能在流裡說清楚（§3）", async () => {
  let n = 0
  upstream = async (url, init) => {
    n++
    if (n === 1) {
      const body = JSON.parse(init.body)
      return new Response(sseBody([chunkFrame("c", body.model, body.messages.at(-1).content, "stop")]), { status: 200 })
    }
    return new Response("nope", { status: 504 })
  }
  const r = await call("/v1/chat/completions", post(chatBody(lines(60, 40), { stream: true })))
  assert.equal(r.status, 200, "已送出開頭，status 不變")
  const raw = await r.text()
  const errFrame = raw.split("\n").find((l) => l.includes('"error"'))
  assert.ok(errFrame, "流內要有 error 框架")
  assert.match(JSON.parse(errFrame.slice(6)).error.message, /第 2\/\d+ 塊失敗/)
})

test("<think> 只在前面時才剝離（不做激進剝離，編號行要留）", async () => {
  upstream = async (url, init) => {
    const body = JSON.parse(init.body)
    return new Response(sseBody([
      chunkFrame("c4", body.model, "<think>"),
      chunkFrame("c4", body.model, "思考中"),
      chunkFrame("c4", body.model, "</think>1. 你好"),
      chunkFrame("c4", body.model, ""),
      chunkFrame("c4", body.model, "", "stop"),
    ]), { status: 200 })
  }
  const r = await call("/v1/chat/completions", post(chatBody("你好", { stream: false })))
  assert.equal((await r.json()).choices[0].message.content, "1. 你好")
})

test("401 有獨立限流：一直試錯 key 不能擠掉正常請求（design/auth.md）", async () => {
  echoUpstream()
  // 正式的實作綁 CF 的 [[ratelimits]]（design/auth.md 定案 6）；這裡注入同形狀的假綁定。
  let hits = 0
  const env = {
    ITP_KEY: "test-key",
    AUTH_RL: {
      async get() {
        hits++
        return hits > 3 ? { success: false, period: 5 } : { success: true }
      },
    },
  }
  let last
  for (let i = 0; i < 5; i++) {
    last = await worker.fetch(new Request("https://proxy.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(chatBody("hi")),
    }), env)
  }
  assert.equal(last.status, 429, "試到第 4 次應該被限流")
  assert.equal(last.headers.get("retry-after"), "5")
  assert.equal(calls.length, 0)
  // 正常請求不受影響
  const ok = await call("/v1/chat/completions", post(chatBody("hi")))
  assert.equal(ok.status, 200)
})

test("多 user 訊息時只切最後一則（system / 歷史不動）", async () => {
  echoUpstream()
  const body = {
    model: ALLOWED_MODEL,
    messages: [
      { role: "system", content: "你是翻譯引擎" },
      { role: "user", content: "short" },
      { role: "assistant", content: "ok" },
      { role: "user", content: lines(120, 40) },
    ],
  }
  await call("/v1/chat/completions", post(body))
  assert.ok(calls.length > 1)
  for (const c of calls) {
    assert.equal(c.body.messages[0].content, "你是翻譯引擎")
    assert.equal(c.body.messages[1].content, "short")
    assert.equal(c.body.messages[2].content, "ok")
  }
})

// 規則 4 的邊界：單行超長**不切**，回 413。行內切會讓插件的編號行對應錯位，
// 所以寧可讓使用者看到一句能處理的說明，也不要給出錯位的譯文。
test("單行超過 MAX_LINE_CHARS → 413，而且不消耗上游配額", async () => {
  upstream = async () => { throw new Error("不該打上游") }
  const r = await worker.fetch(
    req("/v1/chat/completions", post(chatBody(`第一行\n${"長".repeat(25)}\n第三行`))),
    { ...ENV, MAX_LINE_CHARS: "10" },
  )
  assert.equal(r.status, 413)
  const body = await r.json()
  assert.match(body.error.message, /第 2 行有 25 字元/)
  assert.match(body.error.message, /只在行界切塊/)
  assert.match(body.error.message, /MAX_LINE_CHARS/)
  assert.equal(calls.length, 0, "413 是本地決定，不能先花掉一次上游配額")
})

test("行界切塊不受影響：多行都不超長時照常切、照常送", async () => {
  echoUpstream()
  const r = await worker.fetch(
    req("/v1/chat/completions", post(chatBody(lines(6, 30)))),
    { ...ENV, MAX_INPUT_CHARS: "100", MAX_LINE_CHARS: "60" }, // 每行 34 字元 → 不觸發 413，但要切塊
  )
  assert.equal(r.status, 200)
  assert.ok(calls.length > 1, "應該切成多塊")
  assert.ok(Number(r.headers.get("x-proxy-chunks")) === calls.length)
})

test("單塊 body 過大 → 413（不讓它變成上游側的逾時）", async () => {
  echoUpstream()
  const r = await worker.fetch(req("/v1/chat/completions", post(chatBody("y".repeat(1500)))), { ...ENV, MAX_BODY_BYTES: "1024" })
  assert.equal(r.status, 413)
  const body = await r.json()
  assert.match(body.error.message, /超過上限 1024/)
  assert.match(body.error.message, /MAX_BODY_BYTES/)
  assert.equal(calls.length, 0)
})

// 跑完這個檔後還原真的 fetch。
after(() => { globalThis.fetch = realFetch })
