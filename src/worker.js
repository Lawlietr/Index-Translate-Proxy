// Index-Translate-Proxy — Cloudflare Worker 入口。
// 流程順序是定的（design/auth.md 定案 4）：OPTIONS → 根路徑／路徑檢查 → 鑑權 → 並發閘 → 切塊／強制串流／轉發。
// 順序錯了會踩坑：鑑權要在任何上游請求之前，401 才不會消耗上游配額。

import { resolvePathname, isChatPath, rootDescription } from "./lib/route.js"
import {
  UPSTREAM_ORIGIN,
  upstreamHeaders,
  corsHeaders,
  mergeHeaders,
  localError,
  hintHeader,
  hintForStatus,
  maxTokensCeilingHint,
  proxyHeaders,
} from "./lib/headers.js"
import { checkAuth, checkAuthRateLimit, authConfigured, authMode, clientIp } from "./lib/auth.js"
import { withBuildMarker } from "./lib/build-info.js"
import { readLimits, getGate, gateFullResponse, UPSTREAM_MAX_TOKENS_CEILING } from "./lib/limits.js"
import { ALLOWED_MODEL, ALLOWED_MODELS, modelsPayload, modelNotAllowed, modelNotAllowedMessage } from "./lib/model.js"
import { findTranslatable, planChunks, bodyForChunk, overLongLine } from "./lib/chunk.js"
import {
  parseSSE,
  parseData,
  deltaText,
  finishReasonOf,
  usageOf,
  sseFrame,
  SSE_DONE,
  errorFrame,
  separatorChunk,
  ThinkStripper,
  assembleCompletion,
} from "./lib/stream.js"

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }
const ENC = new TextEncoder()

export default {
  async fetch(request, env) {
    // **所有**回應都加上建置標記（知道的時候；不知道就不帶，不造假）。
    // 為什麼要在這裡做而不是在各個回應點：排程探測紅的時候多半就是 401／404／429 這些本地錯誤，
    // 標記只在正常回應上等於沒有（AGENTS 規則 13）。複製標頭不碰 body，串流不受影響。
    return withBuildMarker(await handle(request, env), env)
  },
}

/** 協定主流程：OPTIONS → 根路徑／路徑檢查 → 鑑權 → 併發閘 → 切塊／強制串流／轉發。 */
async function handle(request, env) {
  const url = new URL(request.url)
  const route = resolvePathname(url.pathname)

  // 1) 預檢：不鑑權。allow-headers 少了 authorization，插件只會報 CORS 失敗、不會告訴你原因。
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  // 2) 根路徑：一行說明 + x-proxy-auth，讓部署者開根路徑就知道自己有沒有設 key（不碰上游）。
  if (route.kind === "root") {
    if (request.method !== "GET") return localError(404, "這個路徑不存在")
    const mode = authMode(env)
    return new Response(rootDescription(url.host, mode, ALLOWED_MODELS), {
      status: 200,
      headers: mergeHeaders(corsHeaders(), {
        "content-type": "text/plain; charset=utf-8",
        "x-proxy-auth": mode,
      }),
    })
  }

  // 3) 其他未知路徑一律本地 404（丟給上游只是白費一次配額）。
  if (route.kind !== "upstream") {
    return localError(
      404,
      `本代理沒有這個路徑：${url.pathname}。可用的是 /v1/chat/completions、/v1/models、/v1/responses（或同樣的 /api/… 寫法）`,
    )
  }

  // 4) 鑑權（規則 8）。失敗走獨立限流，免得亂試 key 把正常請求擠掉。
  const auth = await checkAuth(request, env)
  if (!auth.ok) {
    log({ req: "auth", ip: clientIp(request), result: auth.reason })
    const rl = await checkAuthRateLimit(request, env)
    if (!rl.ok) return rl.response
    return auth.response
  }

  // 4b) `GET /v1/models` 由本代理**自己回**放行清單（不佔 slot、不花上游配額）。
  // 上游那份只宣告 35B-A3B，照它回會舆本代理實際放行的不一致（design/model-allowlist.md）。
  if (route.path === "/v1/models") {
    if (request.method !== "GET") {
      return new Response(null, { status: 405, headers: mergeHeaders(corsHeaders(), { allow: "GET" }) })
    }
    return new Response(JSON.stringify(modelsPayload()), {
      status: 200,
      headers: mergeHeaders(corsHeaders(), { "content-type": "application/json; charset=utf-8" }),
    })
  }

  // 5) 並發閘（規則 7）：一個請求從進到出持有一個 slot（切塊是依序的，同時只有一塊在途）。
  // 閘滿時先**在本地排隊**，等不到才 429（design/streaming-and-chunking.md §2）。
  const limits = readLimits(env)
  const gate = getGate(limits.maxInflight)
  const waitT0 = Date.now()
  if (!(await gate.waitForSlot(limits.slotWaitMs))) {
    log({
      req: "gate-full",
      path: route.path,
      limit: limits.maxInflight,
      waitedMs: Date.now() - waitT0,
    })
    return gateFullResponse()
  }

  // 串流路徑會把 slot 交給 controller 釋放，所以這裡用 transferred 決定要不要在此釋放。
  let transferred = false
  try {
    const out = isChatPath(route.path)
      ? await handleChat(request, route, limits, () => gate.release())
      : await handlePassthrough(request, route)
    transferred = out.transferred === true
    return out.response
  } finally {
    if (!transferred) gate.release()
  }
}

