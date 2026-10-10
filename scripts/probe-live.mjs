// 線上探測（AGENTS.md 規則 13）：部署之後打**真的 worker**，因為「本機跑過」在 edge 部署的情境裡不代表線上。
// 跑法：
//   node scripts/probe-live.mjs --url https://<你的 worker> [--key <ITP_KEY>] [--out results/live-<時間>.json]
//   PROXY_URL=… PROXY_KEY=… node scripts/probe-live.mjs
// 沒有 --url 時，會用 wrangler.toml 的 name 猜 workers.dev 網址（猜錯就請帶 --url）。
// 注：這裡會花到**真的上游配額**（上游按 IP 限流），所以檢查刻意保持少量但每條都有。
import { writeFileSync, mkdirSync } from "node:fs"

const argv = process.argv.slice(2)
// 同時支援 --name=value 與 --name value（寫 probe 的人兩種都會打）。
const argOf = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) return argv[i + 1]
  return undefined
}
// 位置參數也吃：`node scripts/probe-live.mjs https://…` 是探測時最常見的打法。
const POSITIONAL_URL = argv.find((a) => !a.startsWith("--") && /^https?:\/\//.test(a))
const BASE = (argOf("url") || POSITIONAL_URL || process.env.PROXY_URL || "https://index-translate-proxy.pages.dev").replace(/\/+$/, "")
const KEY = argOf("key") || process.env.PROXY_KEY || ""
const OUT = argOf("out")
const ALLOWED_MODEL = "Index-Translate-35B-A3B"
const t0 = Date.now()
const stamp = () => new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 14)

