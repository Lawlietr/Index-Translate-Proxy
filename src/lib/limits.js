// 執行期限制與並發閘（AGENTS.md 規則 7、9；design/streaming-and-chunking.md §1–§2）。
//
// 兩件事放在一起：同一段 env 讀取同時餵給「長度上限」與「並發上限」，兩者都是本地守門。
//
// 1) 長度（規則 4）：只在行界切塊。單行本身超長**不切**，回 413 並說明怎麼繞過——
//    行內切會讓插件的編號行對應錯位。
// 2) 並發（規則 7）：上游近乎串行（2026-10-10 探測：10 併發只把延遲拉成 5 倍），
//    所以這裡是「別把上游打爆」的保護，不是提高吞吐的開關。
//    閘滿時先在本地排隊（FIFO），等不到才 429 + Retry-After。
//    計的是**請求**，不是切出來的塊——同請求的塊是依序送的，同時只有一塊在途。

/** 預設值。wrangler.toml 的 [vars] 要與這裡一致（AGENTS.md 規則 15），改一處就兩邊都改。 */
export const DEFAULTS = {
  MAX_INPUT_CHARS: 2500, // 切塊邊界；上游截斷在輸出側，3,040 字元仍完整譯完 → 留膨脹餘量（design/upstream-probe §1）
  MAX_TOKENS_DEFAULT: 4096, // 送給上游的 max_tokens（客戶端自己帶就不覆蓋，規則 9）
  MAX_INFLIGHT: 4,
  SLOT_WAIT_MS: 15000, // 閘滿時最久的本地等待；超過才 429
  MAX_LINE_CHARS: 2000, // 單行上限，超過 → 413
  MAX_BODY_BYTES: 16384, // 送上游的單塊 body 上限，超過 → 413
}

// 夾擠範圍：設錯（打錯字、0、超大值）不該讓 worker 變慢或打爆上游，所以要有一個上下界。
const BOUNDS = {
  MAX_INPUT_CHARS: [1, 20000],
  MAX_TOKENS_DEFAULT: [1, 8192],
  MAX_INFLIGHT: [1, 16],
  SLOT_WAIT_MS: [0, 60000],
  MAX_LINE_CHARS: [1, 8000],
  MAX_BODY_BYTES: [1024, 1_048_576],
}

/** env 的 var 都是字串；非數字就用預設，數字則夾在上下界之間。 */
export function readLimits(env = {}) {
  const num = (key) => {
    const raw = env[key]
    const n = raw === undefined || raw === null || raw === "" ? NaN : Number(raw)
    const [lo, hi] = BOUNDS[key]
    if (!Number.isFinite(n)) return DEFAULTS[key]
    return Math.min(hi, Math.max(lo, Math.floor(n)))
  }
  return {
    maxInputChars: num("MAX_INPUT_CHARS"),
    maxTokensDefault: num("MAX_TOKENS_DEFAULT"),
    maxInflight: num("MAX_INFLIGHT"),
    slotWaitMs: num("SLOT_WAIT_MS"),
    maxLineChars: num("MAX_LINE_CHARS"),
    maxBodyBytes: num("MAX_BODY_BYTES"),
  }
}

/**
 * 規則 7 的 429。這裡不包層：附 Retry-After 與插件設定建議，
 * 讓使用者看到訊息就知道下一步做什麼，而不是只看到一個狀態碼。
 */
export function gateFullResponse() {
  const hint =
    "上游沒有可查的配額，這個 429 來自本代理的 MAX_INFLIGHT。" +
    "調大 MAX_INFLIGHT 通常沒有用（上游近乎串行），有效的是把插件的「每秒最大請求數」設為 3~5。"
  return new Response(
    JSON.stringify({
      error: {
        message:
          "並發上限已滿（本代理同時在途的請求已到 MAX_INFLIGHT）。已等候超過 SLOT_WAIT_MS 仍拿不到 slot。" +
          "請稍後重試，或在插件把「每秒最大請求數」設為 3~5、「並發請求數」設為 2~3。",
        type: "rate_limit_error",
        param: null,
        code: 429,
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "retry-after": "2",
        "x-proxy-reason": "concurrency",
        "x-proxy-hint": encodeURIComponent(hint),
      },
    },
  )
}

export class ConcurrencyGate {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(limit) || 1)
    this._inflight = 0
    this._waiters = []
  }

  /** 目前佔用數（給日誌與測試）。 */
  get active() {
    return this._inflight
  }

  get available() {
    return this._inflight < this.limit
  }

  /** 不排隊版本：滿了直接 false。給「不想等」的呼叫端用。 */
  tryAcquire() {
    if (this._inflight >= this.limit) return false
    this._inflight++
    return true
  }

  /**
   * 排隊版本：滿了進 FIFO 佇列，最多等 waitMs。
   * 回 true = 拿到 slot（可能由 release() 直接轉手）；回 false = 等太久，呼叫端回 429。
   *
   * 等待者上限 = limit：再多排幾個也不會變快（上游近乎串行），只是佔著記憶體。
   */
  async waitForSlot(waitMs = 0) {
    if (this.available) {
      this._inflight++
      return true
    }
    if (this._waiters.length >= this.limit) return false
    return new Promise((resolve) => {
      const entry = { resolve, settled: false, timer: null }
      entry.timer = setTimeout(() => {
        if (entry.settled) return
        entry.settled = true
        const i = this._waiters.indexOf(entry)
        if (i >= 0) this._waiters.splice(i, 1)
        resolve(false)
      }, Math.max(0, waitMs))
      this._waiters.push(entry)
    })
  }

  /** 釋放：有等待者就把 slot **直接轉手**（計數不掉到 0，否則會被別人搶走、餓死排隊的人）。 */
  release() {
    const next = this._waiters.shift()
    if (next && !next.settled) {
      next.settled = true
      if (next.timer) clearTimeout(next.timer)
      next.resolve(true)
      return
    }
    this._inflight = Math.max(0, this._inflight - 1)
  }
}

// 執行期共用一個閘（同一 isolate）。上限改變時重建——wrangler dev 換 --var 時不該帶著舊閘跑。
let sharedGate = null
export function getGate(limit) {
  if (!sharedGate || sharedGate.limit !== Math.max(1, Math.floor(limit) || 1)) {
    sharedGate = new ConcurrencyGate(limit)
  }
  return sharedGate
}

/**
 * 純記憶體的視窗限流，介面與 CF 的 `[[ratelimits]]` 綁定一致（`get(key)` → `{success, limit, period}`）。
 * 用在沒有綁定可用的平台（Vercel／本地 dev）。層級差異要誠實：CF 的綁定跨請求共用，這裡只覆蓋
 * **同一個實例**——serverless 沒有跨實例的計數器，所以它是較弱的保護，不是等價物（README 照這個說法寫）。
 */
export function memoryRateLimit({ limit = 30, period = 60 } = {}, store = new Map()) {
  return {
    get(key) {
      const window = Math.floor(Date.now() / (period * 1000))
      const rec = store.get(key)
      if (!rec || rec.window !== window) {
        store.set(key, { window, count: 1 })
        return { success: true, limit, period }
      }
      rec.count += 1
      return rec.count > limit ? { success: false, limit, period } : { success: true, limit, period }
    },
  }
}

/** 給測試：清掉執行期的快取，避免跨案污染。 */
export function resetGateForTests() {
  sharedGate = null
}