/** 結構化日誌（design/streaming-and-chunking.md §6）：只有 `wrangler tail` 讀得到的事實，沒有面板。 */
function log(fields) {
  console.log(JSON.stringify({ proxy: "index-translate-proxy", ...fields }))
}

/** 給上游的 POST：只帶 content-type 與 UA（規則 8）。 */
function postUpstream(path, body) {
  return fetch(`${UPSTREAM_ORIGIN}${path}`, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify(body),
  })
}

/** 只透傳：/v1/models（GET）與 /v1/responses（不組包、不切塊、不注入——規則 5）。 */
async function handlePassthrough(request, route) {
  const get = request.method === "GET" || request.method === "HEAD"
  const headers = get
    ? { "user-agent": upstreamHeaders()["user-agent"] }
    : upstreamHeaders()
  const upstream = await fetch(`${UPSTREAM_ORIGIN}${route.path}`, {
    method: request.method,
    headers,
    body: get ? undefined : request.body,
  })
  return { response: forwardUpstream(upstream, route.path, {}) }
}

/**
 * 規則 9：只準這四項**協定層**注入，不碰 prompt 內容。
 * 客戶端自己帶 max_tokens（或兩種別名）就不覆蓋。
 */
function injectProtocolDefaults(body, limits) {
  const clientSetMaxTokens =
    body.max_tokens != null || body.max_completion_tokens != null || body.max_output_tokens != null
  const out = {
    ...body,
    stream: true, // 規則 3
    stream_options: { ...(body.stream_options || {}), include_usage: true },
    chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false },
  }
  if (!clientSetMaxTokens) out.max_tokens = limits.maxTokensDefault
  return { body: out, clientSetMaxTokens }
}

