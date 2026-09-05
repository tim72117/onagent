# onagent 並發/穩定性稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。安全性發現另外記在 `docs/audit-security.md`；純命名/死碼/架構債等靜態程式碼品質問題記在 `docs/audit-functional.md`。本檔案只收 race condition、deadlock、goroutine 洩漏、panic/crash 風險、資源未清理等**執行期**、無安全後果的並發或穩定性問題。

---

## 最新掃描結果：2026-09-05（panic/crash 風險與資源管理專項複核）

> 方法：單一 agent 對 `backend/` 全樹（37 個非測試 `.go` 檔）做針對性掃描，聚焦使用者要求的四類風險——nil pointer dereference、未檢查的型別斷言（無 comma-ok）、陣列/slice 越界、檔案/連線/timer 資源未正確關閉或清理。重點覆蓋 `backend/internal/ws/`、`backend/internal/console/`、`backend/cmd/server/`，其餘 `internal/*`（auth、session、sessionstore、toolschema、quota、adminconsole、googleauth、inference）與 `cmd/*`（genkey、migrate、onagent）亦逐檔複核。方法：`grep` 掃出全部型別斷言與 `.Close()`/timer/goroutine 建立點，逐一讀取上下文判斷是否有 comma-ok 保護、是否有競態視窗、逾時/取消路徑是否完整。

### 🟠 `console.setOrigin`/`setThought`/`saveTools` 在 app 被併發刪除時對 nil `*App` 解參考，導致 panic
- **位置**：`backend/internal/console/console.go:507-528`（`setOrigin`）、`:536-558`（`setThought`）、`:560-583`（`saveTools`），三者都在 `app, _ := h.Apps.Get(appID)` 後直接讀 `app.Tools`/`app.Thought`，忽略回傳的 `ok`。
- **問題**：這三個 handler 都掛在 `withOwnedApp` 之後（`console.go:147-149`），`withOwnedApp` 只驗證呼叫者在**呼叫當下**擁有這個 appId——它對資料庫做的是即時查詢（`ownedAppOrNotFound` → `Registry.OwnerOf`，見 `registry.go:162-169`），不是快取。而 `h.Apps.Get(appID)`（handler 內部第二次呼叫）讀的是 `toolschema.Registry` 的記憶體快取 `r.apps`（`registry.go:74-79`），這個快取由 `Delete`/`Save`/`Create` 各自呼叫 `Reload()` 整份替換（`registry.go:97-106`，`r.mu.Lock()` 保護下整份 swap）。
- **觸發情境**：同一個擁有者對同一個 app 開兩個並發請求——例如瀏覽器一個分頁按下「刪除 App」（`DELETE /console/apps/{appId}` → `deleteApp` → `h.Apps.Delete(appID)`，`console.go:585-596`），幾乎同時另一個分頁或背景重試送出 `PUT /console/apps/{appId}/origin`（或 `/thought`、`/tools`）。若 `setOrigin` 的 `withOwnedApp` 檢查發生在 `Delete` 真正提交之前，但 `h.Auth.SetOrigin`／`h.Apps.Get` 執行時 `Delete` 的 `Reload()` 已經跑完，`h.Apps.Get(appID)` 就會回傳 `(nil, false)`；handler 忽略 `ok`，緊接著 `len(app.Tools)` 或 `app.Thought` 對 nil `*App` 解參考，直接 panic。同理，`h.Auth.SetOrigin`/`SetThought`/`Save` 本身操作的是資料庫（不是快取），對已刪除的 app 這些呼叫可能因為 `RowsAffected == 0` 提早回 400（見 `registry.go:186-188`、`auth.go:195-197`）——但這只在 DB 層的刪除也已提交時才會擋下；`saveTools` 呼叫的是 `Registry.Save`（upsert 語義，`registry.go:112-120`），app 已被刪除時 `Save` 會重新把 app 的殼建回去（因為它用 `OnConflict DoNothing` upsert app row，見 `registry.go:278-283`），於是 `saveTools` 自己的 `h.Apps.Get` 反而不會踩到這個洞；風險主要集中在 `setOrigin`/`setThought`，因為它們呼叫的 `SetOrigin`/`SetThought` 都是「app 必須已存在才能更新欄位」的 `Update`，一旦競態视窗抓到 app 已被刪、`RowsAffected==0` 就會提早回錯誤而不會走到 `h.Apps.Get`——需要更精確的競態視窗是：`withOwnedApp` 查完 ownership 之後、`h.Auth.SetOrigin` 呼叫之前，`Delete` 完成了資料庫刪除與 `Reload()`；如果 `SetOrigin` 恰好在 `Delete` 的 DB 事務提交後、`Reload` 之前執行，`SetOrigin` 一樣會因為 `RowsAffected==0` 回錯誤，不會 panic——真正會 panic 的視窗是 `SetOrigin`（資料庫更新）成功之後（也就是 app row 在資料庫裡当下還沒被刪），但 `h.Apps.Get` 讀到的記憶體快取剛好因為另一個並發的 `Delete`→`Reload()` 把整份 `r.apps` 換掉、拿掉了这个 appId——這是可能發生的，因為 `SetOrigin`（DB update）跟 `h.Apps.Get`（讀記憶體快取）中間有時間差，且兩者不共用鎖。
- **影響**：該 HTTP 請求對應的 goroutine panic；由 `cmd/server/main.go:354-364` 的 `recoverMiddleware` 攔截，不會打垂其他使用者的連線，但這個請求本身回 500，且每次撞到這個競態視窗都會在日誌留下一次 panic stack trace。
- **修法**：`setOrigin`/`setThought` 在 `h.Apps.Get(appID)` 回傳 `ok=false` 時應該明確處理（回 404 或改用 `SetOrigin`/`SetThought` 呼叫本身回傳的欄位值組裝 response，不依賴第二次 `Get`），而不是無條件解參考。`saveTools` 目前因為 `Save` 的 upsert 語義而不會 panic，但同樣應該加上 `ok` 檢查以求一致與防禦未來行為變更。
- **現況**：新發現（2026-09-05）。

