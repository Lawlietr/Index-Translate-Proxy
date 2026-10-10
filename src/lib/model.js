// 模型閘（AGENTS.md 規則 1）：放行哪些模型，只在這一處定義。
// 為什麼放在獨立的 module：Worker 的**進入點 module 只能匯出 handler**（workerd 會把其他具名匯出
// 當成 handler 檢查，非函式就報 "Incorrect type for map entry"），所以常數不能留在 src/worker.js。
//
// 這裡不加 alias、不做靜默降級：不在清單上的模型一律在本地 400，不消耗上游配額。
// 清單是**自己測過**才進去的（`node scripts/probe-upstream.mjs model lines`，證據在
// `tests/fixtures/`、結論在 `design/model-allowlist.md`）：
//   - `Index-Translate-35B-A3B`：唯一由上游 `/v1/models` 宣告的模型。
//   - `index-mt-9b` / `index-mt-2b`：上游 `/v1/models` **不宣告**，但 400 的 body 自報了它們；
//     實測 200 且編號行逐行對應（8/8），回顯的內部名稱分別是 `qwen35-9b-…`、`qwen35-2b-linear-merge`。
//   - `index-mt-9b-syllable` / `index-mt-2b-syllable`：**故意不放行**——實測會破掉編號行
//     （9b-syllable 8 行只回 1 行就 `stop`；2b-syllable 直接把編號丟掉、整段併在一起）。
//     插件靠編號行把譯文對應回原文，所以這種「能跑但會錯位」比 400 更糟。

export const ALLOWED_MODEL = "Index-Translate-35B-A3B"

/** 清單順序＝建議順序：主模型在前。`/v1/models` 直接照這個順序回。 */
export const ALLOWED_MODELS = [ALLOWED_MODEL, "index-mt-9b", "index-mt-2b"]

/** 明確擋掉、並在 400 訊息裡說明原因的名字（避免使用者以為是壞了）。 */
export const BLOCKED_MODELS = {
  "index-mt-9b-syllable": "會漏行（只回第一行就停）",
  "index-mt-2b-syllable": "會丟掉編號、把多行併成一段",
}

// /v1/models 的 `created`：這是**我們驗證這些名字可用的日期**（2026-10-10），不是上游的宣告時間。
const VERIFY_EPOCH = 1791600000

/** 判斷要不要擋。 */
export function modelNotAllowed(model) {
  return !ALLOWED_MODELS.includes(model)
}

/** 400 的 message 會直接給 OpenAI client 顯示，所以要把「能用哪些」講完整。 */
export function modelNotAllowedMessage(received) {
  const got = String(received ?? "(未提供)")
  const why = BLOCKED_MODELS[received] ? `（這個名字我們測過：${BLOCKED_MODELS[received]}）` : ""
  return (
    `本代理放行的模型：${ALLOWED_MODELS.join("、")}。收到的是 "${got}"${why}；` +
    "本代理不做靜默降級，請改用上面其中一個。"
  )
}

/**
 * `GET /v1/models` 由本代理**自己回**，不透傳上游。
 * 理由：(1) 上游只宣告 35B-A3B，列出來會跟本代理實際放行的一致性不符；
 * (2) 省一次上游配額（`AGENTS.md`「刻意不做」裡同一個結論：模型探測不划算）。
 */
export function modelsPayload() {
  return {
    object: "list",
    data: ALLOWED_MODELS.map((id) => ({
      id,
      object: "model",
      created: VERIFY_EPOCH,
      owned_by: "bilibili/Index-Translate（經本代理放行）",
    })),
  }
}