let pass = 0
let fail = 0
const results = []
function check(name, cond, info) {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + (info ?? "")}`)
  results.push({ name, ok: Boolean(cond), info: cond ? undefined : String(info ?? "") })
}

const headers = () => {
  // UA 用 ASCII（標頭值不能有全形字），而且是腳本樣式 UA：打 worker 不該被擋，
  // 因為擋 UA 的是上游，我們自己這一層不看 UA。
  const h = { "content-type": "application/json", "user-agent": "index-translate-proxy-probe/1.0 (script; not a browser)" }
  if (KEY) h.authorization = `Bearer ${KEY}`
  return h
}

async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...headers(), ...(init.headers || {}) } })
  const text = await res.text()
  return { res, text }
}

function sseData(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
}

function deltaContent(dataLines) {
  let out = ""
  for (const d of dataLines) {
    if (d === "[DONE]") continue
    try {
      const obj = JSON.parse(d)
      out += obj.choices?.[0]?.delta?.content ?? ""
    } catch {
      /* 非 JSON 的 data 行原樣跳過（上游偶爾塞注解行） */
    }
  }
  return out
}

const numbered = (n, w = 24) =>
  Array.from({ length: n }, (_, i) => `${i + 1}. This is line ${i + 1} of the source text ${"x".repeat(w)}.`).join("\n")

async function main() {
  console.log(`探測目標：${BASE}${KEY ? "（帶 key）" : "（不帶 key）"}`)

  // 1) 根路徑：一行說明 + x-proxy-auth。開根路徑就知道 key 有沒有設好。
  const root = await call("/")
  const authFlag = root.res.headers.get("x-proxy-auth")
  check("GET / → 200 + x-proxy-auth", root.res.status === 200 && (authFlag === "configured" || authFlag === "missing"), `${root.res.status} / ${authFlag}`)
  if (authFlag === "missing") {
    check("未設 ITP_KEY 時 chat 請求回 503（不假裝能用）", true, "")
    const r = await call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: ALLOWED_MODEL, messages: [{ role: "user", content: "你好" }] }) })
    check("未設 ITP_KEY 時 chat 請求回 503", r.res.status === 503, r.res.status)
    console.log("\n線上還沒設 ITP_KEY，先跑 `wrangler secret put ITP_KEY` 再探一次。")
    return
  }

  // 2) 預檢：allow-headers 少了 authorization，插件只會報 CORS 失敗。
  const preflight = await fetch(`${BASE}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: { origin: "https://example.com", "access-control-request-method": "POST" },
  })
  const allowHeaders = preflight.headers.get("access-control-allow-headers") || ""
  check("OPTIONS 預檢 → 204 且 allow-headers 含 authorization", preflight.status === 204 && allowHeaders.includes("authorization"), `${preflight.status} / ${allowHeaders}`)

  // 3) 路徑形狀（規則 5）：插件會填 <url>/chat/completions，不會自己補 /v1。
  const models = await call("/v1/models")
  check("GET /v1/models → 200 且宣告白名單模型", models.res.status === 200 && models.text.includes(ALLOWED_MODEL), models.res.status)
  const bare = await call("/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: ALLOWED_MODEL, messages: [{ role: "user", content: "1. hello" }] }),
  })
  check("裸 /chat/completions（插件的形狀）可用", bare.res.status === 200, `${bare.res.status} ${bare.text.slice(0, 120)}`)
  const unknown = await call("/nope")
  check("未知路徑由本地 404（不丟上游）", unknown.res.status === 404 && unknown.text.includes("本代理沒有這個路徑"), unknown.res.status)

  // 4) 模型閘（規則 1）與鑑權（規則 8）。
  const badModel = await call("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  })
  check("未知模型 → 400 且說明該用哪個", badModel.res.status === 400 && badModel.text.includes("只放行"), `${badModel.res.status} ${badModel.text.slice(0, 120)}`)
  const noAuth = await call("/v1/chat/completions", {
    method: "POST",
    // 標頭值要 ASCII，所以這把「錯 key」不能用中文
    headers: { authorization: "Bearer definitely-not-the-key" },
    body: JSON.stringify({ model: ALLOWED_MODEL, messages: [{ role: "user", content: "hi" }] }),
  })
  check("錯 key → 401（OpenAI 錯誤形狀）", noAuth.res.status === 401 && noAuth.text.includes('"error"'), noAuth.res.status)

  // 帶 system：上游對「只有編號句、沒有指令」的輸入會回多語言列表與前言（2026-10-10 重現），
  // 不會逐行對應。真實插件會帶翻譯指令，這裡照同樣形狀打，否則行對應的檢查測的不是真的協定。
  // （system 提示是自己寫的，不抄上游 README——規則 10。）
  const SYS = "你是一位專業翻譯員，把使用者給的文字逐行翻譯成自然、地道的繁體中文。只輸出譯文，不加說明、不換語言。"
  const msgs = (content) => [{ role: "system", content: SYS }, { role: "user", content }]

  // 5) 真正的翻譯：非串流客戶端（代理要自己組包）。
  const src = "1. The cat sleeps.\n2. The dog runs.\n3. The bird sings."
  const plain = await call("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: ALLOWED_MODEL, messages: msgs(src), target_translation: "Chinese" }),
  })
  let pj
  try {
    pj = JSON.parse(plain.text)
  } catch {
    pj = null
  }
  check("非串流 → 200 chat.completion", plain.res.status === 200 && pj?.object === "chat.completion", `${plain.res.status} ${plain.text.slice(0, 160)}`)
  check("翻譯有內容", (pj?.choices?.[0]?.message?.content || "").length > 0, JSON.stringify(pj?.choices?.[0]?.message?.content ?? ""))
  check("x-proxy-upstream-stream: forced（規則 3）", plain.res.headers.get("x-proxy-upstream-stream") === "forced", plain.res.headers.get("x-proxy-upstream-stream"))
  check("上游沒有回 <think>", !(pj?.choices?.[0]?.message?.content || "").includes("<think>"), "")

  // 6) 串流客戶端：行對應是插件的協定，3 行進、3 行出。
  const streamed = await call("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: ALLOWED_MODEL, stream: true, messages: msgs(src), target_translation: "Chinese" }),
  })
  const lines = sseData(streamed.text)
  const got = deltaContent(lines)
  check("串流 → 200 text/event-stream", streamed.res.status === 200 && (streamed.res.headers.get("content-type") || "").includes("text/event-stream"), streamed.res.status)
  check("[DONE] 只出現一次", lines.filter((d) => d === "[DONE]").length === 1, String(lines.filter((d) => d === "[DONE]").length))
  check("行數不減（3 行進 3 行出）", got.split("\n").length === 3, `${got.split("\n").length} 行：${JSON.stringify(got.slice(0, 120))}`)

  // 7) 切塊接回（規則 4）：超過 MAX_INPUT_CHARS 要在行界切、按原分隔接回。
  const longSrc = numbered(40)
  const long = await call("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: ALLOWED_MODEL, messages: msgs(longSrc), target_translation: "Chinese" }),
  })
  const lj = (() => {
    try {
      return JSON.parse(long.text)
    } catch {
      return null
    }
  })()
  const chunks = Number(long.res.headers.get("x-proxy-chunks") || "1")
  check("超長輸入 → 切成多塊（x-proxy-chunks ≥ 2）", chunks >= 2, `chunks=${chunks} status=${long.res.status}`)
  const outLines = (lj?.choices?.[0]?.message?.content || "").split("\n").filter((l) => l.trim())
  check("逐行還原（40 行不黏不缺）", outLines.length === 40, `${outLines.length}/40 行`)
  check("每行都真的被譯了（不是原樣回傳）", outLines.some((l) => !/^\d+\. This is line/.test(l)), outLines[0]?.slice(0, 80))

  // 8) 單行超長 → 本地 413（不硬切、不猜）。
  const oneLine = "這是一條很長的單行文字。".repeat(200)
  const tooLong = await call("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: ALLOWED_MODEL, messages: [{ role: "user", content: oneLine }] }),
  })
  check("單行超過上限 → 413 + 說明", tooLong.res.status === 413 && tooLong.text.includes("單行"), `${tooLong.res.status} ${tooLong.text.slice(0, 120)}`)

  // 9) 並發上限（規則 7）：並發打超過「閘 + 等待佇列」，多出來的必須被本地 429 擋下。
  //    注：SLOT_WAIT_MS 不為 0 時，少於佇列長度的並發會被**排隊**接住（那是正確的，不是 bug），
  //    所以要超出 2×MAX_INFLIGHT 才看得到 429。上游自己也會 429，因此只認帶我們標頭的那些。
  const inflight = await Promise.all(
    Array.from({ length: 12 }, () =>
      call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: ALLOWED_MODEL, messages: msgs("1. Hello."), target_translation: "Chinese" }) }),
    ),
  )
  const ours429 = inflight.filter((r) => r.res.status === 429 && r.res.headers.get("x-proxy-reason") === "concurrency")
  const upstream429 = inflight.filter((r) => r.res.status === 429 && r.res.headers.get("x-proxy-reason") !== "concurrency")
  check(
    "並發超過上限 → 本地 429 + Retry-After（非上游限流）",
    ours429.length > 0 && ours429.every((r) => r.res.headers.get("retry-after")),
    `本地 429：${ours429.length}，上游 429：${upstream429.length}`,
  )

  console.log(`\n${pass} ok / ${fail} fail（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  if (OUT) {
    mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true })
    writeFileSync(OUT, JSON.stringify({ base: BASE, at: stamp(), checks: results }, null, 2))
    console.log(`結果：${OUT}`)
  }
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error("探測失敗：", e?.message || e)
  console.error(`目標 ${BASE} 可達嗎？帶 --url 指定正確的 worker 網址。`)
  process.exitCode = 2
})
