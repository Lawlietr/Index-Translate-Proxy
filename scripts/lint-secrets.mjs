#!/usr/bin/env node
// 規則 17：通行碼只走環境變數，不進 repo。這條把「別把 key 提交進來」從人的記憶變成檢查。
//
// 為什麼要有這條：這個 repo 是公開可讀的鏡像（AGENTS 規則 12），key 一旦進去就要改歷史，
// 不是改一個檔就了結——所以放在 CI 最前面，比 file:line 的對等檢查更便宜。
//
// 掃的是 `git ls-files`（已追蹤的檔案），不是工作目錄：還沒 add 的本地檔不是洩漏。
// 帶路徑參數時就掃那些路徑（跟 lint-zh 一样的用法）——那是用來**證明這個檢查真的會抓**，
// 而不是只證明它現在是綠的：`npm run lint:secret -- ~/.pi/agent/mcp.json` 應該要红。
// 為什麼以 64 位 hex 為主訊號：自己的通行碼就是 `openssl rand -hex 32` 的輸出，正好 64 個
// hex 字元；而 git 的 commit sha 是 40 位、測試裡用的假 sha 也是 40 位 → 不在這個形狀裡，
// 所以不會出現那種逼著人關掉的假警報。
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const HEX64 = /\b[0-9a-f]{64}\b/g
// assignment 形状：`ITP_KEY=<真值>`。範本（`ITP_KEY=`）與引用（`ITP_KEY=…`、`ITP_KEY=$(...)`）
// 都不是 16 個以上的英數字，所以不會被抓。
const ASSIGN = /\b(ITP_KEY|ITP_PROBE_KEY|PROXY_KEY|OPENAI_API_KEY)=[A-Za-z0-9_-]{16,}/g
const SKIP_DIRS = new Set(["node_modules", ".git", ".vercel", ".wrangler", "results"])

function* walk(p) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (SKIP_DIRS.has(name) || name === ".git") continue
      yield* walk(join(p, name))
    }
  } else yield p
}

const args = process.argv.slice(2)
const files = args.length
  ? args.flatMap((p) => [...walk(p)])
  : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean)

let hits = 0
for (const file of files) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    continue // 符號連結或讀不到的檔：跳過，不假裝查過
  }
  if (buf.includes(0)) continue // binary：不是我们能读的文本
  buf.toString("utf8").split("\n").forEach((line, i) => {
    const found = [...line.matchAll(HEX64), ...line.matchAll(ASSIGN)]
    if (!found.length) return
    hits += found.length
    const what = found.map((m) => `${m[0].slice(0, 12)}…`).join(" ")
    console.log(`${file}:${i + 1}  ${what}  │ ${line.trim().slice(0, 90)}`)
  })
}

console.log(hits ? `\n${hits} 處疑似真實通行碼（規則 17：不要進 repo，改用環境變數）` : "未發現疑似真實通行碼（規則 17）")
if (hits) process.exitCode = 1
