# design/deploy-button.md — 「Deploy to Cloudflare」一鍵按鈕

狀態：**建議做，但有前置條件**（2026-10-10 查證，CF 文件最後更新 2026-07-22）。

## 它是什麼

README 裡的一顆按鈕，點下去後 Cloudflare 會：把我們的 repo **複製到使用者自己的 GitHub／GitLab 帳號**、
在一個設定頁讓他改 repo 名／Worker 名／資源名、依 `wrangler.toml` **自動開所需資源並綁定**、
用 Workers Builds 建置並部署到他自己的帳號。

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Lawlietr/Index-Translate-Proxy)
```

Secrets 由 repo 裡的 `.dev.vars.example`（dotenv 格式）宣告，按鈕流程會**提示使用者填寫**——
正好對應 [`auth.md`](auth.md) 的 `ITP_KEY`：他填什麼，插件的 API Key 欄位就填同一串。

## 硬性限制（決定我們能不能做）

| 文件的限制 | 對本 repo 的意義 |
|---|---|
| **只支援 github.com 與 gitlab.com；self-hosted 的 GitHub／GitLab 不支援** | 我們的 `origin` 是自建 Forgejo（`ssh://fg/lawliet/…`）→ **必須先有公開鏡像**，按鈕才可用 |
| repo 必須是 public | 鏡像要公開；MIT 授權無衝突 |
| 只支援 Workers 應用（不支援 Pages） | 我們就是純 Worker ✓ |
| monorepo 支援不完整，子目錄要完全自閉 | 我們是單一 Worker、repo 根就是專案 ✓ |

另外兩個我們自己的前置條件：
1. `wrangler.toml` 的 `main = "src/worker.js"` 目前是註解掉的（骨架階段）→ 按鈕流程會找不到入口。**要有程式碼才開這顆按鈕**，與規則 12「先有程式碼才建 CI」同一個道理。
2. 綁定要有可用的預設值：`[[ratelimits]]` 的 `namespace_id` 用固定整數（`auth.md` 已定 1001），
   如此別人的帳號裡也能直接部署，不需手動補 ID。

## 建議做法

1. **做**，但排在 `src/` 與鑑權之後（TODO 的順序），因為按了卻跑出 404 的 worker 比沒按鈕更糟。
2. 鏡像到 **GitHub 公開 repo**（Forgejo 自帶 mirror push 設定即可）。`origin` 仍以自建 Forgejo 為主，
   CI 照規則 12 留在 `.forgejo/workflows/`；README 註明「GitHub 只是鏡像，issue 請到主 repo」。
3. README 放兩條路，不要只放按鈕：
   - **按鈕**：要自己一份的人（自備 Cloudflare 帳號）。
   - **三行手動**：`git clone` → 填 `.dev.vars`（`ITP_KEY`）→ `npx wrangler deploy`。
     給不想把 repo 放到 GitHub 的人，也是按鈕失敗時的退路。
4. 別把按鈕當成主要入口：本專案對**插件使用者**的答案是我們自己那份公開 worker（填網址就能用）；
   按鈕服務的是「想自己掌控一份」的開發者。README 的章節順序照這個優先級排。

## 鏡像（已定，2026-10-10）

- 主 repo：自建 Forgejo（`ssh://fg/lawliet/Index-Translate-Proxy.git`，remote 名 `origin`）。
- 公開鏡像：`git@github.com:Lawlietr/Index-Translate-Proxy.git`（remote 名 `github`）。
  本機已驗證可讀寫（`ssh -T git@github.com` → Lawlietr；`git ls-remote` 通過且該 repo 現為空）。
- 推播：`git push origin main && git push github main`，或改用 Forgejo 自帶的 mirror push 自動同步。
- **按鈕能用的硬條件**：GitHub 那份必須是 public。若維持 private，按鈕會打不開，README 就別放。
- README 要註明：GitHub 只是鏡像，issue／PR 請到主 repo；CI 照規則 12 只在 `.forgejo/workflows/`，
  GitHub 那邊不要建 Actions。

## 待決定

- GitHub 那份要不要設為 public（開按鈕的硬條件）。
- 按鈕何時放進 README（建議等 `src/` 與鑑權可用後，TODO 10）。
