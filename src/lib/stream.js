// 串流（AGENTS.md 規則 3 ＋ design/streaming-and-chunking.md §4）。
// 對上游一律要串流；客戶端不要串流時由我們把 SSE 組回單一 chat.completion。

const DONE = "[DONE]"

/** 從一個事件區塊裡取出 data 欄（多行 data 依 SSE 規則用 \n 串接）。 */
function dataLines(block) {
  const out = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) out.push(line.slice(5).replace(/^ /, ""))
    // event: / id: / retry: 這個代理不需要，但 data 以外的東西也不影響內容。
  }
  return out
}

/** 把 SSE 位元流拆成一個個事件的 data 字串。用 reader（不依賴 async iterator 支援）。 */
export async function* parseSSE(body) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let m
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const block = buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
      const data = dataLines(block)
      if (data.length) yield data.join("\n")
    }
  }
  buf += decoder.decode()
  const tail = dataLines(buf)
  if (tail.length) yield tail.join("\n")
}

/** 事件分類：[DONE] / JSON / 其他（原樣保留，不猜）。 */
export function parseData(data) {
  if (data === DONE) return { kind: "done" }
  try {
    return { kind: "json", obj: JSON.parse(data) }
  } catch {
    return { kind: "raw", text: data }
  }
}

export function deltaText(obj) {
  const c = obj && obj.choices && obj.choices[0]
  return (c && c.delta && typeof c.delta.content === "string" ? c.delta.content : "") || ""
}

export function finishReasonOf(obj) {
  const c = obj && obj.choices && obj.choices[0]
  return (c && c.finish_reason) || null
}

export function usageOf(obj) {
  return obj && obj.usage && typeof obj.usage === "object" ? obj.usage : null
}

export function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/**
 * 串流已經開始後就改不了 status（design/streaming-and-chunking.md §3）：
 * 這時候唯一的通道是在流裡放一個 error 框架，讓客戶端至少看得見失敗原因。
 */
export function errorFrame(message, { type = "upstream_error", code } = {}) {
  return sseFrame({ error: { message, type, code } })
}

export const SSE_DONE = `data: ${DONE}\n\n`

/**
 * 塊與塊之間必須插入「原分隔字元」的 delta，否則拼回去時兩塊的第一/末行會黏在一起（§4）。
 * 用上游给的那個 id／model，看起來就是同一個回應的延續。
 */
export function separatorChunk(template, sep) {
  return {
    id: template?.id,
    object: template?.object || "chat.completion.chunk",
    created: template?.created,
    model: template?.model,
    choices: [{ index: 0, delta: { content: sep }, logprobs: null, finish_reason: null }],
  }
}

/**
 * `<think>` 的防禦性剝離：只做前綴處理，丟掉 `<think>` 到 `</think>` 之間的內容。
 * 不做「刪掉 `</think>` 之前所有文字」那種激進剝離（官方橋的寫法）——那會把編號行一起吃掉，
 * 破壞插件的行對應。上游公網端點實測不吐思考標記，這段純粹是換端點時的保險。
 */
export class ThinkStripper {
  constructor() {
    this.open = "<think>"
    this.close = "</think>"
    this.pending = ""
    this.inside = false
  }

  push(text) {
    if (!text) return ""
    let out = ""
    this.pending += text
    while (this.pending) {
      if (this.inside) {
        const i = this.pending.indexOf(this.close)
        if (i === -1) {
          // 只留可能是 `</think>` 前綴的尾巴，其他丟掉。
          const keep = partialSuffixLen(this.pending, this.close)
          this.pending = this.pending.slice(this.pending.length - keep)
          break
        }
        this.pending = this.pending.slice(i + this.close.length)
        this.inside = false
        continue
      }
      const i = this.pending.indexOf(this.open)
      if (i !== -1) {
        out += this.pending.slice(0, i)
        this.pending = this.pending.slice(i + this.open.length)
        this.inside = true
        continue
      }
      const keep = partialSuffixLen(this.pending, this.open)
      out += this.pending.slice(0, this.pending.length - keep)
      this.pending = this.pending.slice(this.pending.length - keep)
      break
    }
    return out
  }

  /** 流結束：沒閉合的 `<think>` 之後的內容照樣吐出來（不吞使用者的字）。 */
  end() {
    const out = this.pending
    this.pending = ""
    return out
  }
}

/** s 的尾巴有多長可能是 pat 的開頭？（用於延後輸出，避免把標記切一半） */
function partialSuffixLen(s, pat) {
  const max = Math.min(s.length, pat.length - 1)
  for (let k = max; k > 0; k--) {
    if (s.endsWith(pat.slice(0, k))) return k
  }
  return 0
}

/**
 * 非串流客戶端：把多塊的 SSE 組回單一 chat.completion。
 * 規則（§4）：content 依原分隔字元串接；finish_reason 取最後一塊；
 * **usage 各塊都有才加總，任一塊缺就不帶**——不造假數字。
 */
export function assembleCompletion(parts, { model, id, created, joins = [] }) {
  const content = parts.map((p, i) => (i === 0 ? "" : joins[i] ?? "") + p.content).join("")
  const last = parts[parts.length - 1] || {}
  const out = {
    id: id || parts.find((p) => p.id)?.id || "chatcmpl-itp",
    object: "chat.completion",
    created: created || parts.find((p) => p.created)?.created || Math.floor(Date.now() / 1000),
    model: model || last.model || parts.find((p) => p.model)?.model || "",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: null,
        // 取最後一塊：中間塊被 max_tokens 截斷過的話，由 worker 另加 x-proxy-chunk-truncated 標頭。
        finish_reason: last.finish_reason ?? "stop",
      },
    ],
  }
  const all = parts.map((p) => p.usage)
  if (all.length && all.every((u) => u)) {
    const sum = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    for (const u of all) {
      sum.prompt_tokens += u.prompt_tokens || 0
      sum.completion_tokens += u.completion_tokens || 0
      sum.total_tokens += u.total_tokens || 0
    }
    const details = all.map((u) => u.prompt_tokens_details).find((d) => d)
    if (details) sum.prompt_tokens_details = details
    out.usage = sum
  }
  return out
}