/** 翻譯請求的主路徑（/v1/chat/completions）。`releaseGate` 只有在走串流時才交辦給 controller。 */
async function handleChat(request, route, limits, releaseGate) {
  let body
  try {
    body = await request.json()
  } catch {
    return { response: localError(400, "請求 body 必須是 JSON 物件") }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: localError(400, "請求 body 必須是 JSON 物件") }
  }

  // 規則 1：不換模型、不降級 —— 本地就擋下，不消耗上游配額。
  if (modelNotAllowed(body.model)) {
    return { response: localError(400, modelNotAllowedMessage(body.model), { param: "model" }) }
  }

  const clientWantsStream = body.stream === true
  const target = findTranslatable(body)

  // 規則 4 的邊界：**單行**本身超過 MAX_LINE_CHARS → 413。
  // 行內切會破掉插件的編號行對應，所以不切、不猜，直接講清楚怎麼繞過（design §1）。
  const over = overLongLine(target?.content, limits.maxLineChars)
  if (over) {
    log({ req: "line-too-long", path: route.path, line: over.index + 1, length: over.length, limit: limits.maxLineChars })
    return {
      response: localError(
        413,
        `第 ${over.index + 1} 行有 ${over.length} 字元，超過單行上限 ${limits.maxLineChars}。本代理只在行界切塊（行內切會讓編號錯位），請把這行拆短後重送，或調高 MAX_LINE_CHARS。`,
      ),
    }
  }

  const plan = target
    ? planChunks(target.content, limits.maxInputChars)
    : { chunks: [{ text: "", lines: 0, join: "" }], totalLines: 0, separator: "\n" }

  // 每塊都是「原 body 換掉那段 content」再套協定層注入；其他欄位原樣（規則 9）。
  const probe = injectProtocolDefaults(body, limits)
  const clientSetMaxTokens = probe.clientSetMaxTokens
  // 上游對 max_tokens 有一個**靜默**的硬上限（實測：要 16,384 只給恰好 4,096 + finish_reason:"length"，
  // tests/fixtures/ceiling-16384.summary.json）。規則 9 不覆蓋客戶端的值，所以只在標頭把事實講清楚（規則 6）——
  // 否則使用者只看到「尾部少了」，會以為是我們切塊切掉的。
  const requestedMaxTokens = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].find(
    (v) => typeof v === "number" && Number.isFinite(v),
  )
  const ceilingHint = maxTokensCeilingHint(requestedMaxTokens, UPSTREAM_MAX_TOKENS_CEILING)
  const bodies = target
    ? plan.chunks.map((_, i) => injectProtocolDefaults(bodyForChunk(body, target, plan, i), limits).body)
    : [probe.body]
  const total = bodies.length
  const joins = plan.chunks.map((c) => c.join)
  const linesBefore = (i) => plan.chunks.slice(0, i).reduce((n, c) => n + (c.lines || 0), 0)

  // 單塊 body 上限：自己先給可讀的 413，不讓它在上游側變成逾時或不明錯誤。
  for (let i = 0; i < bodies.length; i++) {
    const bytes = ENC.encode(JSON.stringify(bodies[i])).length
    if (bytes > limits.maxBodyBytes) {
      log({ req: "body-too-large", path: route.path, chunk: `${i + 1}/${total}`, bytes, limit: limits.maxBodyBytes })
      return {
        response: localError(
          413,
          `要送上游的第 ${i + 1} 塊 body 有 ${bytes} bytes，超過上限 ${limits.maxBodyBytes}。請減少一次請求的內容（縮短 text 或 messages），或調高 MAX_BODY_BYTES。`,
        ),
      }
    }
  }

  const t0 = Date.now()
  let first
  try {
    first = await postUpstream(route.path, bodies[0])
  } catch (err) {
    log({ req: "upstream-connect-error", path: route.path, error: String(err?.message || err) })
    return {
      response: localError(502, `連不上上游：${String(err?.message || err)}（本代理不重試，避免重複消耗配額）`, {
        type: "upstream_unavailable",
        code: 502,
      }),
    }
  }

  if (!first.ok) {
    log({ req: "upstream-status", path: route.path, chunk: `1/${total}`, status: first.status, ms: Date.now() - t0 })
    // 規則 6：不改 status、不改 body；建議放 x-proxy-hint。
    return {
      response: forwardUpstream(first, route.path, {
        chunks: total > 1 ? total : undefined,
        chunkFailed: total > 1 ? "1/" + total : undefined,
        chunkLines: 0,
        modelWhitelist: true,
      }),
    }
  }

  if (clientWantsStream) {
    // 標頭即將送出，之後的塊失敗只能在流裡說明（design §3 的邊界）。slot 交給 controller 釋放。
    const response = streamResponse({
      first,
      rest: bodies.slice(1),
      joins,
      total,
      path: route.path,
      clientSetMaxTokens,
      ceilingHint,
      linesBefore,
      t0,
      onDone: releaseGate,
    })
    return { response, transferred: true }
  }

  // 非串流客戶端：逐塊收完，再組回單一 chat.completion（規則 3）。
  const parts = [await collect(first)]
  let truncatedChunk = null
  for (let i = 1; i < total; i++) {
    let res
    try {
      res = await postUpstream(route.path, bodies[i])
    } catch (err) {
      log({ req: "upstream-connect-error", path: route.path, chunk: `${i + 1}/${total}`, error: String(err?.message || err) })
      return {
        response: localError(502, `連不上上游（第 ${i + 1}/${total} 塊）：${String(err?.message || err)}。已送出的塊不保留（不回部分譯文）。`, {
          type: "upstream_unavailable",
          code: 502,
        }),
      }
    }
    if (!res.ok) {
      log({ req: "upstream-status", path: route.path, chunk: `${i + 1}/${total}`, status: res.status })
      // §3：沿用失敗塊的 status，並標明是哪一塊、之前已成功幾行。
      return {
        response: forwardUpstream(res, route.path, {
          chunks: total,
          chunkFailed: `${i + 1}/${total}`,
          chunkLines: linesBefore(i),
        }),
      }
    }
    const part = await collect(res)
    if (part.finish_reason === "length" && !clientSetMaxTokens) truncatedChunk = i + 1
    parts.push(part)
  }

  const completion = assembleCompletion(parts, { model: body.model || ALLOWED_MODEL, joins })
  log({
    req: "ok",
    path: route.path,
    chunks: `${total}/${total}`,
    ms: Date.now() - t0,
    truncated: truncatedChunk || undefined,
    usage: completion.usage ? { tokens: completion.usage.total_tokens } : undefined,
  })
  return {
    response: new Response(JSON.stringify(completion), {
      status: 200,
      headers: mergeHeaders(
        corsHeaders(),
        JSON_HEADERS,
        hintHeader(ceilingHint),
        proxyHeaders({
          upstreamStreamForced: true,
          chunks: total > 1 ? total : undefined,
          chunkTruncated: truncatedChunk || undefined,
        }),
      ),
    }),
  }
}

