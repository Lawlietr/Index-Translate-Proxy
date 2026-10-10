// 模型閘（AGENTS.md 規則 1）：只放行這一個模型。
// 為什麼放在獨立的 module：Worker 的**進入點 module 只能匯出 handler**（workerd 會把其他具名匯出
// 當成 handler 檢查，非函式就報 "Incorrect type for map entry"），所以常數不能留在 src/worker.js。
// 上游只宣告一個模型（/v1/models），而且會撤回模型名稱（index-homura-* 先例）——
// 這裡不加 alias、不做靜默降級；未知模型一律在本地 400，不消耗上游配額。

export const ALLOWED_MODEL = "Index-Translate-35B-A3B"

/** 判斷要不要擋。訊息會直接進 400 的 body（OpenAI 形狀），所以要把「該用哪個模型」寫清楚。 */
export function modelNotAllowed(model) {
  return model !== ALLOWED_MODEL
}

export function modelNotAllowedMessage(received) {
  return (
    `本代理只放行 ${ALLOWED_MODEL}（由 /v1/models 宣告）。收到的是 "${String(received ?? "(未提供)")}"，` +
    "請改用它；本代理不做靜默降級。"
  )
}
