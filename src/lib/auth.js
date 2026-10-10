// 鑑權（AGENTS.md 規則 8 ＋ design/auth.md 定案）。全部本地處理，在任何上游請求之前完成，
// 所以 401 不消耗上游配額。key 驗完即丟，絕不轉發給上游。

import { corsHeaders, localError, mergeHeaders } from "./headers.js"

const ENC = new TextEncoder()

/** SHA-256 hex：不逐字元比明文（避免時序側信道，也保證日誌裡不會出現 key）。 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", ENC.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** 定案 2：等長且逐字元的常數時間比對（hex 已是 ASCII，逐字元即可）。 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 定案 3：讀取順序 `Authorization: Bearer` → `x-api-key`。不支援 query／path 帶 key。 */
export function readClientKey(request) {
  const auth = request.headers.get("authorization") || ""
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (m && m[1].trim()) return m[1].trim()
  const x = request.headers.get("x-api-key")
  if (x && x.trim()) return x.trim()
  return null
}

/** 根路徑用：只讲「部署者有沒有設 key」，不碰上游、不算健康檢查。 */
export function authConfigured(env) {
  return Boolean(env && typeof env.ITP_KEY === "string" && env.ITP_KEY.trim())
}

/** 鑑權狀態只有一種開關：設了 key 才有鑑權；沒設就是 `missing`（請求回 503）。 */
export function authMode(env) {
  return authConfigured(env) ? "configured" : "missing"
}

/**
 * 客戶端 IP：定案 6 用 `cf-connecting-ip`（Cloudflare）。換平台時標頭名字不同，
 * 但「只有一份讀取順序」——各入口不要再各自轉標頭。順序：CF → Vercel → 通用標頭 → 執行環境自帶的 ip。
 */
export function clientIp(request) {
  const forwarded = String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    forwarded ||
    request.ip ||
    "unknown"
  )
}

/**
 * 回 { ok: true } 或 { ok: false, response }。
 * 「未提供」與「不正確」給不同 message，但不洩漏哪把 key 有效（定案 5）。
 */
export async function checkAuth(request, env) {
  if (!authConfigured(env)) {    // 沒設 key 就不開放使用：這是部署者端的錯誤，回 503 比回 401 誠實。
    return {
      ok: false,
      reason: "missing-config",
      response: localError(
        503,
        "本代理未設定 ITP_KEY，無法驗證請求。部署者請執行 wrangler secret put ITP_KEY（Vercel 則在專案的 Environment Variables 加 ITP_KEY）",
        { type: "service_unavailable", code: 503 },
      ),
    }
  }

  const provided = readClientKey(request)
  if (!provided) {
    return {
      ok: false,
      reason: "missing",
      response: withWwwAuth(
        localError(401, "未提供 API Key：請在插件的 API Key 欄位填入本代理的 key", { code: 401 }),
      ),
    }
  }

  const expected = await sha256Hex(env.ITP_KEY)
  const actual = await sha256Hex(provided)
  if (!constantTimeEqual(expected, actual)) {
    return {
      ok: false,
      reason: "invalid",
      response: withWwwAuth(
        localError(401, "API Key 不正確：這把 key 是本代理自己的門（ITP_KEY），上游本身不需 key", { code: 401 }),
      ),
    }
  }
  return { ok: true, reason: "ok" }
}

function withWwwAuth(response) {
  response.headers.set("WWW-Authenticate", "Bearer")
  return response
}

/**
 * 401 走獨立限流（定案 6）：不與正常流量共用額度，免得有人亂試 key 把正常請求一起擠掉。
 * 沒有綁定（本地 dev）時不擋——只在綁定存在時守門。
 */
export async function checkAuthRateLimit(request, env) {
  const rl = env && env.AUTH_RL
  if (!rl || typeof rl.get !== "function") return { ok: true }
  let res
  try {
    res = await rl.get(clientIp(request))
  } catch {
    return { ok: true } // 綁定本身的錯誤不該讓請求失敗
  }
  if (res && res.success === false) {
    const retryAfter = res.period || 60
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: {
            message: `鑑權失敗次數過多，請 ${retryAfter} 秒後再試（這是本代理的 401 限流，不是上游配額，也不是上游配額用盡）`,
            type: "rate_limit_error",
            code: 429,
          },
        }),
        {
          status: 429,
          headers: mergeHeaders(corsHeaders(), {
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(retryAfter),
            "x-proxy-hint": encodeURIComponent("連續 401 太多次。先確認插件填的是本代理的 ITP_KEY，不是上游的 key。"),
          }),
        },
      ),
    }
  }
  return { ok: true }
}
