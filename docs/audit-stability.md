# onagent 並發/穩定性稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。安全性發現另外記在 `docs/audit-security.md`；純命名/死碼/架構債等靜態程式碼品質問題記在 `docs/audit-functional.md`。本檔案只收 race condition、deadlock、goroutine 洩漏、panic/crash 風險、資源未清理等**執行期**、無安全後果的並發或穩定性問題。

---

## 最新掃描結果：2026-09-11（全專案 6-agent 並行稽核的並發/穩定性部分）

> 方法：6 個並行 agent 分面向全專案掃描，本節取其中並發/穩定性面向的結果；每個 agent 要求「必須追出實際的 goroutine 邊界與交錯序列」才能提報，主 session 再對高嚴重度項目親自讀碼複核。已排除既有記錄中的三項（`run()` 未取消 in-flight `Complete()`、`console` nil-`*App`、`/healthz`）。

### 🔴 `CloseSession` 與 `Complete` 競態導致 send on closed channel panic（2026-09-11 新發現）

- **位置**：`backend/internal/inference/want.go:216-229`（`CloseSession`）與 `:314`（`orch.Submit`），對應 want v0.4.0 的 `orchestrator.Submit`（`orchestrator.go:336-375`）與 `Stop`（`:315-328`）
- **問題**：want 的 `Submit` 是典型的 check-then-act——先在鎖內讀 `stopped`，**放開鎖之後**才 `orch.activationQueue <- cmd`（`orchestrator.go:371`）。而 `Stop()` 在鎖內設 `stopped=true`，卻在**鎖外** `close(orch.activationQueue)`。兩者之間的視窗不小：正式環境 `sessionStore != nil`（`want.go:172-174` 無條件接上），`Submit` 會在該視窗內做一次同步的 Postgres INSERT（`sessionstore.append`）。
- **觸發序列**：(1) 瀏覽器送 prompt，`ws.Session.handle` 以 `go s.handlePrompt(...)`（`session.go:216`）分派；(2) `handlePrompt` → `Complete` → `getOrCreate` → `orch.Submit`，此時讀到 `stopped == false`，放開鎖並開始 INSERT；(3) 使用者關掉分頁／斷線，read loop 的 `ReadMessage` 出錯、`run` 返回，觸發 `defer s.infer.CloseSession(s.id)`（`session.go:129`）；(4) `CloseSession` 刪除 map 條目後呼叫 `orch.Stop()` → `close(activationQueue)`；(5) 步驟 2 的 INSERT 返回，`Submit` 送進已關閉的 channel → **panic: send on closed channel**。
- **現況嚴重度**：`handlePrompt` 有 `recover()`（`session.go:269-274`），want 的 EventBus handler 也各自有 recover，所以目前**不會**讓整個 process 崩潰。但這是依賴「剛好每條路徑都有 recover」而非設計上的正確性：任何未來在 `handlePrompt` 之外呼叫 `Complete` 的新 caller、或 want 上游調整 recover 位置，都會讓它升級為全 process 崩潰、拖垮所有連線中的 session。
- **與既有項目的關係**：這是既有「`run()` 未取消 in-flight `Complete()`」的清理面另一半；該項建議的修法（在 read-loop 結束時取消 session-scoped ctx）**無法**修掉這個問題，因為 `ctx.Done()` 只在 `Submit` **返回之後**才被 select（`want.go:318-325`），視窗在 `Submit` 內部。
- **修法**：讓 `CloseSession` 不與 `Complete` 競態——以 per-session 的 `sync.WaitGroup` 或 refcount 追蹤 in-flight `Complete`，`CloseSession` 先標記關閉、等待排空（以 `completeTimeout` 為上限）再 `Stop()`。或推動上游 want 讓 `Submit` 在持鎖狀態下完成送出、`Stop` 在同一把鎖內 close。

### 🔴 Playground 的穩定 sessionID 讓兩個分頁共用同一組 orchestrator 與 asker（2026-09-11 新發現）