### ⚪ `cmd/onagent/main.go` 的 `callbackHandler` 對共享變數 `done` 無同步保護
- **位置**：`backend/cmd/onagent/main.go:246-276`（`callbackHandler`），閉包捕捉的 `var done bool`（第 247 行）在返回的 `http.HandlerFunc` 裡被讀寫（第 258、261 行），沒有 mutex 或 atomic 保護。
- **問題**：`net/http.Server` 對每個進來的請求各自起一個 goroutine 執行 handler；`onagent login --web` 啟動的本地回呼伺服器（`main.go:196-198`）理論上只會收到一次真正的 OAuth callback，但瀏覽器的預抓取（prefetch）、使用者手動重新整理、或惰性 favicon 請求都可能在極短時間內觸發第二個並發請求。雖然文件註解說明「result 是 size-1 channel，第二個請求只會拿到同樣的頁面，不會 block 或 panic」，但 `done` 這個 bool 本身的讀寫沒有同步：兩個 goroutine 同時讀到 `done == false`，都會執行 `done = true` 後續的兌換流程，各自對 `result`（size-1、無 buffer 保護第二次寫入）送一次 `callbackResult`——第二次 send 在沒有 receiver 讀取的情況下會永久阻塞該 goroutine（`result` 是 unbuffered 語義上的 size-1，第一次 send 已經填滿緩衝區，第二次 send 在 select 於 `runLoginWeb`（第 215-227 行）已經因為第一次 send 而 return 之後，永遠沒有人再讀，goroutine 洩漏直到程式退出）。
- **影響**：CLI 是短生命週期的一次性程序（`runLoginWeb` 完成後主程式就退出），實際資源影響很小；已知風險是 data race（`go test -race`／併發存取偵測會抓到）與極端情況下對 backend 呼叫 `client.exchangeCliAuth(code)` 兩次——`internal/cliauth.Exchange`（single-use、"already collected" 語意）會讓第二次呼叫失敗，不會造成安全問題，但那個 goroutine 就此卡住直到 `main()` 返回、程式結束才釋放。
- **修法**：把 `var done bool`換成 `sync.Once` 或 `atomic.Bool`，用 `done.CompareAndSwap(false, true)`（或 `Once.Do`）保證只有一個 goroutine 真正執行兌換與 channel 送值；或者把 `result` channel 容量與寫入邏輯改成非阻塞 send（`select { case result <- ...: default: }`）避免任何一次多餘的 send 卡住 goroutine。
- **現況**：新發現（2026-09-05）；優先度低——僅影響短命 CLI 程序，且既有的「single-use exchange」後端邏輯已經是實質上的防線，這裡缺的只是 CLI 端自己的同步。

---

## 初始建檔：2026-08-16（內容取自 2026-07-25 三方 triage 的可執行部分）

