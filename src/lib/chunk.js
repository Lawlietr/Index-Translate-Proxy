// 切塊（AGENTS.md 規則 4 ＋ design/streaming-and-chunking.md §1）。
// 只在**行界**切；單行本身超長才硬切。代理不重編、不刪編號——插件靠編號行把譯文對應回原文。
//
// 塊的語義：chunks[i].text **不含**尾端分隔字元，chunks[i].join 是「這一塊之前該補上的分隔字元」。
// 這樣輸入側拼回原文無損，輸出側也用同一個 join 插回去（§4）。

/** 逐行拆解，保留原始分隔字元（\r\n / \n / \r），拼接時才不會變形。 */
export function splitLines(text) {
  const out = []
  const re = /\r\n|\n|\r/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ line: text.slice(last, m.index), sep: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ line: text.slice(last), sep: "" })
  return out
}

/** 規則 4 的上限檢查：找出第一條超過 maxChars 的行（回 null 表示都在界內）。
 *  單行超長不在這裡切——由 worker 回 413，因為行內切會讓插件的編號對應錯位。 */
export function overLongLine(text, maxChars) {
  if (typeof text !== "string" || !Number.isFinite(maxChars)) return null
  const units = splitLines(text)
  for (let i = 0; i < units.length; i++) {
    if (units[i].line.length > maxChars) return { index: i, length: units[i].line.length }
  }
  return null
}

/** 原文主要用的分隔字元（取多數），用於報告與輸出側插回。 */
export function dominantSeparator(units) {
  const counts = new Map()
  for (const u of units) if (u.sep) counts.set(u.sep, (counts.get(u.sep) || 0) + 1)
  let best = "\n"
  let bestN = -1
  for (const [sep, n] of counts) if (n > bestN) { bestN = n; best = sep }
  return best
}

/** 依 join 欄重組（測試用的不變量：reassemble(plan) === 原文）。 */
export function reassemble(plan) {
  return plan.chunks.reduce((s, c, i) => s + (i === 0 ? "" : c.join) + c.text, "")
}

/**
 * 依字元上限把文字切塊，回 { chunks, totalLines, separator }。
 * chunks[i] = { text, lines, join } —— 行界切；單行超長時硬切，該處 join 為空字串。
 */
export function planChunks(text, maxChars) {
  const units = splitLines(text)
  const separator = dominantSeparator(units)
  const totalLines = units.length
  if (text.length <= maxChars) {
    return { chunks: [{ text, lines: totalLines, join: "" }], totalLines, separator }
  }

  const chunks = []
  let curText = ""
  let curLines = 0
  let curTrailingSep = "" // curText 尾端那段分隔字元（要從 text 裡去掉，改由下一塊的 join 承擔）
  let nextJoin = "" // 下一塊該補的分隔字元

  const flush = () => {
    if (!curText && !curLines) return
    if (curTrailingSep) curText = curText.slice(0, curText.length - curTrailingSep.length)
    chunks.push({ text: curText, lines: curLines, join: nextJoin })
    nextJoin = curTrailingSep || separator
    curText = ""
    curLines = 0
    curTrailingSep = ""
  }

  for (const u of units) {
    const piece = u.line + u.sep
    if (piece.length > maxChars) {
      // 單行本身超長：正常情況已在 worker 被 413 拦下（overLongLine），到這裡代表
      // MAX_LINE_CHARS 被設得比切塊上限還大——那種設定下只能硬切，切點兩邊不補字元。
      flush()
      let rest = u.line
      const pieces = []
      while (rest.length > maxChars) {
        pieces.push(rest.slice(0, maxChars))
        rest = rest.slice(maxChars)
      }
      pieces.push(rest)
      pieces.forEach((p, i) => {
        chunks.push({ text: p, lines: 1, join: i === 0 ? nextJoin : "" })
        nextJoin = ""
      })
      nextJoin = u.sep || ""
      continue
    }
    if (curText && (curText.length + piece.length) > maxChars) flush()
    curText += piece
    curLines += 1
    curTrailingSep = u.sep
  }
  flush()

  if (!chunks.length) chunks.push({ text: "", lines: 0, join: "" })
  return { chunks, totalLines, separator }
}

/** 輸出側：把各塊的譯文按原分隔字元接回（§4）。 */
export function joinOutputs(texts, plan) {
  return texts.reduce((s, t, i) => s + (i === 0 ? "" : plan.chunks[i].join) + t, "")
}

/**
 * 從 OpenAI 形狀的 body 找出「要被切的那段文字」：最後一則 user 訊息的 content（字串）。
 * 其他 role（system / assistant）不動；content 不是字串（多模態陣列）就不切。
 */
export function findTranslatable(body) {
  if (!body || !Array.isArray(body.messages)) return null
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i]
    if (msg && msg.role === "user" && typeof msg.content === "string") {
      return { index: i, content: msg.content }
    }
  }
  return null
}

/** 第 i 塊的請求 body：只換掉那段 content，其他欄位原樣（規則 9 只準協定層注入）。 */
export function bodyForChunk(original, target, plan, i) {
  const messages = original.messages.slice()
  messages[target.index] = { ...messages[target.index], content: plan.chunks[i].text }
  return { ...original, messages }
}
