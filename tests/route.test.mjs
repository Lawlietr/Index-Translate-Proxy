// 路徑解析（AGENTS.md 規則 5）。離線測試：node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolvePathname, isChatPath, rootDescription } from "../src/lib/route.js"

test("插件形狀：/v1 結尾的自訂地址補 /v1 前綴", () => {
  assert.deepEqual(resolvePathname("/chat/completions"), { kind: "upstream", path: "/v1/chat/completions" })
  assert.deepEqual(resolvePathname("/models"), { kind: "upstream", path: "/v1/models" })
  assert.deepEqual(resolvePathname("/responses"), { kind: "upstream", path: "/v1/responses" })
})

test("已帶 /v1 的路徑絕不再補前綴（會變成 /v1/v1 → 上游 404）", () => {
  assert.deepEqual(resolvePathname("/v1/chat/completions"), { kind: "upstream", path: "/v1/chat/completions" })
  assert.deepEqual(resolvePathname("/v1/models"), { kind: "upstream", path: "/v1/models" })
  assert.equal(resolvePathname("/v1/v1/chat/completions").kind, "not_found")
})

test("/api/* 是姐妹專案的寫法，映射到同一組上游路徑", () => {
  assert.deepEqual(resolvePathname("/api/chat/completions"), { kind: "upstream", path: "/v1/chat/completions" })
  assert.deepEqual(resolvePathname("/api/models"), { kind: "upstream", path: "/v1/models" })
  assert.equal(resolvePathname("/api/embeddings").kind, "not_found")
})

test("尾斜線不影響解析（插件常带）", () => {
  assert.deepEqual(resolvePathname("/v1/chat/completions/"), { kind: "upstream", path: "/v1/chat/completions" })
  assert.deepEqual(resolvePathname("/models/"), { kind: "upstream", path: "/v1/models" })
})

test("白名單以外的路徑本地 404，不丟上游", () => {
  for (const p of ["/", "/foo", "/v1", "/v1/", "/completions", "/v1beta/chat/completions", "//chat/completions", "/chat/completions/extra"]) {
    const r = resolvePathname(p)
    assert.notEqual(r.kind, "upstream", p)
  }
})

test("根路徑是另一種 kind（由 worker 給一行說明）", () => {
  assert.equal(resolvePathname("/").kind, "root")
})

test("查詢字串不影響 path 解析（由呼叫端先取 pathname）", () => {
  assert.deepEqual(resolvePathname(new URL("https://x/v1/models?x=1").pathname), { kind: "upstream", path: "/v1/models" })
})

test("isChatPath 只認 chat/completions", () => {
  assert.ok(isChatPath("/v1/chat/completions"))
  assert.ok(!isChatPath("/v1/models"))
  assert.ok(!isChatPath("/v1/responses"))
})

test("根路徑說明自報可用模型與鑑權狀態", () => {
  const off = rootDescription("proxy.example", false)
  assert.match(off, /https:\/\/proxy\.example\/v1/)
  assert.match(off, /Index-Translate-35B-A3B/)
  assert.match(off, /未設定（沒有 ITP_KEY，請求會回 503/)
  const on = rootDescription("proxy.example", "configured")
  assert.match(on, /已啟用/)
  assert.match(on, /Authorization/)
  const many = rootDescription("proxy.example", "configured", ["Index-Translate-35B-A3B", "index-mt-2b"])
  assert.match(many, /index-mt-2b/)
})
