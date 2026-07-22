# onagent 專案健檢報告（2026-07-22）

> 產出日期：2026-07-22。方法：三個唯讀 Explore subagent 平行掃描（1. 後端架構/安全 2. 程式碼品質/測試覆蓋率/文件落差 3. DevOps/CI/CD/部署），主線程交叉彙整。與 `project-audit.md`（2026-07-15 稽核）是互補關係，非取代——本報告涵蓋範圍更廣（含 DevOps、測試覆蓋率、文件狀態），但對已知安全問題的深度不如該份稽核，兩份建議合併參考。
>
> 嚴重度標記：🔴 高｜🟡 中｜🟢 低/觀察項

---

## 🔴 高優先（安全/穩定性相關）

### 1. 跨租戶 tool 洩漏（S1，已知但仍存在）
`want` 依賴的 `GlobalRegistry.Declarations` 是 append-only、`GetTools` 是 first-match-wins（`want/types/registry.go:29-32`、`want/internal/toolbox.go:34`）——與既有 memory 記錄一致，目前仍未修。更嚴重的是 `backend/internal/inference/agent_roles.go:71-73` 的註解仍宣稱「cross-app tool leakage isn't possible」，這句話已被證實是錯的，屬於誤導性註解，需與底層 bug 一併修正，避免誤導後續開發者。詳細攻擊情境與修法見 `project-audit.md` 的 S1 章節。

### 2. Orchestrator 序列化（A1，已知但仍存在）
`want/orchestrator/init.go:28` 仍硬編碼 `NewRequestQueue(1, 100*time.Millisecond)`，`backend/internal/inference/want.go:69,92-93` 一個 mutex 鎖住整個 `Complete()` 呼叫（最長可達 90 秒）——與既有 memory 記錄的「一個共用 orchestrator 序列化全部使用者對話輪次」問題一致，尚未解決。

### 3. 完全沒有 panic-recovery
`backend/` 整個 repo 沒有任何 `recover()`（grep 零命中），HTTP mux 與 WS handler 都沒有 panic-recovery middleware。任一 request handler 或 `session.go:112`、`playground.go:148` 裡的 goroutine 一旦 panic，會讓整個 process 直接崩潰、影響所有連線中的使用者——疊加第 2 點的單一 orchestrator，代表一次邊界情況就能造成全服務中斷。

### 4. CI/CD 部署前沒有跑測試
`deploy-cloudrun.yml`、`release-onagent.yml` 兩個 workflow 皆無 `go test`/`go vet` 步驟（grep 零命中）。目前流程是「build 完直接上生產環境」，沒有自動化安全網；也沒有 rollback 腳本或文件化的 rollback SOP（Cloud Run 本身保留舊 revision 可手動切流量，但無腳本化流程）。

### 5. 沒有安全 headers、沒有 rate limiting
`backend/cmd/server/main.go` 未設定任何 CSP/HSTS/X-Frame-Options/X-Content-Type-Options（grep 零命中）。除了 `quota.Service`（僅於 WS handshake 與逐 prompt 檢查，DB 錯誤時 fail-open）外，沒有任何 per-IP 或連線數的 rate limiting。

---

## 🟡 中優先

- **測試覆蓋率偏低**：Go 後端 14 個 `internal/` package 只有 4 個（`adminauth`、`adminconsole`、`db`、`quota`，29%）有測試，且多為 `*_integration_test.go`（需真實 DB）。`auth`、`ws`、`session`、`usertoken`、`cliauth`、`inference`（LLM 核心邏輯）等安全/核心敏感模組完全沒有單元測試。前端（`apps/console`、`apps/admin`、`packages/bridge`）**零測試**，`package.json` 連 test script 都沒有。`quota/quota_test.go`（222 行）是最完整的測試，顯示團隊有測試意識但尚未鋪開。
- **`playground.go` 同步阻塞模式（A2，已知但仍存在）**：不同於 `ws/session.go:112` 用 `go func()` dispatch，playground 的 prompt 迴圈直接在讀 `conn.ReadMessage()` 的同一 goroutine 內同步呼叫 `Inference.Complete`。
- **日誌內含完整明文對話紀錄**：`backend/tmp/logs/*.json` 有 gitignore 保護（不會進 repo），但硬碟上是無限保留、無 redaction、無 rotation 的完整對話與 system prompt 明文。此記錄行為來自 `want` 依賴本身（`want/internal/provider/vllm.go`），非 onagent 自有程式碼，但任何跑這個 backend 的機器都會累積使用者資料，屬營運面資料保存風險。
- **前後端程式碼重複**：`apps/console/src/api.ts` 與 `apps/admin/src/api.ts` 幾乎是複製貼上的同一份 fetch wrapper（相同的 `ApiError`、`credentials: 'include'` 模式、`BASE` 環境變數 fallback）。已有 `packages/bridge` 先例，值得抽出共用 package。
- **`subscription-usage-quota-design.md` 文件過時**：文件開頭寫「onagent 目前完全沒有計費/訂閱/配額機制」，但 `backend/internal/quota/` 已完整實作該設計（`Check`/`Record`/`StandingFor`），且 console/admin 前端都已在消費 `Quota`/`UserSummary` API。文件狀態需更新。
- **Cloud SQL 夜間自動關機沒有自動重啟**：`setup-nightly-sql-shutdown.sh` 每晚 23:00（Asia/Taipei）自動關閉 DB 省錢，但沒有對應的自動重啟排程——需人工每天早上手動執行 `gcloud sql instances patch ... --activation-policy=ALWAYS`，忘記則服務直接中斷、無自動復原。
- **`PROJECT_ID="onagent-prod"` 散落至少 4 處各自硬編碼**（3 支 deploy 腳本 + `deploy-cloudrun.yml`），無單一真相來源，變更專案 ID 需同步改多處。
- **`want`（package-level `askers` map）無 TTL/eviction**：stale entries 在 process 重啟前持續累積（A4 相關，低嚴重度但與觀察項相關，故列於此）。

