# SessionStore 架構檢討：可維護性、多使用者隔離、穩定性、擴充性

> 針對 `e7c18f4`（"Add database-backed SessionStore for want orchestrator sessions"）新增的 `internal/sessionstore` 套件所做的架構檢討。晚點處理，本文件先記錄討論結論。

## 背景：這次改動做了什麼

`internal/sessionstore.Store` 實作 want 的 `types.SessionStore` 介面，把每個 WebSocket session 的對話歷史寫進 Postgres（`agent_experiences` 表），讓對話紀錄能撐過後端 process 重啟——之前歷史只存在 orchestrator 記憶體裡，重啟就消失。

**注入路徑**：`main.go` 建立 `sessionstore.New(database)` → 傳給 `inference.NewWant(settings, apps, sessionStore)` → 存進 `WantService.sessionStore` → 每個 session 第一次呼叫 `Complete` 時，`buildOrchestrator` 呼叫 `orch.SetSessionStore(s.sessionStore)`，把同一個共用的 store 實例注入該 session 專屬的 `orchestrator.Orchestrator`。nil-safe：不注入時 want 用預設的純記憶體行為。

**已確認的儲存模式（查證過 want 原始碼）**：
- 疊加式寫入，不是快照式。每則訊息（使用者 prompt、assistant 回覆、每次工具呼叫/結果）各自觸發一次獨立的 `Append`，對應資料庫一行。
- `Append` 是純 `INSERT ... ON CONFLICT (session_id, exp_id) DO NOTHING`，沒有 `UPDATE`。去重靠 `msgID`（`時間戳-role-callID` 組合），配合唯一索引 `(session_id, exp_id)`。
- `Load` 是 `SELECT ... WHERE session_id = $1 ORDER BY id`，全量掃描重建整段對話。
- want 自己呼叫 `Append` 時主動吞掉錯誤（`_ = store.Append(...)`），註解明講「寫入失敗是實作者的責任」——歷史寫入是 best-effort，不會讓推論輪次失敗。

## 可維護性

**1. `session_id` 沒有任何外部參照，資料無法追溯歸屬**

`agent_experiences` 只有 `session_id`（`ws.Session` 自產的隨機 128-bit hex，跟 app/user 完全脫鉤），沒有 FK、沒有 owner 資訊。`schema.sql` 註解明講這是刻意設計（"a session can outlive the app/user it was opened under"），但代價是現在完全無法從這張表反查「這筆紀錄屬於哪個 app/使用者」——未來要做資料盤點、合規刪除（例如刪帳號時一併清對話紀錄），現在的 schema 完全無路可查。

→ **已定調要處理**：session 對應到 app，讀取只能從對應的 app 讀（見下方「本次定調的解法」）。

**2. 沒有清理機制，且是逐筆疊加，成長速度比快照式快得多**

`DeleteSession` 存在（實作了可選的 `types.SessionStoreDeleter`）但**沒有任何呼叫端使用**——`ws.Session` 斷線只呼叫 `CloseSession`（釋放記憶體中的 orchestrator），不呼叫 `DeleteSession`。因為確認是逐筆疊加（不是每次存一份快照），`agent_experiences` 的行數會隨對話輪次、工具呼叫次數線性成長，是無界成長的表，沒有 TTL、沒有排程清理。

→ 建議：至少先在 `sessionstore.go`/`schema.sql` 補上明確的文件警示，把這個已知缺口寫下來。

## 多使用者隔離

**3. `Load` 沒有任何存取控制，是唯一的洩漏風險點**

`sessionstore.Store.Load(sessionID string)` 只吃一個字串，直接查、直接回傳，不驗證呼叫者身份。目前安全純粹是因為 `session_id` 只在 `WantService` 內部流轉、使用者端碰不到這個值——這是隱性假設，不是程式碼強制保證。

這點直接呼應既有記憶裡已記錄的 bug：empty `SessionID` 可能導致跨使用者對話洩漏。這次新增 `SessionStore` 讓這個 bug 的影響範圍從「記憶體內、單一 process 存活期間」升級成「**Postgres 裡永久存在、跨重啟持續**」——根因沒變，但傷害半徑放大了。

