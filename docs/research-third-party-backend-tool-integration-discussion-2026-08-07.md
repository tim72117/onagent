# 第三方後端工具串接 onagent 推論架構：概念摘要

> 本文件原為一場由第三方開發者、系統架構師、資深工程師三個角色參與的完整討論逐字稿（第二、三輪），已精簡為概念摘要，去除對話過程。**以下所有概念在程式碼裡完全沒有實作**——即使是已經整理進 [refactor-backend-tool-dispatch-design-2026-08-08.md](refactor-backend-tool-dispatch-design-2026-08-08.md) 的部分，那份文件也只落地了最小 PoC（`Tool.BackendDispatch` 的 `Endpoint`/`TimeoutMS` 兩個欄位、WS 觸發），不含本文件討論的任何內容（HMAC 簽章、密鑰輪替、去程 API、`X-Onagent-User-Ref`、async/callback 機制）。

## 背景

第三方開發者（案例：tripace 專案）需要讓 onagent 的 LLM 推論能呼叫自己後端的工具（庫存查詢、付款退款、訂單狀態），且部分觸發場景（排程、無 UI 的純 API 產品）完全沒有瀏覽器頁面在線，因此無法沿用既有的前端／WebSocket `askPage` 架構。討論確立方向為：**onagent 主動發起 outbound webhook**，呼叫第三方登記的 endpoint。

## 核心協定設計

**Schema**：`toolschema.Tool` 新增可選的 dispatch 區塊，依 `Kind` 分兩組互不共用的欄位——`QueryDispatch`（`Retryable bool`，無腦重打）與 `ActionDispatch`（`IdempotencyKeyRequired bool`、`RetryBackoff string`，重試須帶同一把 key），避免 query 類工具背上不相關的 idempotency 複雜度。

**Request**：`POST {endpoint}`，body 為 `{toolName, args, idempotencyKey?, dispatchedAt}`；Headers 含 `X-Onagent-Timestamp`、`X-Onagent-Nonce`、`X-Onagent-Signature`（HMAC-SHA256）、`X-Onagent-Key-Id`、`X-Onagent-User-Ref`（見下）。

**簽章**：`HMAC_SHA256(secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + body)`，概念上參考 Stripe webhook + AWS SigV4 canonical string 的簡化組合，非任何一家的原版。timestamp 容許誤差 ±5 分鐘防重放。承諾提供 Go/Python 參考驗證 script 與最小 verify library，避免第三方各自重刻簽章邏輯產生細節落差。

**Response 與錯誤分類**：成功回 `200 {ok:true, result}`；`tool_error`（業務邏輯拒絕，如 4xx、參數不合法）回饋給 LLM 時用明確語意讓它知道「重試不會有幫助」；`tool_unavailable`（逾時、5xx、連線失敗）則引導 LLM「暫時查不到，可用既有資訊繼續」。判斷標準是「重試是否有機會成功」，不是「失敗發生在自己服務還是下游」——下游逾時/5xx 算 `tool_unavailable`，下游明確 4xx 算 `tool_error`，不論該下游是否第三方自己維護。

**逾時與重試**：`query` 逾時/`tool_unavailable` 直接重打，用 `timeoutMs`；`action` 重試須帶同一把 `idempotencyKey`，用 `retryBackoff` 退避；`tool_error` 一律不重試。

**Idempotency key 生成**：由 onagent 後端在 dispatch 當下生成 UUID v4，放進 request payload，第三方原樣收下比對——不開放第三方自訂格式，避免同一輪對話高頻連續呼叫同一工具時產生格式不一致或碰撞。與既有的 `randomID()`（16 bytes hex，用於 WS session id）是不同的識別碼，新路徑獨立生成，不影響既有機制。

## 密鑰管理

onagent 對每個 app 簽發 HMAC 密鑰，密鑰管理採**可隨時到 console 重新檢視／輪替**模式（不是一次性顯示、事後不可查看）——只顯示中繼資訊（建立時間、最後使用時間、目前生效狀態），不顯示明文。輪替支援**雙密鑰並存期**（預設 7 天可調）：新舊密鑰在並存期內都驗證通過，第三方可無痛切換；密鑰外洩時可立即單方撤銷（不等並存期跑完）。`X-Onagent-Key-Id` header 讓第三方不需自行試多把密鑰，直接查表對應。

這需要一個全新的密鑰儲存機制（例如獨立的 `dispatchkey` store），因為現有 `internal/auth` 的 app API key 是「一次性顯示、重新發放即立即撤銷舊的」，沒有任何並存期或中繼資訊查詢的基礎。

## `X-Onagent-User-Ref`：使用者層級識別碼

**問題**：協定草案原本只能識別「這是哪個 app」（`Key-Id`），無法識別「哪個使用者、哪段對話」。第三方需要這個資訊做 per-user 限流（避免單一使用者耗盡第三方自己的下游 API 配額）、個人化推薦、除錯歸屬。

**方案**：由第三方在觸發推論時提供自己定義的終端使用者識別碼（`userId`，onagent 不驗證其真實性，信任邊界與 `appId` 一致），onagent 結合 `appId` 做命名空間隔離後，用 SHA-256 雜湊成固定長度、不透明的字串作為 `X-Onagent-User-Ref`，跟隨該使用者的所有工具呼叫。刻意不做成「per-session 識別碼」（例如衍生自 WS 連線 id）——因為那樣同一使用者開多分頁、重整頁面就會被判定成不同使用者，限流可被繞過，達不到需求。

