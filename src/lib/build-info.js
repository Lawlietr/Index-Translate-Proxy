// 建置標記（AGENTS 規則 13）：讓**線上探測的失敗能對應到某一次部署**。
// 排程探測（.github/workflows/live-probe.yml）每天打的是已部署的入口，那頭看到的是行為；
// 如果沒有標記，紅灯只能說「那個網址壞了」，不能說「哪一份代碼壞了」。
//
// 來源優先序（都是「部署時就定的值」，不是執行時猜）：
//   1. `GIT_COMMIT`／`GIT_SHA`：由 `scripts/deploy-ref-vercel.mjs` 在部署前寫進 Vercel 環境變數。
//   2. `VERCEL_GIT_COMMIT_SHA`／`CF_PAGES_COMMIT_SHA`：平台自己會注入——但**只在專案 Connected to Git 時才有值**，
//      本專案走 CLI 部署，實測多半是空字串，所以放在後面當備援，不当成保證。
// 兩條都沒有 → 回 null，**不帶標頭**。沒資料就說沒資料，與「不造假 usage」（規則 3）同一個道理。

const HEX_PREFIX = /^[0-9a-f]{7,40}/i
const SOURCES = ["GIT_COMMIT", "GIT_SHA", "VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA"]

/** 從環境裡取出 commit 參考，正規化成 12 字元小寫 hex；拿不到就 null。 */
export function buildRef(env) {
  if (!env) return null
  for (const name of SOURCES) {
    let raw
    try {
      raw = env[name]
    } catch {
      // 某些 runtime 讀 process.env 的屬性會丟（Edge 的 env 是 proxy 物件）：跳過這一個來源。
      continue
    }
    if (typeof raw !== "string") continue
    const value = raw.trim()
    if (!value) continue
    const m = value.match(HEX_PREFIX)
    if (m) return m[0].slice(0, 12).toLowerCase()
  }
  return null
}

export const BUILD_HEADER = "x-proxy-build"

/**
 * 把建置標記加到回應上。**每個回應都加**（含 401／404／429 這些本地錯誤）——
 * 排程探測紅的时候多半就是這些 4xx，標記不在那些回應上就等於沒有。
 * 不知道建置（回 null）時原樣回傳，不帶標頭、不造假。
 */
export function withBuildMarker(res, env) {
  const ref = buildRef(env)
  if (!ref || !res || typeof res.headers?.get !== "function") return res
  // Response 的標頭是不可變的 → 只能複製。body 是同一個 stream，不緩衝、不改動（規則 3 的真增量不受影響）。
  // 這是一個診斷用的標頭：**不該成為請求失敗的原因**，所以整個複製過程包起來，失敗就交回原回應。
  try {
    const headers = new Headers(res.headers)
    headers.set(BUILD_HEADER, ref)
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  } catch {
    return res
  }
}
