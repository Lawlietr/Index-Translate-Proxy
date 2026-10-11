// 建置標記（AGENTS 規則 13）：線上探測的失敗要能對應到某一次部署。
// 兩層都測：取值規則（含「沒有就不帶」）與**所有回應都帶**（401 這種本地錯誤尤其重要）。
import test from "node:test"
import assert from "node:assert/strict"
import worker from "../src/worker.js"
import { buildRef, withBuildMarker, BUILD_HEADER } from "../src/lib/build-info.js"

const SHA40 = "9f3c1d2e4b5a69788796a5b4c3d2e1f098765432"

test("buildRef：優先用自己部署時設的 GIT_COMMIT，取 12 字元小寫", () => {
  assert.equal(buildRef({ GIT_COMMIT: SHA40 }), SHA40.slice(0, 12))
  assert.equal(buildRef({ GIT_COMMIT: SHA40.toUpperCase() }), SHA40.slice(0, 12))
  assert.equal(buildRef({ GIT_COMMIT: "  " + SHA40 + "  " }), SHA40.slice(0, 12))
  assert.equal(buildRef({ GIT_SHA: SHA40 }), SHA40.slice(0, 12))
})

test("buildRef：自己設的排在平台注入的前面（後者只有 Connected to Git 才有值）", () => {
  assert.equal(buildRef({ GIT_COMMIT: SHA40, VERCEL_GIT_COMMIT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), SHA40.slice(0, 12))
  assert.equal(buildRef({ GIT_COMMIT: "", VERCEL_GIT_COMMIT_SHA: SHA40 }), SHA40.slice(0, 12))
  assert.equal(buildRef({ GIT_COMMIT: "", CF_PAGES_COMMIT_SHA: SHA40 }), SHA40.slice(0, 12))
})

test("buildRef：沒有、太短、非 hex、非字串 → null（不造假）", () => {
  assert.equal(buildRef({}), null)
  assert.equal(buildRef(undefined), null)
  assert.equal(buildRef({ GIT_COMMIT: "" }), null)
  assert.equal(buildRef({ GIT_COMMIT: "deadbeef" }), "deadbeef") // 7 個以上才算 hex 參考
  assert.equal(buildRef({ GIT_COMMIT: "abc" }), null) // 太短，不像 commit
  assert.equal(buildRef({ GIT_COMMIT: "main" }), null) // 分支名不是 commit
  assert.equal(buildRef({ GIT_COMMIT: "中文" }), null)
  assert.equal(buildRef({ GIT_COMMIT: 42 }), null)
})

test("buildRef：env 是會丟例外屬性的 proxy 物件時不會掛掉", () => {
  const hostile = new Proxy(
    {},
    {
      get(target, key) {
        if (key === "GIT_COMMIT") throw new Error("讀 env 會丟的 runtime")
        return undefined
      },
    },
  )
  assert.equal(buildRef(hostile), null)
  const halfBroken = new Proxy(
    { CF_PAGES_COMMIT_SHA: SHA40 },
    {
      get(t, key) {
        if (key === "GIT_COMMIT" || key === "GIT_SHA" || key === "VERCEL_GIT_COMMIT_SHA") throw new Error("壞掉的來源")
        return t[key]
      },
    },
  )
  assert.equal(buildRef(halfBroken), SHA40.slice(0, 12))
})

test("withBuildMarker：不知道建置時原樣回傳（不帶標頭、不造假）", async () => {
  const res = new Response("hi", { status: 200, headers: { "x-marker": "keep" } })
  const out = withBuildMarker(res, {})
  assert.equal(out, res)
  assert.equal(out.headers.get(BUILD_HEADER), null)
})

test("withBuildMarker：保留原有標頭與 status，而且 body 只讀一次（不緩衝）", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("a"))
      c.enqueue(new TextEncoder().encode("b"))
      c.close()
    },
  })
  const res = new Response(stream, { status: 201, headers: { "x-keep": "1", "content-type": "text/plain" } })
  const out = withBuildMarker(res, { GIT_COMMIT: SHA40 })
  assert.equal(out.headers.get(BUILD_HEADER), SHA40.slice(0, 12))
  assert.equal(out.headers.get("x-keep"), "1")
  assert.equal(out.status, 201)
  assert.equal(await out.text(), "ab")
})

// 協定層：所有回應都帶（探測紅的時候多半就是這些 4xx）
const req = (path, opts = {}) => new Request(`https://proxy.example${path}`, opts)

test("GET / 帶 x-proxy-build；設了 GIT_COMMIT 才帶", async () => {
  const withRef = await worker.fetch(req("/"), { ITP_KEY: "k", GIT_COMMIT: SHA40 })
  assert.equal(withRef.headers.get(BUILD_HEADER), SHA40.slice(0, 12))
  assert.equal(withRef.headers.get("x-proxy-auth"), "configured") // 原有標頭沒被動到

  const withoutRef = await worker.fetch(req("/"), { ITP_KEY: "k" })
  assert.equal(withoutRef.headers.get(BUILD_HEADER), null)
})

test("本地錯誤（401／404）也帶——這是排程探測最需要的對應", async () => {
  const unauth = await worker.fetch(
    req("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ model: "index-mt-9b", messages: [{ role: "user", content: "1. hi" }] }),
    }),
    { ITP_KEY: "k", GIT_COMMIT: SHA40 },
  )
  assert.equal(unauth.status, 401)
  assert.equal(unauth.headers.get(BUILD_HEADER), SHA40.slice(0, 12))

  const notFound = await worker.fetch(req("/nope"), { ITP_KEY: "k", GIT_COMMIT: SHA40 })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.headers.get(BUILD_HEADER), SHA40.slice(0, 12))
})

test("OPTIONS（204，沒有 body）也帶，而且不會因為複製而壞", async () => {
  const res = await worker.fetch(req("/v1/chat/completions", { method: "OPTIONS" }), { ITP_KEY: "k", GIT_COMMIT: SHA40 })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get(BUILD_HEADER), SHA40.slice(0, 12))
  assert.equal(res.headers.get("access-control-allow-headers").includes("authorization"), true)
})
