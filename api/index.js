// Index-Translate-Proxy — Vercel 入口（**Edge runtime**）。
// 協定邏輯全在 src/worker.js，與 Cloudflare Worker 入口共用同一份實作（規則 1–9 只有一份真相）。
//
// 為什麼是 Edge runtime 而不是 Node runtime（2026-10-10 實測，見 design/egress-options.md）：
// Vercel 的 **Node** 函式會把 SSE 整批緩衝後才送到客戶端（72 個塊在同一瞬間抵達），
// Edge runtime 則原生串流。這個代理的存在理由就是「把上游的真增量交出去」（規則 3），所以選 Edge。
// 限制：Edge 必須在 25s 內開始回 response，之後可持續串流到 300s——上游 TTFT 0.17–1.02s，條件遠比我們寬。
//
// Node runtime 的橋留著（src/lib/vercel-node-adapter.js + tests/vercel-bridge.test.mjs），
// 要自架 Node 或平台策略改變時直接可用；它不在 Vercel 上部署。
import worker from "../src/worker.js"
import { memoryRateLimit } from "../src/lib/limits.js"

export const config = { runtime: "edge" }

// 環境變數在 Vercel 是 process.env（建立實例時注入，一個實例內不變）。
// Vercel 沒有 CF 的 `[[ratelimits]]` 綁定 → 401 的獨立限流用同介面的純記憶體版補位；
// 它只覆蓋單一實例，較弱，這件事寫在 README，不假裝等價。
const env = {
  ...process.env,
  AUTH_RL: memoryRateLimit({ limit: Number(process.env.AUTH_RL_LIMIT || 30), period: 60 }),
}

export default async function handler(request) {
  return worker.fetch(request, env)
}