> 方法：原始內容來自三個 Opus subagent（工程師/架構師/測試專家角色）於 2026-07-25 對核心路徑做的穩定性 triage，2026-08-16 依 `audit-*` 格式規則拆分建檔——只保留描述**現行程式碼中真實存在的並發/穩定性缺陷**的項目，並對照現行程式碼複核仍然成立；純建議性質（指標、CI、整合測試覆蓋率等）留在 `docs/research-stability-triage-2026-07-25.md`。

### 🟠 `ws.Session.run()` 斷線時未取消進行中的 `Complete()` 呼叫
- **位置**：`backend/internal/ws/session.go:85-124`（`run`）、`:225-275`（`handlePrompt`，內部呼叫 `s.infer.Complete(ctx, ...)`，271 行）
- **問題**：`run(ctx)` 收到的 `ctx` 是 `ws/handler.go:162` 傳入的 `r.Context()`（HTTP upgrade 請求的 context）。當客戶端斷線，`s.conn.ReadMessage()`（110 行）會因連線錯誤返回，`run` 就此 `return`；但這**不會**取消已經用 `go s.handlePrompt(ctx, ...)` 分派出去、正在跑 `Complete()` 的 goroutine——因為那個 goroutine 拿到的 `ctx` 只在 HTTP request context 被取消時才會結束，而 WebSocket 斷線不等於 HTTP request context 被取消。`Complete()` 最長可跑到 `completeTimeout`（~90 秒），且會佔用該 session 的 orchestrator 資源直到逾時或完成。
- **影響**：使用者關掉分頁或斷線後，一個已經沒有人在等待結果的推論呼叫仍會繼續佔用資源長達 90 秒；若疊加 `docs/audit-functional.md` 已追蹤的「completeTimeout 分支未呼叫 `Interrupt()`」，這條殘留呼叫完成後產生的事件還可能污染同一 session 之後新建立的推論（見該檔案交叉引用）。Console 的 Playground 功能改用共用 `ws.Session`（見 `docs/audit-functional.md` 的 A2「已解決」條目）後，這段程式碼現在同時服務兩種連線——真實 Agent Bridge SDK 的連線，以及 Console 開發者自己開的 Playground 連線；開發者在 console 裡關閉 Playground 分頁，同樣會留下最長 90 秒的殘留 `Complete()` 呼叫。
- **修法**：在 `NewSession`/`run` 內用 `context.WithCancel` 包一層獨立於 HTTP request context 的 ctx，`ReadMessage` 因錯誤返回時明確呼叫該 cancel，讓正在進行的 `handlePrompt`/`Complete` 呼叫能真正被中斷。因為兩條連線路徑現在共用同一段程式碼，修好一次即可同時涵蓋兩者，不需要分別修。
- **現況**：確認仍未修復（2026-08-16 對照現行程式碼複核；2026-09-05 本次 panic/資源專項複核期間再次對照 `session.go:107-146` 確認同一段程式碼未變更，問題依舊存在）。

### ⚪ `/healthz` 無條件回 200，不反映資料庫健康狀態
- **位置**：`backend/cmd/server/main.go:249-252`
- **問題**：`healthz` handler 無條件 `w.WriteHeader(http.StatusOK)`，完全不檢查資料庫連線或任何下游依賴。資料庫斷線、auth/quota 全部故障的情境下，這個健康檢查端點依然回報「健康」，導致 load balancer/Cloud Run 繼續把流量導向一個實際上壞掉的執行個體。
- **修法**：改成帶短逾時（例如 2 秒）的 `db.PingContext`，DB 不可達時回非 200；可考慮另加 `/readyz` 區分 liveness 與 readiness。
- **現況**：確認仍未修復（2026-08-16 對照現行程式碼複核；2026-09-05 對照 `cmd/server/main.go:304-307` 再次確認 handler 仍是無條件 `WriteHeader(http.StatusOK)`，未變更）。此項目與 `docs/audit-functional.md` 有重疊記錄（該檔案在「低優先」清單裡也提過一句）——`audit-functional.md` 的版本予以移除，改由本檔案作為單一真相來源追蹤，避免兩處各自更新現況導致對不上。

---

## 進行中的發現（依嚴重度排序）

（目前與上方「初始建檔」相同，尚無跨掃描的歷史差異。下次複核起，這裡才會出現「現況（YYYY-MM-DD 複核）」的持續追蹤記錄。）

---

## 已複核為安全/已解決的項目

（尚無）
