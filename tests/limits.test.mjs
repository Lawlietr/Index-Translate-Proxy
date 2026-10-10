// 並發閘（AGENTS.md 規則 7）與 env 讀取。設計理由見 design/streaming-and-chunking.md §2。
import { test } from "node:test"
import assert from "node:assert/strict"
import { ConcurrencyGate, getGate, readLimits, gateFullResponse, DEFAULTS } from "../src/lib/limits.js"

test("readLimits：env 是字串，而且要夾在上界下限之間", () => {
  const d = readLimits({})
  assert.deepEqual(d, {
    maxInputChars: DEFAULTS.MAX_INPUT_CHARS,
    maxTokensDefault: DEFAULTS.MAX_TOKENS_DEFAULT,
    maxInflight: DEFAULTS.MAX_INFLIGHT,
    slotWaitMs: DEFAULTS.SLOT_WAIT_MS,
    maxLineChars: DEFAULTS.MAX_LINE_CHARS,
    maxBodyBytes: DEFAULTS.MAX_BODY_BYTES,
  })
  const c = readLimits({ MAX_INPUT_CHARS: "999999", MAX_INFLIGHT: "0", SLOT_WAIT_MS: "250", MAX_TOKENS_DEFAULT: "abc" })
  assert.equal(c.maxInputChars, 20000, "上界")
  assert.equal(c.maxInflight, 1, "下限")
  assert.equal(c.slotWaitMs, 250)
  assert.equal(c.maxTokensDefault, DEFAULTS.MAX_TOKENS_DEFAULT, "非數字要回退到預設，不能變 NaN")
  // SLOT_WAIT_MS=0 是**有意**的設定（不排隊，滿了直接 429），不能被當成「沒給」而退回預設。
  assert.equal(readLimits({ SLOT_WAIT_MS: "0" }).slotWaitMs, 0)
  assert.equal(readLimits({ MAX_LINE_CHARS: "100000" }).maxLineChars, 8000, "單行上限也要夾住")
})

test("tryAcquire：超過上限就 false", () => {
  const g = new ConcurrencyGate(2)
  assert.ok(g.tryAcquire() && g.tryAcquire())
  assert.equal(g.tryAcquire(), false)
  assert.equal(g.available, false)
  g.release()
  assert.ok(g.tryAcquire())
})

test("waitForSlot：release() 直接把額度交給排隊的下一個", async () => {
  const g = new ConcurrencyGate(1)
  assert.ok(g.tryAcquire())
  const waiting = g.waitForSlot(5000)
  let settled = false
  waiting.then(() => (settled = true))
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false, "還有人在用，不該提前成功")
  g.release()
  assert.equal(await waiting, true)
  assert.equal(g.active, 1, "額度直接轉手，不應掉到 0 再被別人搶走")
})

test("waitForSlot：等不到就 false，而且不留等待者", async () => {
  const g = new ConcurrencyGate(1)
  assert.ok(g.tryAcquire())
  const t0 = Date.now()
  assert.equal(await g.waitForSlot(30), false)
  assert.ok(Date.now() - t0 >= 25, "要真的等過 timeout")
  assert.equal(g._waiters.length, 0, "逾時的等待者要從佇列移除，否則 release() 會喚醒幽靈")
  g.release()
  assert.ok(g.tryAcquire(), "release 後額度要能重新取得")
})

test("getGate：同一 isolate 共用一個閘；上限改了才重建", () => {
  const a = getGate(4)
  assert.equal(getGate(4), a)
  const b = getGate(2)
  assert.notEqual(b, a)
  assert.equal(b.limit, 2)
})

test("429 的形狀：OpenAI 錯誤 + Retry-After，而且說明是本地閘", async () => {
  const res = gateFullResponse()
  assert.equal(res.status, 429)
  assert.equal(res.headers.get("retry-after"), "2")
  assert.equal(res.headers.get("access-control-allow-origin"), "*")
  const body = await res.json()
  assert.equal(body.error.type, "rate_limit_error")
  assert.match(body.error.message, /並發上限已滿/)
  assert.match(body.error.message, /每秒最大請求數/)
  assert.match(decodeURIComponent(res.headers.get("x-proxy-hint")), /MAX_INFLIGHT/)
})
