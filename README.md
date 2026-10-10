# Index-Translate-Proxy

一個 **Cloudflare Worker**：把 bilibili **Index-Translate** 的免費公網 API
（`https://index-translate.bilibili.com/v1`）以**同源端點**的形式提供出去，讓瀏覽器插件
（**沉浸式翻譯 Immersive Translate** 的「OpenAI 翻譯服務 + 自訂接口地址」）與其他 OpenAI 相容
客戶端可以直接使用 35B 翻譯模型。本 repo 只做代理，不做 UI。

> ## 狀態：骨架（尚未實作）
>
> 目前只有專案設定與文件，`src/` 尚未建立，`npm run dev` / `npm run deploy` 還不能跑。
> 要實什麼、照哪些規則實，寫在 [`AGENTS.md`](AGENTS.md)。

## 為什麼需要一個代理（不是「可有可無」）

官方教學自己就在端點前面放了一座橋（`python call_api.py --serve`），理由寫在
`inference/llm/README_zh.md`：瀏覽器直連公網端點受「跨域（CORS）、WAF 保護、思維鏈（CoT）」三項限制。
2026-10-08 實測後，三項裡只有 **WAF 一項是真的**，但那一項就足以讓非瀏覽器客戶端全數 412：

| 官方列的限制 | 實測（2026-10-08） |
|---|---|
| CORS | 不成立：帶 `Origin` 時回 `access-control-allow-origin: *` |
| CoT 格式 | 不成立：不帶 `chat_template_kwargs` 也不漏思考標記 |
| **WAF 保護** | **成立**：`Python-urllib` / `python-requests` 的 UA → **412**；瀏覽器樣式 UA、`Cloudflare-Workers`、甚至空字串 → 200；完全不送 UA → 412 |

另外兩項**只有代理能處理**的真實限制：上游把「非串流且超過 10.0s」的請求以 **HTTP 504** 砍掉；
35B 在約 **4000 字元**的輸入會截斷。兩者的細節與證據都在 [`AGENTS.md`](AGENTS.md)。

## 插件要怎麼填（實作完成後）

| 沉浸式翻譯設定 | 值 |
|---|---|
| 翻譯服務 | `OpenAI` |
| 自訂接口地址 | `https://<你的 worker 網域>/v1`（**以 `/v1` 結尾**，插件自己補 `/chat/completions`） |
| 模型名稱 | `Index-Translate-35B-A3B` |
| API Key | 任填（上游不需鑑權；本代理也不會把這個頭轉發給上游） |
| 每秒最大請求數 | **3~5**（官方教學同值；上游無公開配額） |

## 授權

**MIT**。上游 `bilibili/Index-Translate` 是 **Apache-2.0**，但那是**寬鬆授權、沒有 copyleft 傳染性**：
它的義務只在「散布或改作**他們的程式碼**」時觸發（保留聲明、附 NOTICE、標明修改）。
這個代理是原創程式碼，透過 HTTP API 呼叫服務，**不構成衍生著作**，因此不需要改用 Apache-2.0。

兩條要守住的前提（寫在 `AGENTS.md`）：

1. 若將來**逐字複製**上游程式碼（例如 `call_api.py` 的片段或 prompt 模板原文），該部分仍受 Apache-2.0
   約束 → 必須保留出處註解。
2. 若將來**逐字複製其他內部專案的程式碼**（尚未公開發布，且採 **AGPL-3.0**），會讓這個 MIT 專案
   內含 copyleft 片段。因此規則是：**事實、概念、prompt 結構可共用；逐字複製程式碼要先到授權層面做決定**
   （要嘛只在這個 repo 重寫，要嘛統一授權）。

模型權重的授權（HF model card）是**另一件事**，與本 repo 的程式碼授權無關；只有將來改用本地部署的
2B/9B 權重時才需要看它。

## 來源

- [bilibili/Index-Translate — 沉浸式翻译配置教程](https://github.com/bilibili/Index-Translate/blob/main/docs/immersive_translate_zh.md)
- [inference/llm/README_zh.md — 「CORS / WAF / CoT，請用本地代理」那段](https://github.com/bilibili/Index-Translate/blob/main/inference/llm/README_zh.md)
- [沉浸式翻譯 — OpenAI 自訂接口地址用法](https://immersivetranslate.com/en/docs/services/ai/)／[自訂 API 協定](https://immersivetranslate.com/en/docs/services/custom/)

上游行為的實測紀錄都放在本 repo（`AGENTS.md` 的事實表與 `design/` 的探測紀錄）；其他內部專案尚未公開，
不在這裡引用。
