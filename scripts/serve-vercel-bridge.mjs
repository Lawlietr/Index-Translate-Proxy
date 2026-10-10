// 用 Node 起 **Vercel 入口**（api/index.js 的 handler），打真上游。
// 用途：線上沒法部署時（或部署前後）驗證「Vercel 這條路徑」的真實行為——協定碼與 CF 那份是同一份，
// 但入口橋與 body 上限、串流真增量是平台相關，值得單獨跑。跑法：
//   ITP_KEY=$(openssl rand -hex 32) node scripts/serve-vercel-bridge.mjs 8788
//   node scripts/probe-live.mjs http://127.0.0.1:8788
import { createServer } from "node:http"
import { nodeHandler } from "../src/lib/vercel-node-adapter.js"

const port = Number(process.argv[2] || 8788)
const server = createServer((req, res) => {
  nodeHandler(req, res).catch((err) => {
    console.error("handler 掛了：", err)
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: String(err?.message || err) } }))
  })
})
server.listen(port, "127.0.0.1", () => {
  console.log(`Vercel 入口（Node 橋）：http://127.0.0.1:${port}｜ITP_KEY ${process.env.ITP_KEY ? "已設" : "未設（會回 503）"}`)
})
