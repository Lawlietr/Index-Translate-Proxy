// 部署前把「這份代碼是哪個 commit」設進 Vercel 的環境變數 `GIT_COMMIT`（AGENTS 規則 13）。
// 為什麼要自己設：`VERCEL_GIT_COMMIT_SHA` 只有「由 Git 觸發的部署」才有值，而本專案是 CLI 上傳部署
// → 不能假裝那裡會有東西。所以標記由我們在部署前寫進 `GIT_COMMIT`，`src/lib/build-info.js` 讀它並回
// `x-proxy-build`（12 字元）。兩邊都讀：哪天改成 Git 連線部署，平台那個後備自然生效，不用改代碼。
//
// 跑法：VERCEL_TOKEN=… [VERCEL_TEAM_ID=…] node scripts/deploy-ref-vercel.mjs [ref]
//   ref 預設 = `git rev-parse HEAD`。`npm run deploy:vercel` 會自動先跑這一個。
// 標記不是隱私（commit 本來就在 repo 裡）→ 用 type: "plain"，dashboard 直接看得到，方便排錯。
const TOKEN = process.env.VERCEL_TOKEN
const TEAM = process.env.VERCEL_TEAM_ID
const PROJECT = process.env.VERCEL_PROJECT || "index-translate-proxy"
const NAME = "GIT_COMMIT"

const { execSync } = await import("node:child_process")
const value = (
  process.argv[2] ||
  execSync("git rev-parse HEAD", { encoding: "utf8" }).trim()
).trim()
if (!/^[0-9a-f]{7,40}$/i.test(value)) {
  console.error(`不像 commit 参考：${value.slice(0, 40)}`)
  process.exit(1)
}
if (!TOKEN) {
  console.error("需要 VERCEL_TOKEN（VERCEL_TEAM_ID 選填）。沒有 token 就不要部署——否則線上那份不知道自己是哪個 commit。")
  process.exit(1)
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${TEAM ? `?teamId=${TEAM}` : ""}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const projects = await api(`/v9/projects?limit=100`)
const project = (projects.body.projects || []).find((p) => p.name === PROJECT)
if (!project) {
  console.error(`找不到專案 ${PROJECT}。現有：${(projects.body.projects || []).map((p) => p.name).join(", ") || "（無）"}`)
  process.exit(1)
}

// 同名變數不能原地改值 → 先刪再建（與 set-env-vercel.mjs 同樣的做法）。
const list = await api(`/v9/projects/${project.id}/env`)
for (const item of list.body.envs || []) {
  if (item.key === NAME) {
    const del = await api(`/v9/projects/${project.id}/env/${item.id}`, { method: "DELETE" })
    console.log(`刪除舊的 ${NAME}（${item.id}）→ HTTP ${del.status}`)
  }
}
const body = { key: NAME, value, type: "plain", target: ["production", "preview", "development"] }
const created = await api(`/v7/projects/${project.id}/env`, { method: "POST", body: JSON.stringify(body) })
if (created.status >= 300) {
  const alt = await api(`/v9/projects/${project.id}/env`, { method: "POST", body: JSON.stringify({ ...body, targets: body.target }) })
  console.log(`退到 v9 再試 → HTTP ${alt.status}`, alt.body.error ? JSON.stringify(alt.body.error) : `（id ${alt.body.id}）`)
  if (alt.status >= 300) process.exit(1)
} else {
  console.log(`建立 ${NAME} → HTTP ${created.status}`, created.body.error ? JSON.stringify(created.body.error) : `（id ${created.body.id}）`)
}
console.log(`${NAME} = ${value}（標頭會顯示 ${value.slice(0, 12).toLowerCase()}）`)
