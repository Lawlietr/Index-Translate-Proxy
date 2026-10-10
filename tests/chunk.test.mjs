// 切塊（AGENTS.md 規則 4）：只在行界切；單行超長才硬切；拼回無損。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  splitLines,
  dominantSeparator,
  planChunks,
  reassemble,
  joinOutputs,
  findTranslatable,
  bodyForChunk,
} from "../src/lib/chunk.js"

const lines = (n, w = 30) => Array.from({ length: n }, (_, i) => `${i + 1}. ${"x".repeat(w)}`).join("\n")

test("不超上限就一塊都不切", () => {
  const t = lines(5)
  const p = planChunks(t, 2500)
  assert.equal(p.chunks.length, 1)
  assert.equal(p.chunks[0].text, t)
  assert.equal(p.chunks[0].join, "")
})

test("各種尺寸／上限：按 join 拼回 = 原文，逐字不損", () => {
  const samples = [
    lines(10, 40),
    lines(60, 40),
    lines(200, 12),
    "單一行但很短",
    `${lines(20)}\n${"B".repeat(2600)}\n${lines(5)}`,
    "a\n\n\nb\n\n", // 空行（sep 連續）
    "尾端有換行\n",
    "沒有尾端換行",
  ]
  for (const t of samples) {
    for (const max of [10, 50, 200, 800, 2500]) {
      const p = planChunks(t, max)
      assert.equal(reassemble(p), t, `max=${max} 拼回不一致`)
      for (const c of p.chunks) assert.ok(c.text.length <= max, `塊超過上限：${c.text.length} > ${max}`)
      assert.ok(p.chunks.length > 0)
    }
  }
})

test("每塊都在行界：沒有行內被切開（編號行是插件的對應協定）", () => {
  const p = planChunks(lines(60, 40), 1000)
  assert.ok(p.chunks.length > 1, "應該要切開")
  for (const c of p.chunks) {
    assert.ok(!c.text.startsWith("\n"), "塊首不該是換行")
    assert.ok(!c.text.endsWith("\n"), "塊尾不該是換行（分隔改由 join 承擔）")
    for (const line of c.text.split("\n")) assert.match(line, /^\d+\. x+$/, `行內被切：${JSON.stringify(line)}`)
  }
})

test("多塊時 join 記的就是原本的分隔字元", () => {
  const p = planChunks(lines(30), 500)
  assert.equal(p.chunks[0].join, "")
  for (const c of p.chunks.slice(1)) assert.equal(c.join, "\n")
})

test("單行本身超長：只有這種情況硬切，且切點兩邊不補字元", () => {
  const one = "A".repeat(3000)
  const p = planChunks(one, 1000)
  assert.ok(p.chunks.length >= 3)
  assert.equal(p.chunks[0].join, "")
  for (const c of p.chunks.slice(1)) assert.equal(c.join, "")
  assert.equal(reassemble(p), one)
})

test("超長行混在正常行裡：前後行的對應不受影響", () => {
  const t = `${lines(8)}\n${"B".repeat(2600)}\n${lines(3)}`
  const p = planChunks(t, 1000)
  assert.equal(reassemble(p), t)
  // 那個超長行的前後仍是完整行
  const joined = p.chunks.map((c) => c.text).filter(Boolean)
  assert.ok(joined.some((x) => /^B+$/.test(x)))
  for (const c of p.chunks) {
    for (const line of c.text.split("\n")) {
      if (/^B+$/.test(line) || line.length > 1000) continue
      assert.match(line, /^\d+\. x+$/, JSON.stringify(line))
    }
  }
})

test("CRLF 原文：分隔字元原樣保留", () => {
  const t = Array.from({ length: 40 }, (_, i) => `${i + 1}. ${"y".repeat(30)}`).join("\r\n")
  const p = planChunks(t, 700)
  assert.equal(p.separator, "\r\n")
  assert.equal(reassemble(p), t)
  for (const c of p.chunks) assert.ok(!/[\r\n]$/.test(c.text), "塊尾不該殘留換行")
})

test("行數統計給 x-proxy-chunk-lines 用：加總要等於原文行數", () => {
  const p = planChunks(lines(37), 500)
  assert.equal(p.totalLines, 37)
  assert.equal(p.chunks.reduce((n, c) => n + c.lines, 0), 37)
})

test("joinOutputs：譯文按原分隔接回（§4）", () => {
  const p = planChunks(lines(6), 200)
  const translated = p.chunks.map((c) => c.text.replace(/x+/g, "譯"))
  const out = joinOutputs(translated, p)
  assert.equal(out.split("\n").length, 6)
  assert.equal(out, lines(6).replace(/x+/g, "譯"))
})

test("joinOutputs：硬切的譯文之間不插字元", () => {
  const p = planChunks("A".repeat(3000), 1000)
  const out = joinOutputs(p.chunks.map((c) => c.text.toLowerCase()), p)
  assert.equal(out, "a".repeat(3000))
})

test("findTranslatable 取最後一則 user 訊息（插件就是這樣送）", () => {
  const body = {
    messages: [
      { role: "system", content: "system prompt 不切" },
      { role: "user", content: "第一輪" },
      { role: "assistant", content: "回應" },
      { role: "user", content: "要翻的" },
    ],
  }
  const t = findTranslatable(body)
  assert.equal(t.index, 3)
  assert.equal(t.content, "要翻的")
})

test("content 不是字串（多模態）或沒有 user 訊息就不切", () => {
  assert.equal(findTranslatable({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), null)
  assert.equal(findTranslatable({ messages: [{ role: "system", content: "x" }] }), null)
  assert.equal(findTranslatable({}), null)
})

test("bodyForChunk 只換那段 content，其他欄位原樣，且不改到原 body（規則 9）", () => {
  const body = { model: "m", temperature: 0.3, messages: [{ role: "system", content: "sys" }, { role: "user", content: lines(60) }] }
  const t = findTranslatable(body)
  const plan = planChunks(t.content, 800)
  const b1 = bodyForChunk(body, t, plan, 1)
  assert.equal(b1.temperature, 0.3)
  assert.equal(b1.model, "m")
  assert.equal(b1.messages[0].content, "sys", "system 訊息不動")
  assert.equal(b1.messages[1].content, plan.chunks[1].text)
  assert.equal(body.messages[1].content, lines(60), "原 body 不该被改到")
})

test("splitLines 保留原始分隔字元；dominantSeparator 取多數", () => {
  assert.deepEqual(splitLines("a\nb\r\nc\rd"), [
    { line: "a", sep: "\n" },
    { line: "b", sep: "\r\n" },
    { line: "c", sep: "\r" },
    { line: "d", sep: "" },
  ])
  assert.equal(dominantSeparator(splitLines("a\r\nb\r\nc\nd")), "\r\n")
})
