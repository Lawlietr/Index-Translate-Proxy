// 把 ITP_KEY 設到 Vercel 的 production 環境變數（規則 8 的 key 不進 repo、不進上游）。
// 跑法：VERCEL_TOKEN=… node scripts/set-env-vercel.mjs [key 值]
//   沒有帶值時讀 /tmp/itp-key.txt 或第一個 argv。已存在同名變數就先刪再建（Vercel 的 env 不能原地改值）。
const TOKEN = process.env.VERCEL_TOKEN
const TEAM = process.env.VERCEL_TEAM_ID
const PROJECT = process.env.VERCEL_PROJECT || "index-translate-proxy"
const NAME = "ITP_KEY"

const value = (process.argv[2] || (await import("node:fs")).readFileSync("/tmp/itp-key.txt", "utf8")).trim()
if (!TOKEN) {
  console.error("需要 VERCEL_TOKEN（VERCEL_TEAM_ID 選填）。key 可以當參數傳，或放 /tmp/itp-key.txt。")
  process.exit(1)
}
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${TEAM ? `?teamId=${TEAM}` : ""}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { status: res.status, body }
}

const projects = await api(`/v9/projects?limit=100`)
const project = (projects.body.projects || []).find((p) => p.name === PROJECT)
if (!project) {
  console.error(`找不到專案 ${PROJECT}。現有：${(projects.body.projects || []).map((p) => p.name).join(", ") || "（無）"}`)
  process.exit(1)
}
// 先清掉舊的同名變數（值不能原地改）。
const list = await api(`/v9/projects/${project.id}/env`)
for (const item of list.body.envs || []) {
  if (item.key === NAME) {
    const del = await api(`/v9/projects/${project.id}/env/${item.id}`, { method: "DELETE" })
    console.log(`刪除舊的 ${NAME}（${item.id}）→ HTTP ${del.status}`)
  }
}
const body = { key: NAME, value, type: "encrypted", target: ["production", "preview", "development"] }
const created = await api(`/v7/projects/${project.id}/env`, { method: "POST", body: JSON.stringify(body) })
if (created.status >= 300) {
  // 不同 API 版本用的是 target（單數/陣列）或 targets（陣列）：兩種都試過才算穩。
  const alt = await api(`/v9/projects/${project.id}/env`, { method: "POST", body: JSON.stringify({ ...body, targets: body.target }) })
  console.log(`退到 v9 再試 → HTTP ${alt.status}`, alt.body.error ? JSON.stringify(alt.body.error) : `（id ${alt.body.id}）`)
  process.exit(alt.status < 300 ? 0 : 1)
}
console.log(`建立 ${NAME} → HTTP ${created.status}`, created.body.error ? JSON.stringify(created.body.error) : `（id ${created.body.id}）`)
process.exit(created.status < 300 ? 0 : 1)
