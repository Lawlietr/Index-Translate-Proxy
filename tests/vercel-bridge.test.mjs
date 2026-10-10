// 離線測 Vercel 的**平台橋**（src/lib/vercel-adapter.js + api/index.js）：
// 起一個真的 http server 接 handler，用真的 fetch 打它，上游用假的。
// 目的不是重測協定（那在 tests/worker.test.mjs），而是驗證「Node 的 req/res 換成 Request/Response」
// 不會弄破鑑權、串流真增量、錯誤形狀、body 上限、401 限流。跑法：npm test
import { test, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { nodeHandler, toWebRequest } from "../src/lib/vercel-node-adapter.js"
import { memoryRateLimit } from "../src/lib/limits.js"
import { clientIp } from "../src/lib/auth.js"

const client = globalThis.fetch // 客戶端要用真的 fetch，別被下面的假上游蓋掉
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ENC = new TextEncoder()

let calls = []
let upstream = null
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body })
  if (!upstream) throw new Error("test 忘了設 upstream()")
  return upstream(url, init)
}
beforeEach(() => {
  calls = []
  upstream = null
})

const server = createServer((req, res) => {
  nodeHandler(req, res).catch((err) => {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ crashed: String(err?.message || err) }))
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const BASE = `http://127.0.0.1:${server.address().port}`

const KEY = "bridge-key"
const AUTH = { authorization: `Bearer ${KEY}` }
process.env.ITP_KEY = KEY

const frame = (content, finish = null) =>
  `data: ${JSON.stringify({
    id: "c1", object: "chat.completion.chunk", created: 100, model: "Index-Translate-35B-A3B",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`

/** 會慢慢吐的假上游：用来验「首塊先到」這種時序。 */
function slowUpstream(parts, gapMs = 60) {
  upstream = async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          for (const p of parts) {
            controller.enqueue(ENC.encode(p))
            await sleep(gapMs)
          }
          controller.close()
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
}
const chatReq = (extra = {}, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...AUTH, ...headers },
  body: JSON.stringify({ model: "Index-Translate-35B-A3B", messages: [{ role: "user", content: "hi" }], ...extra }),
})

test("沒有 key → 401（OpenAI 形狀，經過 Node 橋不破）", async () => {
  upstream = async () => new Response("不該打到上游", { status: 200 })
  const r = await client(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "Index-Translate-35B-A3B", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(r.status, 401)
  const j = await r.json()
  assert.match(j.error.message, /未提供|不正確/)
  assert.equal(calls.length, 0, "401 不該消耗上游配額（規則 8）")
})

test("未知模型 → 本地 400，不丟上游", async () => {
  const r = await client(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "index-mt-9b", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(r.status, 400)
  assert.equal(calls.length, 0)
})

test("串流客戶端：SSE 逐塊送達（不是收完才回）", async () => {
  slowUpstream([frame("第一段"), frame("第二段"), frame("", "stop"), "data: [DONE]\n\n"], 60)
  const t0 = Date.now()
  const r = await client(`${BASE}/v1/chat/completions`, chatReq({ stream: true }))
  assert.equal(r.status, 200)
  assert.match(r.headers.get("content-type"), /text\/event-stream/)
  assert.equal(r.headers.get("x-proxy-upstream-stream"), "forced")
  const reader = r.body.getReader()
  const first = await reader.read()
  const firstMs = Date.now() - t0
  await reader.read()
  const secondMs = Date.now() - t0
  assert.ok(first.value?.length > 0, "首塊要有內容")
  assert.ok(secondMs > firstMs, `第二塊要在第一塊之後（${firstMs} → ${secondMs}）`)
  assert.ok(firstMs < 120, `首塊不該等整個上游結束（實際 ${firstMs}ms；上游總長約 240ms）`)
  while (!(await reader.read()).done) {}
})

test("非串流客戶端：組回單一 chat.completion", async () => {
  slowUpstream([frame("合併"), frame("結果"), frame("", "stop"), "data: [DONE]\n\n"], 20)
  const r = await client(`${BASE}/v1/chat/completions`, chatReq())
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.choices[0].message.content, "合併結果")
})

test("GET /v1/models：只帶 UA，key 不進上游（規則 8）", async () => {
  upstream = async () => new Response(JSON.stringify({ object: "list", data: [{ id: "Index-Translate-35B-A3B" }] }), {
    status: 200, headers: { "content-type": "application/json" },
  })
  const r = await client(`${BASE}/v1/models`, { headers: AUTH })
  assert.equal(r.status, 200)
  const headers = new Headers(calls[0].headers)
  assert.match(headers.get("user-agent"), /^Index-Translate-Proxy\//)
  assert.equal(headers.get("authorization"), null)
})

test("根路徑回一行說明 + x-proxy-auth（規則 5 的唯一例外）", async () => {
  const r = await client(`${BASE}/`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get("x-proxy-auth"), "configured")
  assert.match(await r.text(), /\/v1/)
})

test("toWebRequest：還原完整 URL 與方法（上游 URL 由 route.js 組，不能錯一段）", async () => {
  const fakeReq = {
    method: "POST",
    url: "/v1/chat/completions?x=1",
    headers: { host: "example.vercel.app", "x-forwarded-proto": "https", "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"a":1}') },
  }
  const request = await toWebRequest(fakeReq)
  assert.equal(request.url, "https://example.vercel.app/v1/chat/completions?x=1")
  assert.equal(request.method, "POST")
  assert.equal(await request.text(), '{"a":1}')
})

test("clientIp：一份跨平台順序（CF → x-real-ip → x-forwarded-for）", async () => {
  const mk = (h) => ({ headers: new Headers(h) })
  assert.equal(clientIp(mk({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2" })), "1.1.1.1")
  assert.equal(clientIp(mk({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3, 10.0.0.1" })), "2.2.2.2")
  assert.equal(clientIp(mk({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" })), "3.3.3.3")
  assert.equal(clientIp(mk({})), "unknown")
})

test("超大的請求體 → 本地 413，不打上游", async () => {
  const r = await client(`${BASE}/v1/chat/completions`, chatReqExtraBody("x".repeat(2 * 1024 * 1024 + 10)))
  assert.equal(r.status, 413)
  assert.equal(calls.length, 0)
})
function chatReqExtraBody(body) {
  return { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body }
}

test("401 連續太多次 → 限流（純記憶體版，補 CF 綁定的位）", async () => {
  const rl = memoryRateLimit({ limit: 2, period: 60 })
  assert.equal(rl.get("1.2.3.4").success, true)
  assert.equal(rl.get("1.2.3.4").success, true)
  const third = rl.get("1.2.3.4")
  assert.equal(third.success, false)
  assert.equal(third.period, 60)
  assert.equal(rl.get("9.9.9.9").success, true, "不同 IP 不該互相影響")
})

after(() => {
  server.close()
})