---

## 🟢 低優先/觀察項

- **完全沒有監控告警**：無 Sentry/Datadog/Prometheus/Grafana 等工具接入；`/healthz` 端點存在（`main.go:247` 附近）但沒有外部服務定期戳它，僅在 `docs/deployment.md` 供人工部署後檢查用。
- **Monorepo 內前端版號跨專案不一致**：`apps/console`/`apps/admin` 用 React `^18.3.1` + TypeScript `^7.0.2` + Vite `^6`；`examples/react-demo` 用 React `^19.2.7` + Vite `^8.1.1`。TypeScript `^7.0.2` 這個版號較可疑，值得確認是否為筆誤（TS 7 於此文件涉及的時間點應尚未正式發布）。
- **CI 未接 secret-scanning 工具**（如 gitleaks/trufflehog），完全依賴 `.gitignore` 紀律與人工審查。目前 sanity check 未發現任何已提交的真實機密（`examples/analysis/.env` 雖被追蹤，但內容僅為 `ws://localhost:8080/ws`，非機密）。
- **兩個 Dockerfile（`Dockerfile`、`Dockerfile.release`）皆無 `HEALTHCHECK` 指令**：Cloud Run 有自己的健康檢查機制，非致命缺口，但若 `Dockerfile.release` 被用於其他 orchestrator（其設計初衷）則會缺這一環。
- **`ws/session.go:84-91`**：`ctx.Done()` 只在 `ReadMessage()` 呼叫之間檢查，非呼叫期間即時響應，shutdown 不保證即時（最長可能等到 60 秒 pong timeout）。

---

## 值得肯定的地方

- **資料庫存取安全基本功扎實**：SQL 全面走參數化查詢（`$N` 佔位符）、密碼用 bcrypt DefaultCost、session cookie 正確設定 httpOnly/Secure/SameSite=None-with-Secure、CSRF 透過嚴格 origin-gated CORS 緩解。
- **Docker 建置流程成熟**：multi-stage build、`CGO_ENABLED=0` 靜態編譯、distroless **nonroot** base image、`--secret` mount 避免 `GH_PAT` 進入 layer history、`go.mod`/`go.sum` 分離拷貝做 layer caching。
- **GCP 認證走 Workload Identity Federation**，非長期 JSON key，是較進階且正確的做法。
- **`.dockerignore` 有紀錄過去事故的註解**（`apps/console/.env.local` 曾被誤烤進生產 console bundle），已修正並留下教訓紀錄，屬於良好的事後改進文化。
- **多數設計文件誠實自我標註狀態**（例如 `oauth-third-party-clients-design.md`、`cli-device-flow-design.md` 開頭即寫明「未實作/設計提案」），文件與現況落差比預期小。
- **`quota` 子系統測試最完整**（`quota_test.go` 222 行涵蓋邊界情況），是最新、最複雜的模組卻也是測試覆蓋率最高的，顯示測試意識存在、只是尚未推廣到全部模組。
- **deploy 腳本安全意識到位**：`setup.sh` 有明確的 `set -euo pipefail`、建立可能產生費用的資源前有互動式確認、`set-ai-provider-secrets.sh` 用 `read -s` 讀取機密避免留在 shell history。

---

## 建議優先順序

1. **跨租戶 tool 洩漏（🔴1）** 與 **orchestrator 單點故障 + 無 panic recovery（🔴2、🔴3）**——後兩者疊加意味著一次意外就能讓全服務中斷，風險最高且影響範圍最集中，建議優先處理。
2. **CI 部署前加測試關卡（🔴4）** 與 **安全 headers/rate limiting（🔴5）**——修正成本相對低，能立即降低意外部署與濫用風險。
3. 其餘 🟡 中優先項目可依團隊頻寬排入 backlog，🟢 觀察項可留待相關功能擴充時一併處理。
