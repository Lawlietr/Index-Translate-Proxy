// Vercel **Node runtime** 的平台橋（备用入口，不是线上那个）。
// 線上入口是 api/index.js（Edge runtime，原生串流）。為什麼不用 Node：2026-10-10 實測
// Vercel 的 Node 函式會把 SSE **整批緩衝**後才送到客戶端（72 個塊在同一瞬間抵達），
// 而 Edge runtime 是真增量。證據與討論見 design/egress-options.md。
// 這份橋留著的原因：①離線測試用它跑真的 req/res 路徑；②未來若要自架 Node 或換平台，直接可用。
// 協定決定仍全在 src/worker.js —— 這裡只做平台差異。
import { Readable } from "node:stream"
import worker from "../worker.js"
import { localError } from "./headers.js"
import { memoryRateLimit } from "./limits.js"

/** 原始請求體的硬性上限。真正的上游塊大小由 MAX_BODY_BYTES 守（規則 4），這裡只擋不合理的超大 payload。 */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024

/** hop-by-hop／由 URL 決定的標頭：不帶進 Request（undici 會自己處理或不接受）。 */
const SKIP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host",
])

/** Node 的 IncomingMessage → Web 的 Request。IP 不在這裡處理：`clientIp()` 有一份跨平台的讀取順序。 */
export async function toWebRequest(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost"
  const proto = req.headers["x-forwarded-proto"] || "https"
  const url = new URL(req.url || "/", `${proto}://${host}`)

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (SKIP_HEADERS.has(name.toLowerCase())) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, String(value))
  }

  const method = (req.method || "GET").toUpperCase()
  const init = { method, headers }
  if (method !== "GET" && method !== "HEAD") init.body = await readBody(req)
  return new Request(url, init)
}

/** 讀完 Node 的請求體（有上限）。回 Buffer；沒有任何位元組時回 undefined，讓 GET/HEAD 不帶 body。 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const part of req) {
    total += part.length
    if (total > MAX_REQUEST_BYTES) {
      const err = new Error("request_too_large")
      err.code = "request_too_large"
      throw err
    }
    chunks.push(part)
  }
  return total ? Buffer.concat(chunks) : undefined
}

/** Web 的 Response → Node 的 ServerResponse。**逐塊寫出**，不要把 SSE 收完再回。 */
export async function sendWebResponse(response, res) {
  for (const [name, value] of response.headers.entries()) {
    // content-length 交給 Node 側自己算（串流時不該有；有 length 也會讓某些中介層開始緩衝）。
    if (name.toLowerCase() === "content-length") continue
    res.setHeader(name, value)
  }
  res.writeHead(response.status)
  if (!response.body) {
    res.end()
    return
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body)
    stream.on("error", reject)
    res.on("error", reject)
    res.on("close", resolve)
    stream.pipe(res)
  })
}

/** Node runtime 的入口本體（(req, res) 形狀）。Vercel 上的正式入口是 Edge runtime，見 api/index.js。 */
export async function nodeHandler(req, res, envOverrides = {}) {
  let request
  try {
    request = await toWebRequest(req)
  } catch (err) {
    if (err && err.code === "request_too_large") {
      await sendWebResponse(
        localError(413, `請求體超過 ${MAX_REQUEST_BYTES} bytes。請減少一次請求的內容（這個上限是本地防護，不是上游的）。`),
        res,
      )
      return
    }
    throw err
  }

  const env = { ...process.env, ...envOverrides }
  // CF 有 `[[ratelimits]]` 綁定；Vercel／Node 沒有 → 用同介面的純記憶體版補上（僅覆蓋單一實例）。
  if (!env.AUTH_RL) {
    const limit = Number(env.AUTH_RL_LIMIT || 30)
    env.AUTH_RL = memoryRateLimit({ limit: Number.isFinite(limit) ? limit : 30, period: 60 })
  }

  let response
  try {
    response = await worker.fetch(request, env)
  } catch (err) {
    // 兜底：上游連不上／失敗的 status 在 worker 內已經如實回了（規則 6），走到這裡代表是我們的 bug。
    console.log(JSON.stringify({ proxy: "index-translate-proxy", req: "unhandled-error", path: request.url, error: String(err?.message || err) }))
    response = localError(500, `代理內部錯誤：${String(err?.message || err)}`)
  }
  await sendWebResponse(response, res)
}
