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

目前建立 tool 定義只能用兩種方式：console 網頁的 tool 編輯器手動輸入，或撰寫本機單一 tool 的 YAML 檔用 `onagent tool create` 推送——兩者都要求使用者自己寫出完整的 JSON Schema（`name`/`description`/`parameters`/`properties` 等），對不熟悉 JSON Schema 的使用者有門檻。

（本節寫成時 CLI 指令仍叫 `save-tools`，已隨 CLI 指令樹重構改名為 `tool create`，且語意從整批覆蓋一個 app 的所有 tools 改成單一 tool 的 upsert——不影響這裡的構想方向本身。）

構想方向：新增一種對話式引導建立 tool 的方式，作為現有兩種方式（console 手動編輯、YAML + CLI）之外的第三種選項，不取代、也不影響 YAML + `onagent tool create` 這條既有路徑——依序詢問使用者這個工具的用途、類型、可能的參數有哪些、參數類型，由介面（可能搭配 LLM）幫使用者組出完整的 tool 定義，不需要使用者自己寫 JSON Schema。

（這個構想已實作為 AI Tool Builder——console 的「Generate with AI」流程，見 `apps/console/src/aiToolGenerator.ts`/`AiToolGeneratorSheet.tsx`，後端定義於 `backend/internal/console/tool-builder-tools.yaml`。設計文件已刪除，per-user provisioning、從 app 清單隱藏等尚未完成的部分見這兩個檔案的註解。）

尚未拍板的細節：
- 是獨立的新 UI 流程，還是整合進現有 console 的 tool 編輯器？
- 引導問題本身是固定表單，還是用 LLM 動態追問？
- 組出來的 tool 定義是直接存檔，還是先讓使用者確認/編輯過再存？

## CLI `tool list`/`tool create` 輸出入格式不對稱（已確認、尚未修正）

`backend/cmd/onagent/main.go` 的 `runGetTools`（`tool list`）與 `runSaveTools`（`tool create`）自己的註解互相矛盾：

- `tool list`（`runGetTools`）：`client.getApp(appID)` 拿到整個 `toolschema.App`（`appId`/`tools:[...]`/`thought`），原封不動 `yaml.Marshal` 印出。其註解宣稱「Marshaled straight back out as toolschema.App's own yaml tags ... so this output can be piped into a file and round-tripped back in」。
- `tool create`（`runSaveTools`）：`yaml.Unmarshal(data, &tool)` 讀進的是**單一 `toolschema.Tool`**（沒有外層 `tools:` 包裹，也沒有 `appId`/`thought`）。其註解自己承認「tool.yaml is a single tool's own fields ... not an App-shaped file with appId/tools/thought」。

`apiClient.getApp`（`client.go` 對應方法）的 doc comment 也重複同樣的錯誤宣稱：「the same document runSaveTools sends, read back」。

**實測結論**：只要 app 有 ≥1 個工具，`tool list <appId> > out.yaml` 的輸出直接餵給 `tool create <appId> out.yaml` 必定失敗——`yaml.Unmarshal` 把整個 `App` 塞進 `Tool` 型別，`tool.Name`/`Description`/`Parameters` 全部收不到值變成零值，`Validate()` 一定因為空 `name`/空 `parameters.type` 而報錯。沒有任何測試涵蓋這條路徑（`apiclient_test.go` 只測 HTTP client 層，不測 CLI 指令的 YAML 解析/組裝邏輯），這個矛盾因此從未被抓到。

**已確認的修法方向**：把 `tool list` 的輸出格式改成單一 `Tool` 陣列（不再包 `appId`/`thought`），`tool create` 同步支援一次吃單一 `Tool` 或 `Tool` 陣列——讓兩者真正可以 round-trip。另一個備選方向（尚未拍板）：CLI 額外提供一個「整份 App-shaped YAML 一次載入」的指令（例如 `onagent app load <file.yaml>`），這樣 `backend/internal/console/tool-builder-tools.yaml` 這類完整 App 定義檔可以直接部署，不需要拆成多個單一 Tool 檔案。

尚未修正——只完成了問題確認與根因分析，程式碼改動還沒動手。

## `aiToolGenerator.ts` 重造 `Playground.tsx` 已有的 WebSocket 協定邏輯（已確認、尚未修正）

`apps/console/src/aiToolGenerator.ts`（AI tool builder 的核心邏輯）自己手刻了一份 WebSocket 協定處理（hello → 等 ack → prompt → 處理 `tool_call` → 回 `tool_result`），跟 `apps/console/src/Playground.tsx` 已經寫好、驗證過的協定處理邏輯是兩份獨立、平行維護的實作，沒有共用程式碼。

這被認為是 AI tool builder 曾經完全壞掉（`propose_tool` 設成 `kind: query` 但 `aiToolGenerator.ts` 只監聽 `tool_query`，實際上後端對 `kind: action` 的工具送的是 `tool_call`，導致訊息類型完全對不上、生成永遠逾時失敗）這個 bug 的背後根因——如果當初重用 `Playground.tsx` 已有的協定處理程式碼，而不是重新刻一份，這個訊息類型不匹配的錯誤本可以在寫程式當下就被既有邏輯的行為約束住，不會需要另外一次除錯才發現。這個 protocol type bug 已經在 commit `552db38` 修正（`kind: action` + 監聽 `tool_call`），但**重複實作本身**（根因）還沒解決。

尚未拍板的細節：
- 具體怎麼重構才能讓兩者共用協定處理邏輯（抽出共用的 hook/module，還是讓 `aiToolGenerator.ts` 直接複用 `Playground.tsx` 的某個內部函式）
- 這次重構的優先順序——目前 protocol type 已經修好，功能上暫時堪用，這是一次「防止未來同類 bug 再發生」的技術債清理，不是緊急修復

尚未修正——只完成了問題確認與根因分析，程式碼改動還沒動手。

## Playground 工具呼叫視覺化（構想，尚未拍板）

目前 console 的 Playground（`apps/console/src/Playground.tsx`）收到 `tool_call` 事件時，只用純文字顯示：`${toolName}(${JSON.stringify(args)})`（見該檔案 `appendMessage('tool_call', ...)`）。對於工具數量多、參數複雜的 app，純文字呈現不容易一眼看出發生了什麼。

構想方向：把工具呼叫改成更直觀的視覺呈現，而不是一行 JSON 字串——例如用卡片式呈現工具名稱、參數列表，或針對常見的參數型態（例如陣列、巢狀物件）做結構化展示。

尚未拍板的細節：
- 具體的視覺化形式（卡片、表格、時間軸等）
- 是否需要因應不同工具的參數 schema 做客製化呈現，還是統一用一種通用格式
