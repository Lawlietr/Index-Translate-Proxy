// 對照實驗：最純粹的 SSE 函式（不經任何代理邏輯）。用來判斷「Vercel 會不會緩衝 response」是平台行為還是我們的代碼。
export default async function handler(req, res) {
  res.setHeader("content-type", "text/event-stream")
  res.setHeader("cache-control", "no-store")
  res.writeHead(200)
  for (let i = 0; i < 5; i++) {
    res.write(`data: {"i":${i},"t":${Date.now()}}\n\n`)
    await new Promise((r) => setTimeout(r, 300))
  }
  res.end()
}
