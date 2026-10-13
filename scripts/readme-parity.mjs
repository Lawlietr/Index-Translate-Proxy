#!/usr/bin/env node
// README.md（繁中）與 README.en.md 的結構對等檢查。
// 兩份是同一份文件的兩個語言版本 → 章節順序、表格行列、指令、連結、程式碼塊都必須一致；
// 只有散文（標題文字、表格的文字欄位、程式碼註解）可以不同。漏同步其中一份時這條會擋下來。
import { readFileSync } from "node:fs"

// 預設比對 repo 根目錄那對；帶兩個路徑就能比對其他成對的 README
// （例如 `.agents/skills/*/README.md`）——同一個檢查器，不只根目錄那份受保護。
const ARGV = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const FILES = ARGV.length === 2 ? ARGV : ["README.md", "README.en.md"]
// 佔位符在兩種語言裡字面不同，但意義相同
const PLACEHOLDERS = [
  [/<你的專案>/g, "<PROJECT>"],
  [/<your-project>/g, "<PROJECT>"],
  [/<你的 ITP_KEY>/g, "<KEY>"],
  [/<your ITP_KEY>/g, "<KEY>"],
  [/<你的網址>/g, "<URL>"],
  [/<your-url>/g, "<URL>"],
]
// 部署按鈕的 envDescription 與 envLink 本來就各語言一份（指向自己那份 README）
const LOCALIZED_URL = [
  [/([?&])envDescription=[^&)]*/g, "$1envDescription=<LOCALIZED>"],
  [/([?&])envLink=[^&)]*/g, "$1envLink=<SELF>"],
]
const localizeUrl = (line) => {
  let out = line
  for (const [re, to] of LOCALIZED_URL) out = out.replace(re, to)
  return out
}
const stripInlineComment = (line) => line.replace(/\s+#\s.*$/, "")
const applyPlaceholders = (text) => {
  let out = text
  for (const [re, to] of PLACEHOLDERS) out = out.replace(re, to)
  return out
}
const normalizeCode = (line) => {
  return applyPlaceholders(localizeUrl(stripInlineComment(line.trim())))
}
// 表格某一行的「身份」＝ 裡面的代幣（`MAX_INFLIGHT`、`x-proxy-hint`、401…），與語言無關
const rowIdentity = (raw) => {
  const row = applyPlaceholders(localizeUrl(raw))
  const codes = [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  const numbers = [...row.matchAll(/(?<![\w.])\d{2,6}(?![\w.])/g)].map((m) => m[0])
  return [...codes, ...numbers.sort()].join(" ")
}

function structure(text) {
  // 空行要留著：散文段落數就是靠空行切出來的
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out = { headings: [], tables: [], code: [], fences: 0, links: [], details: 0, imgs: [], numbers: [], prose: [] }
  let inCode = false
  let table = null
  let section = "(最前面)"
  let blankBefore = true
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      blankBefore = true
      table = null
      continue
    }
    if (line.startsWith("```")) {
      inCode = !inCode
      out.fences++
      blankBefore = true
      continue
    }
    if (inCode) {
      if (!/^\s*#/.test(line)) out.code.push(normalizeCode(line))
      continue
    }
    if (/^<h1/.test(line)) { out.headings.push(1); section = "(標題)" }
    else if (/^#{1,6} /.test(line)) { out.headings.push(line.match(/^#+/)[0].length); section = `H${line.match(/^#+/)[0].length}` }
    if (/^<details>/.test(line)) out.details++
    for (const m of line.matchAll(/(?:!\[[^\]]*\]|<img)\s*(?:\([^)]*\)|src="([^"]+)")/g)) out.imgs.push((m[1] || m[0]).slice(0, 60))
    // Markdown 連結目標：URL 裡的 %28/%29 讓括號不會截斷匹配；比對前把各語言各自的參數正規化
    for (const m of line.matchAll(/\((https?:\/\/[^)\s]+|[^)\s]+\.md)\)/g)) out.links.push(localizeUrl(m[1]))
    if (line.startsWith("|")) {
      if (/^[\s|:-]+$/.test(line)) continue
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
      if (!table) {
        table = []
        out.tables.push(table)
      }
      table.push(`${cells.length}格 ${rowIdentity(line)}`)
      continue
    }
    table = null
    if (/^\|/.test(line)) blankBefore = true
    // 散文段落數：空行分隔的區塊數。少一段就是其中一份漏寫了（行數會因語言而差，不比）
    if (!/^<[a-z]/.test(line) && !/^\|/.test(line)) {
      if (blankBefore) out.prose.push(section)
      blankBefore = false
    }
  }
  const prose = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/%[0-9A-F]{2}/g, " ")
    .replace(/src="[^"]*"/g, " ")
  out.numbers = [...prose.matchAll(/(?<![\w.])\d{2,6}(?![\w.])/g)].map((m) => m[0])
  // 代幣（代碼 Span）與語言無關：少一個就是其中一份漏寫了某個變數名／標頭名／參數
  // 逐行取，span 不跨行；過濾含 CJK 的（那是引號不是代幣）
  const toks = new Set()
  for (const line of text.split("\n")) {
    for (const m of applyPlaceholders(localizeUrl(line)).matchAll(/`([^`\n]{1,60})`/g)) {
      if (!/[\u4e00-\u9fff]/.test(m[1])) toks.add(m[1])
    }
  }
  out.tokens = [...toks]
  return out
}

const [a, b] = FILES.map((f) => structure(readFileSync(f, "utf8")))
const diffs = []
const compare = (label, x, y) => {
  if (JSON.stringify(x) === JSON.stringify(y)) return
  const onlyA = x.filter((v) => !y.includes(v))
  const onlyB = y.filter((v) => !x.includes(v))
  if (!onlyA.length && !onlyB.length) return // 只有順序/語言不同，內容相同
  diffs.push(`${label}\n  僅 ${FILES[0]}: ${JSON.stringify(onlyA).slice(0, 500)}\n  僅 ${FILES[1]}: ${JSON.stringify(onlyB).slice(0, 500)}`)
}

compare("章節層級序列", a.headings, b.headings)
// 每一節的散文行數：兩份的段落結構必須一致（文字本身當然是兩種語言）
const group = (x) => { const m = new Map(); x.forEach((k) => m.set(k, (m.get(k) || 0) + 1)); return [...m.entries()].map(([k, n]) => `${k}:${n}`) }
compare("各節的散文行數", group(a.prose), group(b.prose))
if (a.tables.length !== b.tables.length) diffs.push(`表格數量不同：${a.tables.length} vs ${b.tables.length}`)
else a.tables.forEach((t, i) => compare(`表格 #${i + 1}（${t.length} 行 vs ${b.tables[i].length} 行）`, t, b.tables[i]))
compare("指令（註解與佔位符已正規化）", a.code, b.code)
compare("連結目標", a.links, b.links)
if (a.fences !== b.fences) diffs.push(`程式碼塊數量不同：${a.fences} vs ${b.fences}`)
if (a.details !== b.details) diffs.push(`<details> 數量不同：${a.details} vs ${b.details}`)
compare("徽章／按鈕", a.imgs, b.imgs)
compare("代幣（環境變數／標頭／參數名）", a.tokens, b.tokens)
compare("文中出現的數字（預設值、上限、測試數）", a.numbers, b.numbers)

if (diffs.length) {
  console.error(`✗ 兩個 README 不對等（${diffs.length} 處）：\n\n${diffs.join("\n\n")}`)
  process.exit(1)
}
console.log(
  `✓ 兩份 README 結構對等：章節 ${a.headings.length}、表格 ${a.tables.length}（行數 ${a.tables.map((t) => t.length).join("/")}）、指令 ${a.code.length} 行、連結 ${new Set(a.links).size} 個、<details> ${a.details}、程式碼塊 ${a.fences}、散文段落 ${a.prose.length}（對面 ${b.prose.length}）、代幣 ${a.tokens.length}`,
)
