export default async function handler(req, res) {
  const mode = (req.url || "").split("/")[1] // /stream-variants?mode=… 用 query 區分
  const q = new URL(req.url, "http://x").searchParams.get("mode") || "a"
  const pad = "x".repeat(2000)
  res.setHeader("content-type", "text/event-stream")
  res.setHeader("cache-control", "no-store")
  if (q === "b") res.setHeader("x-accel-buffering", "no")
  if (q === "c") res.setHeader("x-vercel-buffering", "disable")
  res.writeHead(200)
  if (q === "d") res.flushHeaders()
  for (let i = 0; i < 8; i++) {
    res.write(`data: {"mode":"${q}","i":${i},"pad":"${pad}"}\n\n`)
    if (q === "e") res.flush()
    await new Promise((r) => setTimeout(r, 250))
  }
  res.end()
}