→ **已定調要處理**：跟第 1 點同一個解法，session 綁定 app_id 後，`Load` 的查詢從 `WHERE session_id = $1` 擴充成 `WHERE session_id = $1 AND app_id = $2`。因為是逐筆儲存（不是快照），不需要處理歷史資料裡混雜不同 app 的拆分問題，只要新寫入開始帶 app_id，改動範圍乾淨可控。

## 穩定性

**4. Append 失敗是完全靜默的，沒有可觀測性**

want 端主動吞掉 `Append` 的錯誤（best-effort 契約，避免 Postgres 抖動拖垮推論輪次，這部分設計是合理的）。但代價是：如果 `sessionstore.Store.Append` 真的因為連線問題寫入失敗，**目前完全沒有任何 log 或告警**，歷史紀錄會悄悄漏掉幾筆，只有等有人事後發現對話紀錄「怪怪地不完整」才會被注意到。

→ 建議：`Store.Append` 內部至少要記一筆 log（不需要往上拋錯，維持 want 的 best-effort 契約）。

**5. 同步寫入仍是延遲風險**

`Append` 是同步 `s.db.Exec`，每則使用者訊息、每個工具結果都各自觸發一次同步寫入，所有 WS session 共用同一個 `*sql.DB` 連線池。即使寫入失敗被吞掉不影響對話成敗，等待寫入完成的時間仍然存在——連線池打滿或 Postgres 變慢時，會直接拖慢所有 session 的即時性。

**6. 沒有寫入放大防護**

`Append` 不檢查任何配額，跟既有的 `quota` 系統完全脫鉤。理論上一個異常客戶端可以無限制觸發寫入，沒有 per-session 筆數上限或 rate limit。

## 擴充性：對 want 上游專案的提案

**7. `Flush` 目前無任何呼叫點會觸發**

因為每則訊息都各自同步呼叫 `Append`，`Flush` 目前沒有存在必要——但這代表 `types.SessionStore` 介面預留了「未來允許緩衝寫入」的彈性，onagent 選擇不用完全合理。建議 want 在介面文件裡明講這件事，避免新接入者誤以為 `Flush` 有作用、白費力氣去實作一個不會被呼叫的版本。

**8. 建議補上 `context.Context` 參數**

`Append(sessionID string, exp types.Experience, id string) error` 沒有 context 參數，實作方無法接住上游的 cancellation/timeout，只能自行在實作內部硬編超時策略。既然 want 端已經主動吞掉錯誤，時間控制更需要靠 context 讓實作方能正確處理逾時。

**9. 建議補上「列出/清理過期 session」的可選介面**

因為確認是逐筆疊加、無界成長（見第 2 點），這個需求比原本設想更急迫。`types.SessionStoreDeleter`（可選的 `DeleteSession`）已存在，但沒有配套的「怎麼知道該刪哪些 session」機制。建議 want 提供一個可選的 `ListSessions()`/`ListStaleSessions(before time.Time)` 介面，讓每個接入 want 的專案都能共用一套清理排程邏輯，而不是各自從零設計判斷標準。

## 本次定調的解法（優先處理）

> session 對應到 app，讀取時只能從對應的 app 讀。

同時解決可維護性第 1 點跟多使用者隔離第 3 點。改動範圍：

- `schema.sql`：`agent_experiences` 新增 `app_id` 欄位（不做外鍵約束，理由同既有的 `session_id` 設計——session 可能比 app 活得久）
- `sessionstore.Store`：`Append`/`Load` 簽名加上 `appID` 參數
- 呼叫鏈：`WantService.getOrCreate(key, appID)` 已經拿得到 `appID`，需要一路傳到 `buildOrchestrator` → `orch.SetSessionStore` 這條路徑上，讓 `sessionstore.Store` 在建構時或呼叫時能拿到對應的 `appID`

因為儲存模式是逐筆疊加（不是整份快照），不需要處理歷史資料拆分的複雜情況，只要新寫入開始帶 `app_id`、`Load` 加上過濾條件即可，是這次討論裡改動最乾淨、風險最低、也是優先度最高的一項。

## 優先順序總結

1. **（已定調，優先處理）** session 綁定 app_id，`Load` 限定只讀對應 app 的資料
2. **（低成本，建議一起做）** `Store.Append` 補上失敗 log；`schema.sql`/`sessionstore.go` 補上「無清理機制」的文件警示
3. **（留給之後，或回饋給 want 上游）** 連線池/同步寫入延遲風險、寫入配額防護、`context.Context` 參數、`ListSessions` 介面
