# SessionStore 架構檢討：尚待處理的部分

> 針對 `e7c18f4`（"Add database-backed SessionStore for want orchestrator sessions"）新增的 `internal/sessionstore` 套件所做的架構檢討。已完成的部分（session 綁定 app_id 隔離、want v0.4.0 升級後 Append 失敗行為改變）已從本文件移除，以下只保留尚未處理的項目。

## 可維護性

**沒有清理機制，且是逐筆疊加，成長速度比快照式快得多**

`DeleteSession` 存在（實作了可選的 `types.SessionStoreDeleter`）但**沒有任何呼叫端使用**——`ws.Session` 斷線只呼叫 `CloseSession`（釋放記憶體中的 orchestrator），不呼叫 `DeleteSession`。因為是逐筆疊加（不是每次存一份快照），`agent_experiences` 的行數會隨對話輪次、工具呼叫次數線性成長，是無界成長的表，沒有 TTL、沒有排程清理。

→ 建議：至少先在 `sessionstore.go`/`schema.sql` 補上明確的文件警示，把這個已知缺口寫下來。

## 穩定性

**一個上游自己也還沒解決的隱患：懸空 tool_use 的恢復問題**

因為寫入是逐則即時寫（assistant 訊息一回應就寫，工具結果各自執行完才各自寫），如果 Append 因失敗而中斷，可能會在持久化紀錄裡留下「LLM 說要呼叫工具 X」但沒有「工具 X 執行結果」的斷裂狀態。這種斷裂歷史被重新載入去恢復 session 時，很可能被 LLM API（Anthropic/OpenAI 都要求 tool_use 後面必須緊跟 tool_result）以 400 錯誤拒絕，甚至可能卡在同一個斷點永遠恢復不了。want 官方文件（`doc/session-store-persistence-strictness-2026-07.md`）明講這個問題「目前只有提出、沒有答案」。`sessionstore.Store.load` 目前沒有任何偵測或修補機制。

**同步寫入仍是延遲風險**

`Append` 是同步 `s.db.Exec`，每則使用者訊息、每個工具結果都各自觸發一次同步寫入，所有 WS session 共用同一個 `*sql.DB` 連線池。等待寫入完成的時間仍然存在——連線池打滿或 Postgres 變慢時，會直接拖慢所有 session 的即時性。

**沒有寫入放大防護**

`Append` 不檢查任何配額，跟既有的 `quota` 系統完全脫鉤。理論上一個異常客戶端可以無限制觸發寫入，沒有 per-session 筆數上限或 rate limit。

## 擴充性：對 want 上游專案的提案

**`Flush` 目前無任何呼叫點會觸發**

因為每則訊息都各自同步呼叫 `Append`，`Flush` 目前沒有存在必要——但這代表 `types.SessionStore` 介面預留了「未來允許緩衝寫入」的彈性，onagent 選擇不用完全合理。建議 want 在介面文件裡明講這件事，避免新接入者誤以為 `Flush` 有作用、白費力氣去實作一個不會被呼叫的版本。

**建議補上 `context.Context` 參數**

`Append(sessionID string, exp types.Experience, id string) error` 沒有 context 參數，實作方無法接住上游的 cancellation/timeout，只能自行在實作內部硬編超時策略。

**建議補上「列出/清理過期 session」的可選介面**

因為是逐筆疊加、無界成長（見上方「沒有清理機制」），這個需求比原本設想更急迫。`types.SessionStoreDeleter`（可選的 `DeleteSession`）已存在，但沒有配套的「怎麼知道該刪哪些 session」機制。建議 want 提供一個可選的 `ListSessions()`/`ListStaleSessions(before time.Time)` 介面，讓每個接入 want 的專案都能共用一套清理排程邏輯，而不是各自從零設計判斷標準。

## 優先順序總結

1. **（低成本，建議優先做）** `schema.sql`/`sessionstore.go` 補上「無清理機制」的文件警示
2. **（留給之後，或回饋給 want 上游）** 連線池/同步寫入延遲風險、寫入配額防護、`context.Context` 參數、`ListSessions` 介面、懸空 tool_use 的恢復問題（want 上游也還沒解）