**來源消歧義**：這個 header 有兩條互斥的輸入路徑——WS 觸發時吃 `hello.userId`，`POST .../complete`（見下）觸發時吃該 API request body 的 `userId`，兩者不會同時存在，也不存在「以誰為準」的問題，觸發路徑決定輸入來源。

## 去程：獨立於 WS 之外的推論觸發 API

**問題**：原方案完全沒有涵蓋「第三方要怎麼觸發第一次 LLM 推論」，只描述了 onagent 主動打第三方後端的回程。查證確認 onagent 當時完全沒有任何非 WS 的推論觸發入口，對「排程觸發」「純 API 產品、無 UI」這類場景，即使回程做完，核心需求依然沒被滿足。

**方案**：新增 `POST /v1/apps/{appId}/complete`，body 帶 `prompt`、`userId`、可選 `conversationId`；認證複用既有 `auth.Store.Verify`（`Authorization: Bearer <apiKey>`），不需要 WS handshake。

**Session 生命週期**：採用「第三方傳 `conversationId`，onagent 對應到 orchestrator map 的 key」而非一次性 session——因為「LLM 自主規劃整趟行程」這類場景需要第三方連續呼叫這支 API 多次才能收斂，一次性 session 會讓每次呼叫都失去先前規劃上下文。引入閒置逾時機制（例如 30 分鐘無新請求自動清理）取代連線斷開觸發的清理，因為沒有 WS 連線可以借用生命週期。

## Async 模式的最終決議：callback，不是輪詢

`ActionDispatch.Mode: "sync" | "async"` 欄位——這次討論刻意只預留欄位、值域現在只開 `"sync"`，PoC 不實作 async（用不到，`recommend_nearby` 是同步查詢）。但完整方向已拍板：

1. 曾參考 Anthropic MCP 2026-07-28 規格的兩個設計：(a) 用「呼叫端自己攜帶的 explicit handle」取代 transport 層 session；(b) 用 poll-based `tasks/get` 取代 callback。
2. **否決 (a)**：MCP 的 handle 對應單次工具呼叫的小量狀態，onagent 的 `conversationId` 對應完整多輪推論上下文（LLM 看過的所有歷史訊息、之前所有工具呼叫結果），量級不同，不適合編碼進一個往返傳遞的 token。
3. 一度**採納 (b)**（輪詢取代 callback，因為同時解決 callback 認證方向反轉、以及多副本部署下 pending-callback map 可能對不上 process 的問題），但隨後發現遺漏了「onagent 自身容量負擔」這個維度——輪詢模式下 onagent 是主動方，需持續對每個進行中任務發送真實 HTTP 請求，若同時服務 N 個第三方、每個 M 個並行長任務，等於同時維持 N×M 條輪詢排程，是**隨規模線性增長的持續性負載**，牽動已知的 `want` orchestrator 全域序列化瓶頸。
4. **最終定案：恢復 callback 為 async 模式的正式方案**，推翻輪詢裁定。判斷依據：認證反轉、多副本相容性是「一次性架構成本」，設計對了不會隨規模惡化；輪詢的資源負擔是「持續性、隨規模線性增長」，沒有一次性解法能根除，backoff 只能減緩不能消除。SaaS 平台架構決策應優先避免隨用戶數增長而增長的成本結構。多副本部署風險維持記入技術債，等真正要水平擴展時再解。

**Callback 機制細節**：第三方收到 dispatch 後回 `202 Accepted` + 第三方自訂 `taskId`；之後由第三方主動呼叫 onagent 開放的 callback endpoint 把結果送回，認證方向反過來（第三方對 onagent 簽章，onagent 驗證）。等待期間需要一個不同於 `tool_unavailable` 的中間態語意（「已受理、處理中」），讓 LLM 知道可以先繼續對話。實作上可仿 `ws/session.go` 既有的 `pendingCalls map[string]chan protocol.ToolResultPayload` + `AskInteraction` 的 map+channel 配對模式，但需要挑一個非 Session 專屬的地方存放（dispatch 呼叫不是 WS 連線發起的）。

## 待確認／延後事項

- **`recommend_nearby` PoC 落地時的已知參數陷阱**：現有查詢是純 in-process 呼叫，改走 `BackendDispatch` 後需另抓一個遠比既有 20 秒基準小、但仍需容納 Google Places API 尾端延遲的 `timeoutMs` 數值，避免誤判為 `tool_unavailable`。
- **批次查詢語意**（供未來 `compute-route` 等多點距離查詢使用）：`QueryDispatch`/`ActionDispatch` 現在是單筆查詢的重試語意，沒有「陣列輸入、部分失敗如何回報」的欄位設計空間。是否能相容擴充（加一個平行的 `Batch *BatchDispatch` 欄位，不影響現有欄位語意）尚待查證；若會動到 `Query`/`Action` 本身的重試/退避邏輯則是破壞性改動，需重新考慮 schema 形狀。
- 本文件討論的內容尚未回寫進 [refactor-backend-tool-dispatch-design-2026-08-08.md](refactor-backend-tool-dispatch-design-2026-08-08.md)（去程 API、`X-Onagent-User-Ref` 消歧義、async/callback 機制的最終定案、參數陷阱備註）。

## 相關案例

[tripace-backend-tool-requirement-2026-08-07.md](tripace-backend-tool-requirement-2026-08-07.md) 記錄了一個非假設性的真實案例（tripace 專案的 `recommend_nearby` 工具），佐證這類後端工具串接不是單純的理論需求。
