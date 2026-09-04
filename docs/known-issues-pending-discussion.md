# 已知問題與待討論項目（持續追蹤）

> 這份文件持續追蹤各種尚待討論、尚未拍板方向的已知問題與架構風險，不限定單一主題。不帶日期，每次新發現/修正都直接更新對應項目，不新增日期章節。

## 用量記錄機制

### 背景

`usage_events` 表用 `(app_id, event_id)` 唯一索引 + `ON CONFLICT DO NOTHING` 做 idempotency 去重——這個機制本身是刻意設計的（見 `backend/internal/ws/session.go` 的註解）：目的是讓「客戶端重試同一個 request」不會被重複扣費。`event_id = sessionID + ":" + requestID`，其中 `requestID` 完全由呼叫端（前端/SDK）決定，後端不做任何驗證。

這代表：**任何情境下，只要呼叫端傳來的 `requestID` 跟同一個 session 之前某次的 `requestID` 重複，這次 prompt 就會被靜默吃掉，不計入用量**——不論這個重複是「刻意重試」（正確行為）還是「意外撞號」（bug）。

### 已修正的問題

#### Playground 頁面重新整理後 requestId 歸零，導致用量遺漏（2026-09-03 發現並修正）

- **現象**：使用者在 console 的 Playground 送出 prompt，收到正常的 assistant 回應，但 `usage_events` 沒有新增記錄，admin 後台看到的用量沒有增加。非每次都發生，只在特定情況下出現，難以穩定重現。
- **根本原因**：`apps/console/src/Playground.tsx` 的 `nextId`（`useRef(0)`）同時被用來當 React 訊息顯示 id 跟 WebSocket 的 `requestId`。`useRef` 的值會在元件重新掛載（也就是使用者重新整理頁面）時重置為 `0`。而 `sessionID`（`PG-<userID>-<appID>`）對同一個使用者、同一個 app 是固定不變的字串。所以：使用者重新整理 Playground 頁面後,新一輪對話的第一句話（`requestId="0"`）跟他自己過去某次頁面載入時第一句話的 `event_id` 完全相同，被 `ON CONFLICT DO NOTHING` 靜默吃掉——沒有任何錯誤或警告，前端仍收到正常的推論回應。
- **診斷方式**：在正式環境重現失敗後，因為 `Quota.Record()` 的錯誤原本被完全吞掉且無 log，只能透過還原正式資料庫快照到獨立的 staging Cloud Run 環境、加上完整的斷點式 log，才追出 `Record()` 回傳「無錯誤」但實際插入 0 列的真相。
- **修法**：`requestId` 改用 `crypto.randomUUID()`，不再依賴任何會重置的計數器。
- **驗證**：修正後在 staging 重新整理頁面多次測試，未再重現。

### 尚未處理的風險（架構層級）

#### 呼叫端自行決定 requestId 的唯一性，後端不驗證

- **現況**：`Quota.Record` 的 idempotency key 完全信任呼叫端提供的 `requestID`，後端沒有任何格式或唯一性檢查。上面那個 Playground bug 只是這個架構下**目前已知**會踩到的一種情境；同樣的模式理論上可能發生在：
  - 其他前端/SDK 若也用「頁面生命週期內遞增、頁面重整會歸零」的計數器產生 requestId
  - 任何呼叫端的 bug 導致連續兩次不同的 prompt 意外傳送了相同的 requestId
- **影響範圍**：`internal/console/playground.go`（Playground）、`internal/ws/session.go`（真實 SDK 使用者的 WebSocket 連線）都是同一套機制，共用同樣的風險。
- **尚未修正**：目前只修了 Playground 這個已知會撞號的具體來源，沒有從架構上防止「重複 requestId 被誤判為合法重試」這件事本身。
- **待評估的方向**（尚未拍板，記錄供未來討論）：
  - 後端是否該對 requestID 的格式做基本驗證（例如要求 UUID 格式）？
  - 是否該記錄「這是第幾次看到這個 event_id」，讓 `ON CONFLICT DO NOTHING` 命中時至少留下一筆可稽核的紀錄，而不是完全無痕跡？

### 相關的既有可觀測性缺口

- `Quota.Check`/`Quota.Record` 的錯誤原本完全被吞掉、沒有任何 log（`internal/console/playground.go`、`internal/ws/session.go` 皆是 fail-open 且註解明確說明是刻意設計）。這個設計本身（用量記錄失敗不阻斷使用者體驗）是合理的，但**完全沒有 log** 讓這次的問題花了大量時間才追出根因。是否要在 fail-open 的前提下，至少加上最基本的錯誤 log，供未來類似情況快速定位——尚待評估與拍板。

## Tool 定義簡化設定（構想，尚未拍板）

目前建立 tool 定義只能用兩種方式：console 網頁的 tool 編輯器手動輸入，或撰寫本機 `tools.yaml` 用 `onagent save-tools` 推送——兩者都要求使用者自己寫出完整的 JSON Schema（`name`/`description`/`parameters`/`properties` 等），對不熟悉 JSON Schema 的使用者有門檻。

構想方向：新增一種對話式引導建立 tool 的方式，作為現有兩種方式（console 手動編輯、`tools.yaml` + CLI）之外的第三種選項，不取代、也不影響 `tools.yaml` + `onagent save-tools` 這條既有路徑——依序詢問使用者這個工具的用途、類型、可能的參數有哪些、參數類型，由介面（可能搭配 LLM）幫使用者組出完整的 tool 定義，不需要使用者自己寫 JSON Schema。

尚未拍板的細節：
- 是獨立的新 UI 流程，還是整合進現有 console 的 tool 編輯器？
- 引導問題本身是固定表單，還是用 LLM 動態追問？
- 組出來的 tool 定義是直接存檔，還是先讓使用者確認/編輯過再存？

## Playground 工具呼叫視覺化（構想，尚未拍板）

目前 console 的 Playground（`apps/console/src/Playground.tsx`）收到 `tool_call` 事件時，只用純文字顯示：`${toolName}(${JSON.stringify(args)})`（見該檔案 `appendMessage('tool_call', ...)`）。對於工具數量多、參數複雜的 app，純文字呈現不容易一眼看出發生了什麼。

構想方向：把工具呼叫改成更直觀的視覺呈現，而不是一行 JSON 字串——例如用卡片式呈現工具名稱、參數列表，或針對常見的參數型態（例如陣列、巢狀物件）做結構化展示。

尚未拍板的細節：
- 具體的視覺化形式（卡片、表格、時間軸等）
- 是否需要因應不同工具的參數 schema 做客製化呈現，還是統一用一種通用格式