- **位置**：`backend/internal/console/playground.go:208`（`sessionID = fmt.Sprintf("PG-%d-%s", user.ID, appID)`）、`backend/internal/ws/session.go:118`（`RegisterAsker(s.id, s)`）、`:124`（`defer UnregisterAsker(s.id)`）、`:129`（`defer CloseSession(s.id)`）、`backend/internal/inference/interaction.go:42-55`
- **問題**：Playground 刻意使用**確定性、每 (user, app) 固定**的 sessionID 好讓重新整理能延續對話，SDK 路徑則回傳 `""` 換得隨機 id 因而不受影響。但這個 id 同時被當成三個共享註冊表的唯一鍵使用，而 `RegisterAsker` 是無條件覆寫、`UnregisterAsker` 是無條件刪除（已複核 `interaction.go:42-55` 確認）。同一位開發者開**兩個分頁**測同一個 app（並排比較 prompt，完全正常的操作）必然碰撞。
- **觸發序列（asker 劫持）**：分頁 A 連線註冊 `askers["PG-7-myapp"] = A`；分頁 B 連線**靜默覆蓋**成 B；分頁 A 送 prompt，LLM 呼叫 query tool → `lookupAsker("PG-7-myapp")` 回傳 **B** → `tool_query` 送到**分頁 B** 的 WebSocket。B 的畫面跳出一個它使用者從未發起的問題，A 的推論則卡住直到有人回答或 20 秒逾時。
- **觸發序列（跨分頁摧毀）**：兩分頁都連著、A 的 prompt 推論進行中；使用者關掉 **B** → `run` 返回 → `UnregisterAsker` 刪掉（唯一那筆）asker，`CloseSession` → `orch.Stop()` → `Interrupt()` 取消 **A** 正在跑的 `RunAgent`。A 的連線還開著，但它的 asker 沒了、當前這輪推論被殺掉。若 A 此刻正好在 `getOrCreate` 與 `Submit` 之間，就是上一條的 panic——而且這次完全不需要網路異常，只要兩個分頁加一次關閉。
- **佐證**：`tool-builder` 與 `?fresh=1` 已各自用 `randomSuffix()` 迴避（`playground.go:209-211`），代表問題形狀是被理解的，只是範圍被界定在「必須全新」的情境，而非「必須不碰撞」的情境。
- **修法**：拆開這個 id 的三種用途——want session key 維持穩定（這才是對話能延續的原因），但每條**連線**另配唯一 id 用於 `RegisterAsker`/`UnregisterAsker` 與連線生命週期記帳（`Session` 需要 `connID` 與 `wantSessionID` 兩個欄位，`CloseSession` 改為對 want session key 做 refcount，最後一個分頁離開才釋放）。若短期內不做這麼大的手術，較便宜的緩解是讓 `RegisterAsker` 拒絕重複鍵，或 `playgroundResolver` 對同一 (user, app) 的第二條並行連線回 409。

### 🟠 `AskInteraction` 無法感知連線已關閉，逾時前持續佔用全域推論佇列（2026-09-11 新發現）

- **位置**：`backend/internal/ws/session.go:392-429`
- **問題**：`AskInteraction` 的簽名**不收 `context.Context`**，其 `select`（`:414-428`）只等兩件事：結果 channel、與 `time.After(interactionTimeout)`（20 秒）。**沒有任何 case 對應連線關閉**。
- **觸發序列**：query tool 的 `tool_query` 已送出、`pendingCalls` 已登記 → 客戶端斷線 → `run` 的 read loop 返回，`UnregisterAsker`/`CloseSession`/`s.conn.Close()` 都跑完 → 但 `AskInteraction` 仍停在 `select` 上。永遠不會有人送來 `tool_result`（`handleToolResult` 只由已死的 read loop 呼叫），它會**卡滿 20 秒**。`s.conn.Close()` 幫不上忙，因為它等的是 Go channel 不是 socket。
- **影響**：want 的 provider 佇列是 **process-wide、concurrency=1**（`want.go` 套件註解 26-41 行），所以這不是單一 session 的成本——整個後端所有使用者的推論都排在這個已死的 20 秒等待後面。使用者在 query 進行中反覆重整 Playground 就會反覆觸發。與既有「`run()` 未取消 in-flight `Complete()`」疊加後，單次斷線可佔用 `interactionTimeout` + `completeTimeout` 剩餘時間。
- **修法**：給 `Session` 一個 `closed chan struct{}`，由 `run` 的 defer 關閉，並在 `AskInteraction` 的 select 加上 `case <-s.closed:` 回傳「連線已關閉」錯誤（同時比照逾時分支 `:424-426` 刪除 `pendingCalls` 條目）。這與既有項目所需的 session-scoped 取消 channel 是同一個改動，一次可收兩項。

