# onagent 並發/穩定性稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。安全性發現另外記在 `docs/audit-security.md`；純命名/死碼/架構債等靜態程式碼品質問題記在 `docs/audit-functional.md`。本檔案只收 race condition、deadlock、goroutine 洩漏、panic/crash 風險、資源未清理等**執行期**、無安全後果的並發或穩定性問題。

---

## 初始建檔：2026-08-16（內容取自 2026-07-25 三方 triage 的可執行部分）

> 方法：原始內容來自三個 Opus subagent（工程師/架構師/測試專家角色）於 2026-07-25 對核心路徑做的穩定性 triage，2026-08-16 依 `audit-*` 格式規則拆分建檔——只保留描述**現行程式碼中真實存在的並發/穩定性缺陷**的項目，並對照現行程式碼複核仍然成立；純建議性質（指標、CI、整合測試覆蓋率等）留在 `docs/research-stability-triage-2026-07-25.md`。

### 🟠 `ws.Session.run()` 斷線時未取消進行中的 `Complete()` 呼叫
- **位置**：`backend/internal/ws/session.go:85-124`（`run`）、`:225-275`（`handlePrompt`，內部呼叫 `s.infer.Complete(ctx, ...)`，271 行）
- **問題**：`run(ctx)` 收到的 `ctx` 是 `ws/handler.go:162` 傳入的 `r.Context()`（HTTP upgrade 請求的 context）。當客戶端斷線，`s.conn.ReadMessage()`（110 行）會因連線錯誤返回，`run` 就此 `return`；但這**不會**取消已經用 `go s.handlePrompt(ctx, ...)` 分派出去、正在跑 `Complete()` 的 goroutine——因為那個 goroutine 拿到的 `ctx` 只在 HTTP request context 被取消時才會結束，而 WebSocket 斷線不等於 HTTP request context 被取消。`Complete()` 最長可跑到 `completeTimeout`（~90 秒），且會佔用該 session 的 orchestrator 資源直到逾時或完成。
- **影響**：使用者關掉分頁或斷線後，一個已經沒有人在等待結果的推論呼叫仍會繼續佔用資源長達 90 秒；若疊加 `docs/audit-functional.md` 已追蹤的「completeTimeout 分支未呼叫 `Interrupt()`」，這條殘留呼叫完成後產生的事件還可能污染同一 session 之後新建立的推論（見該檔案交叉引用）。
- **修法**：在 `NewSession`/`run` 內用 `context.WithCancel` 包一層獨立於 HTTP request context 的 ctx，`ReadMessage` 因錯誤返回時明確呼叫該 cancel，讓正在進行的 `handlePrompt`/`Complete` 呼叫能真正被中斷。
- **現況**：確認仍未修復（2026-08-16 對照現行程式碼複核）。

### ⚪ `/healthz` 無條件回 200，不反映資料庫健康狀態
- **位置**：`backend/cmd/server/main.go:249-252`
- **問題**：`healthz` handler 無條件 `w.WriteHeader(http.StatusOK)`，完全不檢查資料庫連線或任何下游依賴。資料庫斷線、auth/quota 全部故障的情境下，這個健康檢查端點依然回報「健康」，導致 load balancer/Cloud Run 繼續把流量導向一個實際上壞掉的執行個體。
- **修法**：改成帶短逾時（例如 2 秒）的 `db.PingContext`，DB 不可達時回非 200；可考慮另加 `/readyz` 區分 liveness 與 readiness。
- **現況**：確認仍未修復（2026-08-16 對照現行程式碼複核）。此項目與 `docs/audit-functional.md` 有重疊記錄（該檔案在「低優先」清單裡也提過一句）——`audit-functional.md` 的版本予以移除，改由本檔案作為單一真相來源追蹤，避免兩處各自更新現況導致對不上。

---

## 進行中的發現（依嚴重度排序）

（目前與上方「初始建檔」相同，尚無跨掃描的歷史差異。下次複核起，這裡才會出現「現況（YYYY-MM-DD 複核）」的持續追蹤記錄。）

---

## 已複核為安全/已解決的項目

（尚無）
