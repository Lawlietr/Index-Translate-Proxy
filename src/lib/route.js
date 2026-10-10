// 路徑策略（AGENTS.md 規則 5）。
// 原則：接受 /v1/*（插件的自訂地址以 /v1 結尾）與 /api/*（內部另一專案的寫法）；
// **已帶 /v1 的路徑絕不再補前綴**（會變成 /v1/v1/… → 上游 404）。
// 上游沒有的路徑與其他一切路徑 → 本地 404，不丟給上游白費一次配額。

/** 上游真的有的路徑。其他一律本地 404（`/v1/completions` 上游不存在，實測 404）。 */
export const UPSTREAM_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/models",
  "/v1/responses",
])

/**
 * 回傳：
 *  - { kind: "upstream", path }  → 轉發，path 已是上游要的形状
 *  - { kind: "root" }            → 僅 GET：回一行說明（design/streaming-and-chunking.md §5）
 *  - { kind: "not_found" }       → 本地 404
 */
export function resolvePathname(pathname) {
  let p = pathname || "/"
  // 尾斜線不影響語義（/v1/models/ 與 /v1/models 同）
  if (p.length > 1) p = p.replace(/\/+$/, "")

  if (p === "/") return { kind: "root" }

  // /api/… → /v1/…；已經帶 /v1 就不補前綴。
  if (p === "/api" || p.startsWith("/api/")) {
    const rest = p.slice(4) // "" 或 "/chat/completions"
    p = rest.startsWith("/v1") ? rest : "/v1" + rest
  }

  if (UPSTREAM_PATHS.has(p)) return { kind: "upstream", path: p }

  // 客戶端把 base 填成根網址（沒有 /v1）時會打 /chat/completions 這種形状：
  // 只有能对上上游白名單才补前綴，其他仍一律本地 404（規則 5：已帶 /v1 絕不補）。
  if (!p.startsWith("/v1")) {
    const candidate = `/v1${p}`
    if (UPSTREAM_PATHS.has(candidate)) return { kind: "upstream", path: candidate }
  }

  return { kind: "not_found", path: p }
}

/** 這個上游路徑要不要走「翻譯請求」那條路（鑑權後還要切塊/組包）。/v1/models 與 /v1/responses 只透傳。 */
export function isChatPath(path) {
  return path === "/v1/chat/completions"
}

/** 根路徑的一行說明：部署者開根路徑就知道怎麼填地址、自己有沒有設 key（key 狀態同時走 x-proxy-auth 標頭）。 */
export function rootDescription(host, authConfigured = false) {
  const authLine = authConfigured
    ? "鑑權：已啟用（請求需帶 Authorization: Bearer <key>）"
    : "鑑權：未啟用（任何人都可直接用）"
  return (
    `Index-Translate-Proxy：這是 API，不是網頁。` +
    `沉浸式翻譯的「自訂接口地址」請填 https://${host}/v1，模型名稱 Index-Translate-35B-A3B。` +
    `${authLine}。`
  )
}