### 🟠 `Complete` 的事件訂閱存活超過該次呼叫，過期的 run 會把用量記到錯誤的 request 上（2026-09-11 新發現）

- **位置**：`backend/internal/inference/want.go:248-312`（`orch.Subscribe` + `defer unsub()`），對應 want 的 `EventBus.Publish`（`internal/events/event_bus.go:71-88`）
- **問題**：`EventBus.Publish` 把**每個 handler 丟到全新 goroutine** 後立即返回，不等 handler 完成。`unsub()` 只是把 callback 從 subscriber slice 移除，任何**已經**取得 handler slice 快照的 `Publish` 仍會照常執行該 callback。
- **觸發序列**：(1) prompt 1 的 `Complete` 由 `completeTimeout` 分支（`want.go:323`）返回——注意該分支**不像** `ctx.Done()` 分支會呼叫 `orch.Interrupt()`，所以 want 的 `RunAgent` 仍在跑、仍在發事件；(2) 該 run 發出帶 `Usage` 的 `StatusViewModel`；(3) callback 以 prompt 1 捕獲的 `req` 執行 `s.quota.Record(context.Background(), req.AppID, req.UserID, req.RequestID, vm.Usage)`（`want.go:289`）——用的是 `context.Background()`，這個寫入刻意不可取消，**一定會落地**。
- **影響**：已經回傳錯誤給使用者的 `Complete` 仍持續寫入用量列。`quota.Record` 明文記載**不具 idempotency**（無 `ON CONFLICT`，`quota.go:196-205`）、`usageSince` 對每一列做 SUM（`quota.go:388-398`），所以這些是對真實 `userID` 的真實超額計費——使用者為一次回傳逾時錯誤的對話被扣了 token。
- **修法**：以 `closed atomic.Bool` 在 `unsub()` 前設定、callback 開頭檢查，讓遲到事件被丟棄而非記錄。另外 `completeTimeout` 分支（`:323`）應比照 `ctx.Done()` 分支先呼叫 `orch.Interrupt()`——放著一個已經放棄的 run 繼續跑，正是這個視窗從毫秒級變成無界的原因。

### 🟡 `http.ListenAndServe` 未設任何 server 逾時，slow-loris 可無限佔用 goroutine（2026-09-11 新發現）

- **位置**：`backend/cmd/server/main.go:340`
- **問題**：`http.ListenAndServe(addr, ...)` 使用零值 `http.Server`——`ReadHeaderTimeout`、`ReadTimeout`、`WriteTimeout`、`IdleTimeout` **全為 0（無限制）**。客戶端開 TCP 連線後逐字滴入 header 即可永久佔住一個 goroutine 與一個 fd，且發生在任何 handler 執行之前，無需認證。WebSocket 端點雖在升級後自設 read deadline（`session.go:131-135`），但**升級前**的 header 讀取同樣無界。
- **影響**：以極低成本造成 goroutine 與 fd 無界成長，最終 fd 耗盡或 OOM；在 Cloud Run 上會表現為「`/healthz` 仍回 200 但實例已無回應」，與既有的 `/healthz` 項目疊加。
- **修法**：改用具名 `&http.Server{Addr: addr, Handler: ..., ReadHeaderTimeout: 10*time.Second, IdleTimeout: 120*time.Second}` 再 `ListenAndServe()`。**不要**設整體 `ReadTimeout`/`WriteTimeout`——那會切斷長連線的 WebSocket；`ReadHeaderTimeout` 才是能關掉 slow-loris 又不影響升級路徑的那一個。

