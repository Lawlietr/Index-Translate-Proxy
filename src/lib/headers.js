// 標頭政策（AGENTS.md 規則 2、6、8）。
// 對上游只帶 content-type 與 UA；客戶端的 Authorization / x-api-key / cookie / CF 的 x-* 一律不帶。

// 固定 UA（規則 2）：上游擋的是特定機器人 UA 黑名單，不是「不像瀏覽器」。
// 不假裝瀏覽器——讓上游看得出流量來源。
export const PROXY_UA =
  "Index-Translate-Proxy/0.1 (+https://github.com/Lawlietr/Index-Translate-Proxy)"

export const UPSTREAM_ORIGIN = "https://index-translate.bilibili.com"

/** 給上游的請求標頭：只有這兩個（規則 8）。 */
export function upstreamHeaders() {
  return {
    "content-type": "application/json",
    "user-agent": PROXY_UA,
  }
}

/**
 * 我們自己給瀏覽器的 CORS 標頭。
 * `authorization` 一定要在 allow-headers 裡，否則插件只會報 CORS 失敗、不會告訴你原因
 * （design/auth.md 定案 4）。
 */
export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key",
    "access-control-max-age": "600",
  }
}

/** 合併 CORS 與自訂標頭；undefined 的值會被丟掉（不要傳 `x-proxy-x: undefined`）。 */
export function mergeHeaders(...groups) {
  const out = {}
  for (const g of groups) {
    if (!g) continue
    for (const [k, v] of Object.entries(g)) {
      if (v === undefined || v === null) continue
      out[k] = String(v)
    }
  }
  return out
}

/**
 * 本地錯誤：用 OpenAI 的錯誤形狀，插件才顯示得出原因（規則 6 末句、design/auth.md 定案 5）。
 * 這類錯誤是**我們**產生的，不受規則 6（不改上游 status/body）約束。
 */
export function localError(status, message, { type, param, code } = {}) {
  const body = {
    error: {
      message,
      type: type || (status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : "invalid_request_error"),
      code: code ?? status,
    },
  }
  if (param) body.error.param = param
  return new Response(JSON.stringify(body), {
    status,
    headers: mergeHeaders(corsHeaders(), { "content-type": "application/json; charset=utf-8" }),
  })
}

/**
 * `x-proxy-hint`：規則 6 的「我們的建議」只能放標頭——插件不讀 body 裡的自訂欄位，
 * 但 devtools 看得到。HTTP 標頭不能帶非 Latin-1，所以中文用 percent-encoding，
 * 在 devtools 裡可直接讀（這是 design/streaming-and-chunking.md §4 記下的取捨）。
 */
export function hintHeader(text) {
  if (!text) return undefined
  return { "x-proxy-hint": encodeURIComponent(text) }
}

/**
 * 客戶自己帶的 `max_tokens` 超過上游硬上限時的事實與建議（規則 6 → 只放 `x-proxy-hint`）。
 * 為什麼要有這一段：上游會**靜默**鉗到 4,096（實測：要 16,384 只給恰好 4,096、`finish_reason:"length"`），
 * 客戶端只會看到「輸出變短」，看不到原因；不說話就會讓人以為是我們切掉的。
 * 我們**不改**客戶端的值（規則 9），只把事實講出來。
 */
export function maxTokensCeilingHint(requested, ceiling) {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= ceiling) return undefined
  return (
    `你帶的 max_tokens=${requested} 超過上游的硬上限 ${ceiling}（實測：要 16,384 時上游只給恰好 4,096，` +
    `並回 finish_reason:"length"）。本代理不覆蓋你帶的值，但上游會靜默鉗到 ${ceiling} → 尾部可能少幾行，` +
    `這不是本代理切掉的。要完整輸出請把單次輸入切短（少貼幾行），或讓插件每次少翻譯幾段。`
  )
}

/** 針對上游狀態碼的建議（規則 6）。不猜原因，只給做過的事實與可動的參數。 */
export function hintForStatus(status, { path, modelWhitelist }) {
  if (status === 412) {
    // 上游的 412 是 WAF，body 是 HTML（實測）→ 我們已經固定 UA，會發生只代表上游規則變了。
    return "上游 WAF 擋下這個請求（412）。本代理已固定 UA，若仍出現，可能是上游黑名單更新，請回報。"
  }
  if (status === 429) {
    return "上游按出口 IP 限 60,000 tokens/min（無配額查詢端點）。建議把插件的「每秒最大請求數」設為 3~5，並縮短單次輸入。"
  }
  if (status === 504) {
    return "上游會砍掉超過 10.0s 的請求（本代理已一律用串流）。若仍 504，請縮短單次輸入或降低 max_tokens。"
  }
  if (status === 404) {
    return `上游沒有這個路徑：${path}。可用的只有 /v1/chat/completions、/v1/models、/v1/responses。`
  }
  if (status === 400 && modelWhitelist) {
    return `只有 ${modelWhitelist} 由 /v1/models 宣告，請改用它。上游不換模型、不降級。`
  }
  if (status >= 500) return "上游錯誤（未重試）。本代理不換模型、不改 body，只原樣透傳。"
  return undefined
}

/** 除錯用標頭（規則 3、design/streaming-and-chunking.md §3/§4）。只放事實，不放推測。 */
export function proxyHeaders({ upstreamStreamForced, chunks, chunkFailed, chunkLines, chunkTruncated }) {
  return {
    "x-proxy-upstream-stream": upstreamStreamForced ? "forced" : undefined,
    "x-proxy-chunks": chunks,
    "x-proxy-chunk-failed": chunkFailed,
    "x-proxy-chunk-lines": chunkLines,
    "x-proxy-chunk-truncated": chunkTruncated,
  }
}
