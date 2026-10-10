#!/usr/bin/env node
// 規則 11：使用者可見文字與註解一律繁體中文。這裡只掃**常見簡體字**，
// 不掃全部（會誤判簡體專有名詞與引用原文）；命中就列出，非零離開。
// 跑法：node scripts/lint-zh.mjs [路徑...]   （預設掃 src scripts tests docs）
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, extname } from "node:path"

// 自己被列進來也會被掃到，所以把這個檔的清單行跳過（見 skipLine）。
const BAD = new Set([
  // 只列「繁體不用這個字形」的字；會兩邊通用的（于、合、查、只…）一律不列，免得多出假警報。
  "这", "们", "么", "传", "内", "为", "应", "举", "处", "从", "许", "询", "误",
  "实", "队", "关", "间", "时", "术", "语", "级", "统", "计", "设", "调",
  "请", "说", "过", "进", "达", "维", "运", "输", "闭", "闻", "适", "严",
  "复", "错", "简", "单", "样", "标", "拟", "检", "据", "当", "尽", "号",
  "与", "写", "会", "无", "独", "医", "肃", "显", "气", "产", "众", "丰",
  "诉", "个", "两", "别", "证", "译", "讲", "认", "识", "记", "录", "则", "种", "并", "迹", "亚", "仅",
  // 2026-10-10 补：这些字形只在简体出现，且都是我们自己写错的实例（来／暂／缓／冲／个／并／档）。
  "来", "暂", "缓", "冲", "组", "负", "载", "响", "讯", "极", "顶", "属",
  "异", "弃", "补", "续", "个", "并", "档",
])

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["src", "api", "probes", "scripts", "tests", "design", "README.md", "AGENTS.md", "TODO.md"]
// tests/fixtures 是上游回的具體內容（簡體），不是我們寫的文字 → 不掃。
const SKIP_DIRS = new Set(["node_modules", ".git", "tmp", ".wrangler", ".forgejo", "results", "fixtures"])
const EXT = new Set([".js", ".mjs", ".md", ".toml", ".json"])

function* walk(p) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
      yield* walk(join(p, name))
    }
  } else if (EXT.has(extname(p))) yield p
}

let hits = 0
for (const root of roots) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((line, i) => {
      if (file.endsWith("lint-zh.mjs")) return
      // 規則 11：上游的簡體原文「原文照引時標注出處」即可 → 帶出處標記的行不計
      if (line.includes("上游原文") || line.includes("原文照引")) return
      const found = [...new Set([...line].filter((c) => BAD.has(c)))]
      if (!found.length) return
      hits += found.length
      console.log(`${file}:${i + 1}  ${found.join("")}  │ ${line.trim().slice(0, 90)}`)
    })
  }
}
console.log(hits ? `\n${hits} 處疑似簡體字（規則 11）` : "未發現常見簡體字")
if (hits) process.exitCode = 1