### 🟡 `backendDispatchTool.Call` 使用 `context.Background()`，外呼無法被取消（2026-09-11 新發現）

- **位置**：`backend/internal/inference/backend_dispatch.go:47`（`dispatchBackend(context.Background(), ...)`）
- **問題**：`types.ToolContext` 帶著 want 的 per-run 可取消 ctx（`orch.Interrupt()` 取消的就是它），此處卻整個丟棄。`dispatchBackend` 雖自帶 `context.WithTimeout`（`:99`），但上限是 `config.TimeoutMS`——**由開發者自行設定且無任何上限鉗制**（`:96-98`）。
- **影響**：一個設成 `timeoutMS: 600000` 的工具可釘住一條 want dispatch goroutine 與 process-wide concurrency=1 的 provider 佇列長達十分鐘，且對 `Interrupt()`、呼叫端斷線、`completeTimeout` 全部免疫。
- **修法**：把 run 的 context 串下來（want 的 `ToolContext` 若未暴露則需向上游要求），並在 `toolschema` 驗證階段對 `TimeoutMS` 設平台上限。

### ⚪ `Registry.Get` 回傳指向快取的 `*App`，`Reload` 換 map 後既有持有者拿到的是快照

- **位置**：`backend/internal/toolschema/registry.go:79-84`、`:102-111`
- **現況**：`Get` 在 `RLock` 下回傳指標本身而非複本；`Reload` 在 `Lock` 下整個換掉 `r.apps`，且 `loadAllApps` 會建出全新的 `*App`，所以**沒有**對活躍 `*App` 的寫入競態——今天是安全的，因此列為 LOW。
- **脆弱之處**：每個發出去的 `*App`（包含 `Session.app` 持有整條連線生命週期、以及 `appToolProvider.Declarations` 每次呼叫重新 `Get` 的那個）都是靜默停止追蹤後續編輯的快照。`Session.app` 在 `handlePrompt:283` 被讀取並於 `:318` 傳入 `codegen.ToLLMTools(app)`，所以長連線的 `ToLLMTools` 用的是 `hello` 當下的工具集，而 `appToolProvider` 用的是當前的——兩者可在**同一次 prompt 內**不一致。無記憶體安全後果，且真正決定工具派送的是後者，但若日後有人對 `*App` 加入原地修改就會變成真的 bug，值得補註解或改為防禦性複本。

### 本次複核確認**不是** bug 的項目

- **`pendingCalls` send-on-closed / 重複送出**（`session.go:343-364`、`:392-429`）：安全。channel 為 buffered cap-1，`handleToolResult` 與逾時分支都在 `s.mu` 下先從 map 刪除才動作，永遠只有一方會送；`close(ch)`（`:359`）只有勝出的那一方會到達。
- **`WantService.mu` 範圍**：正確——從未跨越 `Submit`/`Stop` 或任何阻塞呼叫。`CloseSession` 在 `orch.Stop()` 前已放鎖（`want.go:224-228`）。`WantService.mu`、`Session.mu`、`Session.writeMu`、`askersMu` 四者從未巢狀，無鎖序問題。
- **Ping loop goroutine**（`session.go:163-193`）：無洩漏，`done` 路徑有 `ticker.Stop()`，寫入錯誤亦會結束，`stopPing()` 在 `run` 中 defer。
- **`quota` 套件**：全部查詢走 `WithContext(ctx)` 與 GORM 連線池，無手動 `*sql.Rows` 需要關閉。`Check` 與 `Record` 之間的 check-then-act 是刻意的無計數器帳本設計取捨（並發 prompt 可小幅超用），非缺陷。
- **型別斷言**：所有非測試位置皆為 comma-ok 或 `switch v := x.(type)`；唯一裸斷言 `listener.Addr().(*net.TCPAddr)`（`cmd/onagent/main.go:326`）由前一行 `net.Listen("tcp", ...)` 保證。

---

## 舊掃描結果：2026-09-05（panic/crash 風險與資源管理專項複核）

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
