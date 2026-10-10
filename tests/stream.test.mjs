// 串流（規則 3、4）：SSE 解析、<think> 前綴剝離、非串流客戶端的組包。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseSSE,
  parseData,
  deltaText,
  finishReasonOf,
  usageOf,
  separatorChunk,
  ThinkStripper,
  assembleCompletion,
} from "../src/lib/stream.js"

const chunk = (content, finish = null, extra = {}) => ({
  id: "chatcmpl-x",
  object: "chat.completion.chunk",
  created: 100,
  model: "Index-Translate-35B-A3B",
  choices: [{ index: 0, delta: { content }, logprobs: null, finish_reason: finish }],
  ...extra,
})
const sse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"

async function collectStream(text) {
  const out = []
  for await (const d of parseSSE(new Response(text).body)) out.push(d)
  return out
}

test("parseSSE 拆出每個 data，[DONE] 保留為最後一個", async () => {
  const got = await collectStream(sse([chunk("a"), chunk("b", "stop")]))
  assert.equal(got.length, 3)
  assert.deepEqual(JSON.parse(got[0]).choices[0].delta.content, "a")
  assert.equal(got[2], "[DONE]")
})

test("parseSSE 吃「事件跨過多個 TCP 段」的情況", async () => {
  const body = sse([chunk("hello")])
  const stream = new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      c.enqueue(enc.encode(body.slice(0, 40)))
      c.enqueue(enc.encode(body.slice(40, 91)))
      c.enqueue(enc.encode(body.slice(91)))
      c.close()
    },
  })
  const out = []
  for await (const d of parseSSE(stream)) out.push(d)
  assert.equal(out.length, 2)
  assert.deepEqual(JSON.parse(out[0]).choices[0].delta.content, "hello")
})

test("parseSSE 不拆破 UTF-8 多字節（中文跨段）", async () => {
  const body = sse([chunk("你好世界")])
  const bytes = new TextEncoder().encode(body)
  const stream = new ReadableStream({
    start(c) {
      // 在字元中間切開
      c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)))
      c.enqueue(bytes.slice(Math.floor(bytes.length / 2)))
      c.close()
    },
  })
  const out = []
  for await (const d of parseSSE(stream)) out.push(d)
  assert.deepEqual(JSON.parse(out[0]).choices[0].delta.content, "你好世界")
})

test("CRLF 的 SSE（有些網關用 \\r\\n）也能解析", async () => {
  const body = sse([chunk("a")]).replace(/\n/g, "\r\n")
  const got = await collectStream(body)
  assert.deepEqual(JSON.parse(got[0]).choices[0].delta.content, "a")
})

test("非 JSON 的 data 不炸，標記為 raw", () => {
  assert.deepEqual(parseData("[DONE]"), { kind: "done" })
  assert.equal(parseData("{not json").kind, "raw")
  assert.equal(parseData('{"a":1}').kind, "json")
})

test("deltaText / finishReasonOf / usageOf 對缺欄位容錯", () => {
  assert.equal(deltaText({}), "")
  assert.equal(deltaText({ choices: [{ delta: {} }] }), "")
  assert.equal(deltaText({ choices: [{ delta: { content: "hi" } }] }), "hi")
  assert.equal(finishReasonOf({ choices: [{}] }), null)
  assert.equal(finishReasonOf({ choices: [{ finish_reason: "length" }] }), "length")
  assert.equal(usageOf({}), null)
  assert.deepEqual(usageOf({ usage: { total_tokens: 3 } }), { total_tokens: 3 })
})

test("ThinkStripper：標記跨多個 delta 也能丟掉中間內容", () => {
  const s = new ThinkStripper()
  let out = ""
  for (const piece of ["<thi", "nk>思考", "過程", "</th", "ink>1. 你好", "世界"]) out += s.push(piece)
  out += s.end()
  assert.equal(out, "1. 你好世界")
})

test("ThinkStripper：沒有標記時原樣通過（上游實測不吐 <think>）", () => {
  const s = new ThinkStripper()
  let out = ""
  for (const p of ["1. Hello", "\n2. World"]) out += s.push(p)
  out += s.end()
  assert.equal(out, "1. Hello\n2. World")
})

test("ThinkStripper：像前綴的字（例如 <theory>）不會被吞", () => {
  const s = new ThinkStripper()
  let out = ""
  for (const p of ["a<th", "eory>b"]) out += s.push(p)
  out += s.end()
  assert.equal(out, "a<theory>b")
})

test("ThinkStripper：<think> 沒閉合（思考被截斷）時，後面的內容不要當作譯文", () => {
  const s = new ThinkStripper()
  let out = ""
  for (const p of ["<think>想了很多"]) out += s.push(p)
  out += s.end()
  assert.equal(out, "")
  // 但沒有標記的正常文字不會被吞。
  const t = new ThinkStripper()
  assert.equal(t.push("1. Hello") + t.end(), "1. Hello")
})

test("separatorChunk：塊之間要插回原分隔字元", () => {
  const c = separatorChunk({ id: "chatcmpl-x", model: "m", created: 1 }, "\n")
  assert.equal(c.object, "chat.completion.chunk")
  assert.deepEqual(c.choices[0].delta, { content: "\n" })
  assert.equal(c.id, "chatcmpl-x")
})

test("assembleCompletion：多塊按 joins 接回，並給出單一 chat.completion", () => {
  const parts = [
    { content: "1. A\n2. B", finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, id: "chatcmpl-1", model: "Index-Translate-35B-A3B", created: 111 },
    { content: "3. C", finish_reason: "stop", usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
  ]
  const out = assembleCompletion(parts, { joins: ["", "\n"], model: "Index-Translate-35B-A3B" })
  assert.equal(out.object, "chat.completion")
  assert.equal(out.choices[0].message.role, "assistant")
  assert.equal(out.choices[0].message.content, "1. A\n2. B\n3. C")
  assert.equal(out.choices[0].finish_reason, "stop")
  assert.equal(out.id, "chatcmpl-1")
  assert.equal(out.usage.total_tokens, 27)
})

test("assembleCompletion：finish_reason 取最後一塊（前面的塊被截由標頭另行標記）", () => {
  const parts = [
    { content: "a", finish_reason: "length", usage: { total_tokens: 1 } },
    { content: "b", finish_reason: "stop", usage: { total_tokens: 1 } },
  ]
  assert.equal(assembleCompletion(parts, { joins: ["", "\n"], model: "m" }).choices[0].finish_reason, "stop")
})

test("assembleCompletion：任一塊缺 usage 就不帶（不造假數字）", () => {
  const parts = [
    { content: "a", finish_reason: "stop", usage: { total_tokens: 1 } },
    { content: "b", finish_reason: "stop", usage: null },
  ]
  const out = assembleCompletion(parts, { joins: ["", "\n"], model: "m" })
  assert.equal("usage" in out, false)
})
