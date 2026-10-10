# design/model-allowlist.md — 放行哪些模型（實測，不是抄上游的自報）

> 規則 1 的原則是不換模型、不靜默降級；但要放行哪些名字必須**自己測過**。
> 這檔就是那份測量的結論。重跑：`node scripts/probe-upstream.mjs model lines`
> （原始存證：`tests/fixtures/model-*.txt|json`、`lines-*.txt`、`probe-20261010T15*.json`）。
> 日期：2026-10-10，從本機出口（UA 為瀏覽器形状，已驗證不會被 412）。

## 1. 上游自己說了什麼

`GET /v1/models` 只宣告 **`Index-Translate-35B-A3B`**。但**未知模型回 400 的 body 自報**了一串名字：

```
{"detail":"未知模型 'gpt-4o-mini'，公开支持模型: Index-Translate-35B-A3B, index-mt-2b, index-mt-9b, index-mt-2b-syllable, index-mt-9b-syllable"}
```

自報 ≠ 可用，所以要打。

## 2. 能不能跑（`model` 群組，同一小段文本 zh→en）

| 送出的 model | status | 回顯的 model（內部部署名） | 用時 | 輸出 |
|---|---|---|---|---|
| `Index-Translate-35B-A3B` | 200 | `Index-Translate-35B-A3B` | 1,385ms | 138 字元，`finish=stop` |
| `index-mt-9b` | 200 | `qwen35-9b-6624275-iter999` | 583ms | 137 字元，`stop` |
| `index-mt-2b` | 200 | `qwen35-2b-linear-merge` | 316ms | 137 字元，`stop` |
| `index-mt-9b-syllable` | 200 | `index-homura-9b` | 385ms | 66 字元，`stop` |
| `index-mt-2b-syllable` | 200 | `qwen35-2b-grpo-hindsight` | 277ms | 57 字元，`stop` |
| `index-homura-35b-a3b`（已撤回） | 400 | — | 65ms | `detail` 自報白名單 |
| `Index-Translate-35B-A3B-preview` | 200 | `Index-Translate-35B-A3B`（**靜默退回**） | 503ms | 同上 |
| `""`（空字串） | 200 | `Index-Translate-35B-A3B`（**靜默選了預設**） | 492ms | 同上 |

→ **2B 與 9B 真的可以調用**，而且明顯比 35B 快。回顯名稱是上游的**內部部署名**，不是可再次使用的模型名（把它送回去會 400），所以回顯值只能用來辨認「跑的其實是那個部署」，不能當模型清單。

## 3. 能不能用：編號行對應（`lines` 群組，8 行 zh→en）

沉浸式翻譯靠「編號行」把譯文對應回原文，所以**行對應比能不能翻更重要**。

| model | 輸入行 | 輸出帶編號的行 | 看到什麼 |
|---|---|---|---|
| `Index-Translate-35B-A3B` | 8 | **8/8** | 逐行對應 |
| `index-mt-9b` | 8 | **8/8** | 逐行對應（用時 1,078ms） |
| `index-mt-2b` | 8 | **8/8** | 逐行對應（用時 545ms） |
| `index-mt-9b-syllable` | 8 | **1/8** | 只回第一行就 `finish=stop` → **漏行** |
| `index-mt-2b-syllable` | 8 | **0/8** | 把編號丟掉、8 行併成一段 → **錯位** |

## 4. 決定

- **放行**：`Index-Translate-35B-A3B`（主）、`index-mt-9b`、`index-mt-2b`。清單只有一份：`src/lib/model.js`。
- **不放行**：兩個 `-syllable`。它們「能跑但會錯位」，對插件來說比 400 更糟；400 的訊息會直接說出原因（「我們測過：會漏行／會丟掉編號」）。
- **不放行**：`-preview`、空字串這類**靜默退回**的名字——使用者以為選的是 A，跑的其實是 B，正是規則 1 要避免的事。
- 上游回顯的內部部署名**不得**當成可選模型（未验证能否送回）。
- `GET /v1/models` 由**本代理自己回**放行清單：上游那份只有 35B-A3B，照抄會跟我們實際放行的不一致，而且每次要多花一次上游配額（與「刻意不做」裡「模型探測不划算」同一結論）。這也改掉原本「`/v1/models` 只透傳」的做法（規則 5 的例外只有根路徑與模型清單）。

## 5. 還沒證明（不要當成事實）

- 2B/9B 的**翻譯品質**沒有評量過（只驗證行對應與完成原因）。要拿它當「更差的模型」或「更便宜的模型」來推薦，都還缺依據。
- 小模型是否比較省 token／比較不觸發 429：未測。
- 上游會不會像撤回 `index-homura-*` 那樣撤回 `index-mt-2b/9b`：**很可能會**。所以 400 的訊息要一直把可用清單講完整，`probe-live` 也要繼續測這條。
- 行對應只在 zh→en、8 行這個形状下驗證過；其他語言方向與更長輸入未測。
