# design/deploy-button.md — 一鍵部署按鈕（Vercel 為主，CF 為附）

狀態：**Vercel 按鈕已在 README**（按鈕 2026-10-10 進 README；2026-10-11 用 API 確認參數被接受）。
CF 按鈕**不放**：從 CF 出口打上游會 412（[`egress-options.md`](egress-options.md)），
部署出來的實例打不到上游——按了不能用，比沒按鈕更糟。

## 現在 README 裡的那顆

```
https://vercel.com/new/clone?
  repository-url=https://github.com/Lawlietr/Index-Translate-Proxy
  project-name=index-translate-proxy
  repository-name=index-translate-proxy
  env=ITP_KEY
  envDescription=你自己設定的通行碼（openssl rand -hex 32）
  envLink=https://github.com/Lawlietr/Index-Translate-Proxy/blob/main/README.md
```

- `env=ITP_KEY` 讓流程**直接要求填 key**（不是選填），對應 [`auth.md`](auth.md)：他填什麼，
  插件的「API Key」欄位就填同一串。
- `envLink` 指回 README 的部署段——產生 key 的指令在那裡，指向 `.dev.vars.example` 反而繞路。
- 專案沒有構建步驟；`vercel.json` 的 `{"functions":{"api/**/*.js":{"runtime":"edge"}}}` 就是全部設定
  （Edge runtime 的必要性見 AGENTS 規則 16）。
- 手動路線（Import repo → 加 `ITP_KEY` → Deploy）永遠留在 README，按鈕失敗時就是退路。

按鈕流程會把 repo **複製到使用者自己的 GitHub 帳號**、建立他自己的 Vercel 專案，
所以每個人的部署各有自己的 key 與自己的出口配額——這正是本專案的預期的用法
（定位見 AGENTS「刻意不做」：不做公共共用實例）。

## 鏡像與推播

- 主 repo：自建 Forgejo（remote 名 `origin`）。公開鏡像：GitHub `Lawlietr/Index-Translate-Proxy`（remote 名 `github`）。
- 推播是手動 `git push origin main && git push github main`；改成 Forgejo 的 mirror push 與否＝未決定（TODO）。
- CI 只在 `.forgejo/workflows/`（規則 12）；README 註明「GitHub 只是鏡像，issue／PR 請到主 repo」。
- 按鈕只認 github.com／gitlab.com，且 repo 必須 public → 鏡像是前置，已成立（2026-10-10 確認）。

## 當時的前置（2026-10-10 寫的，全部已完成）

| 前置 | 結果 |
|---|---|
| `wrangler.toml` 要有可用的 `main` | ✓ `src/worker.js`（CF 入口保留但不再是主入口） |
| repo 要有 `.dev.vars.example` | ✓ 有（本地開發用；Vercel 側讀 Environment Variables） |
| `[[ratelimits]]` 要有可用的 `namespace_id` | ✗ 不需要了：速率閘改成程序內計數，`wrangler.toml` 已不宣告（[`auth.md`](auth.md) 定案 6） |
| 要有 `src/` 與鑑權才開按鈕 | ✓ 都已實裝（規則 1–9） |
