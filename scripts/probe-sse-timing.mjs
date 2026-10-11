// 串流**時序**探測：確認「真增量到客戶端」，不是只確認 content-type。
// 為什麼另開一支：本機用 JS fetch 量曾出現「所有塊同一瞬間抵達」的假象（client 端合併），
// 所以這支用 curl 當 client（2026-10-10 兩邊對照過）。跑法：
//   node scripts/probe-sse-timing.mjs [url] [--key …] [--tokens N]
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith("--"))
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const BASE = positional[0] || (positional.length ? positional[0] : "http://127.0.0.1:8787")
const KEY = flag("key", process.env.ITP_KEY || (process.env.ITP_KEY_FILE ? readFileSync(process.env.ITP_KEY_FILE, "utf8").trim() : ""))
const TOKENS = Number(flag("tokens", "900"))
const MIN_SPREAD_MS = Number(flag("min-spread", "800"))

const words = ["morning", "evening", "last", "slow", "empty", "quiet", "long", "dark", "cold", "warm", "broken", "final"]
const body = JSON.stringify({
  model: "Index-Translate-35B-A3B",
  stream: true,
  max_tokens: TOKENS,
  messages: [
    { role: "system", content: "把每一行譯成繁體中文，保留編號，每行多加一句描述。" },
    { role: "user", content: Array.from({ length: 12 }, (_, i) => `${i + 1}. The ${words[i]} train arrived at the platform.`).join("\n") },
  ],
})

function curlLines(args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const stamps = []
    const p = spawn("curl", ["-sN", "-m", "120", ...args])
    let buf = ""
    p.stdout.on("data", (chunk) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) stamps.push({ ms: Date.now() - t0, line })
      }
    })
    p.stderr.on("data", (c) => process.stderr.write(c))
    p.on("error", reject)
    p.on("close", (code) => (code === 0 ? resolve(stamps) : reject(new Error(`curl 退出 ${code}`))))
  })
}

function judge(label, stamps) {
  if (!stamps.length) {
    console.log(`  FAIL ${label}：沒收到任何行`)
    return false
  }
  const first = stamps[0].ms
  const last = stamps.at(-1).ms
  const spread = last - first
  // 門檻要跟著**增量數**走，不能是一個固定的毫秒數（2026-10-11 踩到）：生成 80 個 delta 在上游只要 610ms
  // 是正常的（83 行 ≈ 7ms/行），固定 800ms 会把「很快但真的增量」誤判成緩衝。
  // 要判的是「有沒有分批抵達」：以每行至少 6ms 的間距當下限。地板用 250ms，不用 MIN_SPREAD_MS——
  // 要抓的那種緩衝是「72 個塊同一瞬間抵達」（Vercel Node runtime 實測，span ≈ 0），250ms 就分得出來；
  // 把預設的 800ms 當地板反而會誤傷短輸出。MIN_SPREAD_MS 變成可調參數（--min-spread）。
  const floor = Math.min(MIN_SPREAD_MS, 250)
  const need = Math.max(floor, (stamps.length - 1) * 6)
  const ok = spread >= need
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}：${stamps.length} 行｜首块 +${first}ms｜末块 +${last}ms｜跨度 ${spread}ms（需 ≥${need}ms，地板 ${floor}ms）`)
  return ok
}

let pass = 0
let fail = 0
const run = (name, ok) => (ok ? pass++ : fail++)

console.log(`串流時序探測：${BASE}（client=curl，max_tokens=${TOKENS}）`)
run("基准：上游直連", judge("上游 index-translate.bilibili.com（不經代理）", await curlLines([
  "-X", "POST", "https://index-translate.bilibili.com/v1/chat/completions",
  "-H", "content-type: application/json",
  "-H", "user-agent: Index-Translate-Proxy/0.1 (timing probe; script)",
  "-d", body,
])))
run("代理", judge(`${BASE}（本代理）`, await curlLines([
  "-X", "POST", `${BASE.replace(/\/$/, "")}/v1/chat/completions`,
  "-H", "content-type: application/json",
  ...(KEY ? ["-H", `authorization: Bearer ${KEY}`] : []),
  "-d", body,
])))

console.log(`\n${pass} ok / ${fail} fail`)
if (fail) process.exitCode = 1
