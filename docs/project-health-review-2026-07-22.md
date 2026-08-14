# onagent 專案健檢報告（2026-07-22）

> 產出日期：2026-07-22。方法：三個唯讀 Explore subagent 平行掃描（1. 後端架構/安全 2. 程式碼品質/測試覆蓋率/文件落差 3. DevOps/CI/CD/部署），主線程交叉彙整。與 `project-audit.md`（2026-07-15 稽核）是互補關係，非取代——本報告涵蓋範圍更廣（含 DevOps、測試覆蓋率、文件狀態），但對已知安全問題的深度不如該份稽核，兩份建議合併參考。
>
> 嚴重度標記：🔴 高｜🟡 中｜🟢 低/觀察項

---

## 🔴 高優先（安全/穩定性相關）

### 1. Orchestrator 序列化（A1）——**物件隔離已修復，吞吐量瓶頸仍未解決**
want v0.2.0 起，`WantService` 已改成每個 SessionID 各自獨立的 `*orchestrator.Orchestrator`，取代原本一個共用 orchestrator + mutex 鎖住整個 `Complete()` 的設計，對話內容層級已是真正的物件隔離。但每個 session 的 orchestrator 仍然共用同一個 process-wide 的 `GlobalEngine`/`RequestQueue`（仍硬編碼 `maxConcurrent=1`）——**吞吐量仍然完全序列化**，只是不再需要應用層 mutex 保護欄位互換。詳見 `docs/known-issues-want-dependency.md`。

### 2. CI/CD 部署前沒有跑測試
`deploy-cloudrun.yml`、`release-onagent.yml` 兩個 workflow 皆無 `go test`/`go vet` 步驟（grep 零命中）。目前流程是「build 完直接上生產環境」，沒有自動化安全網；也沒有 rollback 腳本或文件化的 rollback SOP（Cloud Run 本身保留舊 revision 可手動切流量，但無腳本化流程）。

### 3. 沒有安全 headers、沒有 rate limiting
`backend/cmd/server/main.go` 未設定任何 CSP/HSTS/X-Frame-Options/X-Content-Type-Options（grep 零命中）。除了 `quota.Service`（僅於 WS handshake 與逐 prompt 檢查，DB 錯誤時 fail-open）外，沒有任何 per-IP 或連線數的 rate limiting。

---

## 🟡 中優先

- **測試覆蓋率偏低**：Go 後端 14 個 `internal/` package 只有 4 個（`adminauth`、`adminconsole`、`db`、`quota`，29%）有測試，且多為 `*_integration_test.go`（需真實 DB）。`auth`、`ws`、`session`、`usertoken`、`cliauth`、`inference`（LLM 核心邏輯）等安全/核心敏感模組完全沒有單元測試。前端 `apps/admin`、`packages/bridge` 仍是**零測試**；`apps/console` 已補上 vitest + jsdom（2026-08-07，`ThoughtEditor.markdown.test.ts`，14 個測試涵蓋 Markdown 編輯的字元/段落層級狀態），但僅此一支測試檔，其餘元件（`App.tsx`、`Sidebar.tsx` 等）仍未覆蓋。`quota/quota_test.go`（222 行）是後端最完整的測試，顯示團隊有測試意識但尚未鋪開。
- **`playground.go` 同步阻塞模式（A2，已知但仍存在）**：不同於 `ws/session.go:112` 用 `go func()` dispatch，playground 的 prompt 迴圈直接在讀 `conn.ReadMessage()` 的同一 goroutine 內同步呼叫 `Inference.Complete`。
- **日誌內含完整明文對話紀錄**：`backend/tmp/logs/*.json` 有 gitignore 保護（不會進 repo），但硬碟上是無限保留、無 redaction、無 rotation 的完整對話與 system prompt 明文。此記錄行為來自 `want` 依賴本身（`want/internal/provider/vllm.go`），非 onagent 自有程式碼，但任何跑這個 backend 的機器都會累積使用者資料，屬營運面資料保存風險。
- **前後端程式碼重複**：`apps/console/src/api.ts` 與 `apps/admin/src/api.ts` 幾乎是複製貼上的同一份 fetch wrapper（相同的 `ApiError`、`credentials: 'include'` 模式、`BASE` 環境變數 fallback）。已有 `packages/bridge` 先例，值得抽出共用 package。
- **`PROJECT_ID="onagent-prod"` 散落多處各自硬編碼**（deploy 腳本 + `deploy-cloudrun.yml`），無單一真相來源，變更專案 ID 需同步改多處。
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

1. **orchestrator 吞吐量瓶頸（🔴1）**——影響範圍最集中，但根治需要改 `want` 本身，屬長期項目。
2. **CI 部署前加測試關卡（🔴2）** 與 **安全 headers/rate limiting（🔴3）**——修正成本相對低，能立即降低意外部署與濫用風險。
3. 其餘 🟡 中優先項目可依團隊頻寬排入 backlog，🟢 觀察項可留待相關功能擴充時一併處理。