/** 收完一塊 SSE，回組包用的片段。 */
async function collect(response) {
  const part = { content: "", finish_reason: null, usage: null, id: null, model: null, created: null }
  const stripper = new ThinkStripper()
  for await (const data of parseSSE(response.body)) {
    const ev = parseData(data)
    if (ev.kind === "done") continue
    if (ev.kind !== "json") continue
    if (!part.id && ev.obj.id) part.id = ev.obj.id
    if (!part.model && ev.obj.model) part.model = ev.obj.model
    if (!part.created && ev.obj.created) part.created = ev.obj.created
    part.content += stripper.push(deltaText(ev.obj))
    const fr = finishReasonOf(ev.obj)
    if (fr) part.finish_reason = fr
    const u = usageOf(ev.obj)
    if (u) part.usage = u
  }
  part.content += stripper.end()
  return part
}

/**
 * 串流路徑：逐塊透傳；塊之間插入「原分隔字元」的 delta（§4）；`[DONE]` 只在最後給一次。
 * 第一塊已成功 → status 一定是 200，後面的塊失敗只能寫在流裡（design §3 的邊界）。
 */
function streamResponse({ first, rest, joins, total, path, clientSetMaxTokens, ceilingHint, linesBefore, t0, onDone }) {
  let template = null // 用上游给的 id/model/created 造分隔 delta，看起來是同一個回應的延續
  let doneChunks = 0
  let truncated = null

  const stream = new ReadableStream({
    async start(controller) {
      /** 透傳一塊的 SSE：不改 content 以外的欄位；只在需要剝離 <think> 時重寫那個欄位。 */
      async function pump(response, chunkNo) {
        const stripper = new ThinkStripper()
        for await (const data of parseSSE(response.body)) {
          const ev = parseData(data)
          if (ev.kind === "done") continue // [DONE] 由外層統一給一次
          if (ev.kind === "raw") {
            controller.enqueue(ENC.encode(`data: ${data}\n\n`))
            continue
          }
          const obj = ev.obj
          if (!template && obj.id) template = { id: obj.id, model: obj.model, created: obj.created }
          // 規則 4：finish_reason:"length" 是尾部被截的唯一訊號。串流補不了標頭，只能進日誌。
          if (finishReasonOf(obj) === "length" && !clientSetMaxTokens) truncated = chunkNo
          const text = deltaText(obj)
          if (text) {
            const clean = stripper.push(text)
            if (clean !== text) {
              obj.choices[0].delta.content = clean // 只有被剝離時才重寫這個欄位
              controller.enqueue(ENC.encode(sseFrame(obj)))
              continue
            }
          }
          controller.enqueue(ENC.encode(`data: ${data}\n\n`))
        }
        const tailText = stripper.end()
        if (tailText && template) {
          controller.enqueue(
            ENC.encode(sseFrame({ ...template, choices: [{ index: 0, delta: { content: tailText }, finish_reason: null }] })),
          )
        }
        doneChunks += 1
      }

      try {
        await pump(first, 1)
        let i = 1
        for (const body of rest) {
          // 插入原分隔字元，否則兩塊的第一/末行會黏在一起（硬切處 joins[i] 為空字串，不插）。
          if (joins[i]) controller.enqueue(ENC.encode(sseFrame(separatorChunk(template, joins[i]))))
          const res = await postUpstream(path, body)
          if (!res.ok) {
            controller.enqueue(
              ENC.encode(
                errorFrame(`第 ${i + 1}/${total} 塊失敗（上游 ${res.status}）。已送出的部分不補償，本代理不重試。`, {
                  type: "upstream_error",
                  code: res.status,
                }),
              ),
            )
            log({ req: "chunk-failed", path, chunk: `${i + 1}/${total}`, status: res.status, lines: linesBefore(i) })
            break
          }
          await pump(res, i + 1)
          i += 1
        }
        controller.enqueue(ENC.encode(SSE_DONE))
        log({ req: "ok-stream", path, chunks: `${doneChunks}/${total}`, ms: Date.now() - t0, truncated: truncated || undefined })
      } catch (err) {
        controller.enqueue(ENC.encode(errorFrame(`串流中斷：${String(err?.message || err)}`)))
        log({ req: "stream-error", path, error: String(err?.message || err) })
      } finally {
        controller.close()
        onDone() // 串流的並發 slot 在這裡釋放，不是在 fetch 的 finally。
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: mergeHeaders(corsHeaders(), {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-proxy-upstream-stream": "forced",
      "x-proxy-chunks": total > 1 ? total : undefined,
      // 串流客戶看得到 finish_reason，但看不到「為什麼被截」→ 同一個 hint 也要給他們。
    }, hintHeader(ceilingHint)),
  })
}

/** 上游回應原樣透傳：status 與 body 不動，只補 CORS／hint／除錯標頭（規則 6、7）。 */
function forwardUpstream(upstream, path, extra) {
  const status = upstream.status
  const headers = mergeHeaders(
    corsHeaders(),
    {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "retry-after": upstream.headers.get("retry-after") || undefined,
    },
    status >= 400
      ? hintHeader(hintForStatus(status, { path, modelWhitelist: extra.modelWhitelist === true }))
      : undefined,
    proxyHeaders({ upstreamStreamForced: true, ...extra }),
  )
  return new Response(upstream.body, { status, headers })
}
