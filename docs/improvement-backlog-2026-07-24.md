# onagent 全專案改良建議清單（2026-07-24）

> 產出方式：五個 Opus subagent 平行從不同面向深挖（後端架構、SDK/DX、產品策略、前端/UX、維運/安全/資料），
> 每個面向 20 項，共 100 項。要求每一項都必須引用真實的 `file:line`，避免空泛建議。
>
> **分類定義**（依實作成本與風險，非依內容性質）：
> - **實用** = 低風險、一兩天內能完成上線
> - **有趣** = 需要設計討論、重構，或牽涉產品／基礎架構決策
>
> 用途：自己參考、後續挑選項目實作。**未排優先順序**，各面向獨立成節。

---

## 目錄

1. [後端架構與 Go 程式設計](#1-後端架構與-go-程式設計)
2. [SDK 與開發者體驗（DX）](#2-sdk-與開發者體驗dx)
3. [產品策略、定位與商業模式](#3-產品策略定位與商業模式)
4. [前端架構與 Console UX](#4-前端架構與-console-ux)
5. [維運、安全、資料與可靠性](#5-維運安全資料與可靠性)

---

## 跨面向重點：這次挖出來的「不是建議、是現在就壞了」

這 100 項裡有幾項本質上不是「改良提案」，而是**已經存在的缺陷**，獨立於這份清單被發現，值得先列出來：

| 問題 | 位置 | 影響 |
|---|---|---|
| **刪 app 會清空計費紀錄，可無限免費重置額度** | `schema.sql:150` + `console.go:449` | 整個額度系統形同虛設 |
| **空 SessionID 會繼承上一位使用者的對話** | `inference/want.go:105-107` | 跨使用者資料外洩 |
| **推論逾時未中斷 orchestrator，訊息會串到下一位使用者** | `inference/want.go:159` | 跨使用者訊息外洩 |
| **console 併發寫入 want 全域 registry** | `console.go:70` → `agent_roles.go:120` | `fatal error`，`recover()` 攔不住 |
| **codegen 端點無認證 + CORS `*`** | `main.go:259-260, 376` | 猜到 appId 就能拿走整份工具定義 |
| **`save-tools` 拒絕文件說可省略的 `appId`** | `main.go:441` → `loader.go:84` | 照文件做會失敗 |
| **console 編輯器存檔會靜默刪掉 `kind: query`** | `console/src/schema.ts:17-22` | query 工具默默失效、無錯誤訊息 |
| **定價頁寫 per app，程式碼是 per owner 加總** | `pricing/index.html:185` vs `quota.go:255` | 開三個 app 等於各只有 1/3 額度 |
| **`@onagent/bridge` 從未發布到 npm** | `.github/workflows/` | 文件第 3 步對所有人都是死路 |
| **範例自帶的 `returns: type: array` 會讓 codegen 回 500** | `analysis/tools.yaml:134` vs `typescript.go:69` | 專案自己的範例是壞的 |

另外有一項**在有人付費之後無法存活**的營運問題：免費用戶的推論全部計入你自己的 provider key 且無成本上限。

> ⚠️ 也請注意：`backend/go.mod` 釘的是 `want v0.0.2`，**本機 `/Users/caitingyu/Documents/want` 那份已改過的程式碼不是實際建置用的版本**。

---

## 1. 後端架構與 Go 程式設計

> ⚠️ **前置事實**：`backend/go.mod:20` 釘的是 `want v0.0.2`，**沒有 `replace` 也沒有 `go.work`**，
> 所以本機 `/Users/caitingyu/Documents/want` 那份已經改過的程式碼**不是實際建置用的版本**。
> 下面凡是提到 want 內部行為的，都以 module cache 裡的 v0.0.2 為準。

### 實用（低風險、一兩天可完成）

1. **socket 關閉時要取消進行中的推論** — 在 `NewSession`（`ws/session.go:53`）用 `context.WithCancel` 包一層並 `defer cancel()`。`ws/handler.go:162` 傳的是 `r.Context()`，而對一個已被 hijack 的 WebSocket 來說，**客戶端斷線永遠不會取消它**，所以 `s.infer.Complete`（`session.go:255`）會在分頁關掉之後繼續跑最多 90 秒，而且**繼續佔著全域 orchestrator mutex**（`inference/want.go:92`）。約 30 分鐘。

2. **HTTP server 加上逾時與優雅關閉** — 把 `main.go:283` 的 `http.ListenAndServe` 換成 `&http.Server{...}` 加 `signal.NotifyContext` + `Shutdown`。沒有 header timeout 等於免費送人 Slowloris；而 `main.go:109` 的 `defer conn.Close()` 今天根本無法執行，因為沒有東西會讓 `ListenAndServe` 正常返回。1-2 小時。

3. **設定資料庫連線池** — 在 `db/db.go:22-36` 加 `SetMaxOpenConns`/`SetMaxIdleConns`/`SetConnMaxLifetime`。單一 `*sql.DB` 被所有 store 共用，而 Go 預設無上限；一次 handshake 尖峰每條連線就要 3 次以上查詢（`auth.Verify`、`quota.ownerStanding`、`quota.usageSince`），足以耗盡 Postgres `max_connections`，把一次流量尖峰變成一次全面停機。15 分鐘。

4. **🔴 修掉空 SessionID 的 fallthrough — 會繼承別人的對話** — `inference/want.go:105-107` 只在 `sanitizeSessionID` 回傳非空時才覆寫 `orch.AgentID`。`want.go:188` 的註解宣稱這個 fallback 意思是「沿用 orchestrator 自己的 AgentID」，但**第一次呼叫之後，那個欄位存的是上一位呼叫者的 session id**——所以一個 SessionID 為空或格式錯誤的請求，會靜默繼承另一個使用者的對話記錄。應直接拒絕該請求。20 分鐘。

5. **🔴 `completeTimeout` 時要中斷 orchestrator — 否則訊息會串台** — `inference/want.go:159` 直接返回，沒有像 `:157` 那個分支一樣呼叫 `s.orch.Interrupt()`。被放棄的那次執行仍在跑，而事件主題是全域的（`"agent.inference"`）、`ui.HandleInferenceMessage` 也不依 AgentID 過濾，於是它後續產生的文字事件會落進**下一位呼叫者**的 `text` builder（`want.go:134-138`）。這是跨使用者的助理訊息外洩。30 分鐘 + 一個測試。

6. **`cliauth.Exchange` 要做成原子操作** — `cliauth/cliauth.go:103-111` 是在交易之外做 SELECT-then-UPDATE。兩個並發的 callback 可以在任一方清除 token 之前都讀到它，**破壞了 package 文件與 `schema.sql` 註解都承諾的「單次使用」保證**。應收斂成單一句 `UPDATE ... RETURNING token`。30 分鐘。

7. **清理過期的 session 資料列** — 開機起一個 goroutine 定期刪除 `sessions`、`admin_sessions`、`cli_auth_sessions`，並補 `expires_at` 索引。目前只有明確登出（`session.go:216`）或 exchange 才會刪除，`session.go:31` 的 30 天、`adminauth.go:36` 的 12 小時、`cliauth.go:22` 的 10 分鐘 TTL **全都只是讓資料列永遠變成死列**，而 `Verify` 的 `expires_at > now()` 過濾（`session.go:201`）連索引都沒有。半天。

8. **收斂重複的 crypto/HTTP helper** — 一個 `internal/secret`（`RandomToken`、`Hash`）加一個 `internal/httpx.WriteJSON`。目前有**五份幾乎相同的 32-byte token 產生器**（`auth.go:194`、`usertoken.go:176`、`cliauth.go:114`、`adminauth.go:221`、`session.go:248`）、兩份相同的 sha256 hasher（`auth.go:189`、`usertoken.go:156`），以及被逐字複製到 `console.go:636` 與 `adminconsole.go:168` 的 `writeJSON`。2 小時。

9. **消滅 `listApps` 的 N+1** — `console/console.go:327-328` 在迴圈裡逐一呼叫 `h.Auth.HasKey(id)` 與 `h.Auth.OriginFor(id)`，各一次往返。20 個 app = **41 次查詢才畫得出一個儀表板**，而這兩個欄位就在同一列 `apps` 上——一句 `SELECT app_id, api_key_hash IS NOT NULL, allowed_origin FROM apps WHERE owner_id=$1` 就能全部取代。1 小時。

10. **限制每個 session 的並發 prompt 數** — 在 `ws/session.go:163` 的 `go s.handlePrompt(...)` 外面加一個深度為 1 的 semaphore，忙碌時回一個帶錯誤碼的訊息（`protocol/message.go:117` 已有這個模式）。目前完全沒有限制，所以單一客戶端可以生出無限個 goroutine，每個都吃掉一次額度檢查、一條 DB 連線，然後全部塞在 `want.go:92` 的全域 mutex 上排隊。2 小時。

### 有趣（需要設計討論或重構）

11. ~~**升級 want 並改用 `ToolProvider` 注入，而非它的全域單例**~~ — **已完成（2026-07-27，`want` v0.0.2 → v0.1.0 → v0.2.0）**。`agent_roles.go` 的 `appToolProvider` 現在實作 `types.ToolProvider`，每次呼叫即時讀 `toolschema.Registry`，不再寫入任何全域 registry；驗收測試見 `agent_roles_test.go`。詳見 `docs/known-issues-want-dependency.md` 更新後的內容。

12. ~~**🔴 並發的 console 寫入正在 race want 的全域 registry — 而且是致命的**~~ — **已隨上一項解除**：`agent_roles.go` 不再呼叫 `types.RegisterTool` 或寫入任何全域 slice/map，`console.syncWantRole` 現在只是重新註冊角色白名單（一個獨立的、per-app 的 map 條目），與 dispatch 讀取的是完全不同的資料結構，原本描述的並發 race 情境已不存在。

13. **把 view-model 事件路徑換成有序的串流** — `want@v0.0.2/events/event_bus.go:79-88` 每個 handler 都開一條自己的 goroutine，所以 `want.go:134-138` 是**以任意順序**在串接文字片段；`textMu` 防的是資料競爭，不是順序錯亂，而 `idleSettleDelay`（`want.go:58`）那個 1.5 秒的 sleep 根本就是為了掩蓋同一個問題硬加上去的——**而且是在持有全域鎖的狀態下睡**。應改成消費有序的 per-run channel（want 在 `orchestrator.go:228` 已有 `uiEvents`）或加上序號。1 週，部分在上游。

14. **unsubscribe 的身分比對是壞的，且會擋住任何並發改造** — `event_bus.go:56` 用 `fmt.Sprintf("%p", h)` 比對 handler，那是**程式碼指標，對每一個從 `want.go:127` 建立的閉包都相同**。今天靠 mutex 遮住了（同時只有一個訂閱者）；一旦跑兩個 orchestrator，`want.go:150` 的 `defer unsub()` 就會開始**取消掉別人的訂閱**。需要上游先改成 token-based Subscribe，這是任何並發重構的前置阻擋項。上游小改，但阻塞性。

15. **`askers` map 讓這個後端在架構上就無法多實例** — `inference/interaction.go:34-37` 是 process 內的 map，`askPage`（`:85-95`）靠它找到瀏覽器。跑兩個 replica 時，一個推論落在 pod B 的 query tool，對於連在 pod A 的瀏覽器會直接失敗「找不到連線的頁面」。要嘛在邊緣做 session 黏著，要嘛把這組問答往返搬到以 session id 為鍵的共享匯流排上。1-2 週。

16. **orchestrator 改成有界佇列的資源池，而非一個 process 一個或一個 session 一個** — N 個 orchestrator，依 session id 指派回合，全忙時拒絕或帶截止時間排隊。新的切入角度：`ToolKindQuery` 會在慢速頁面上阻塞最多 20 秒（`ws/session.go:322`）**同時持有那把唯一的鎖**——`toolschema/schema.go:44` 的註解自己就寫明這會拖垮所有其他租戶。資源池能把它變成「一條降級的車道」，並讓容量變成一個可調參數、對齊 LLM 供應商的並發上限。1-2 週。

17. **對話歷史改存 Postgres，不要用 want 的 `sessions/*.jsonl`** — want 為每個 AgentID 寫一個相對於 cwd 的檔案（`orchestrator.go:286-289`），並把每個 `Experience` 都快取進 `GlobalSessionStorage.cache`（`internal/session_storage.go:79`）——**v0.0.2 裡沒有任何地方會逐出快取**，而每次重連都會鑄造一個新 id（`ws/id.go:8`）。這是無上限的記憶體 + 磁碟洩漏，而且在 Cloud Run 上歷史記錄本來就會隨著重新部署蒸發。1-2 週。

18. **抽出 `internal/config` 並做 fail-fast 驗證** — 一個 `Load() (Config, error)` 涵蓋 `main.go:41-75` 記載的所有項目，然後是一個純粹的 `wire(cfg)`。`main.go` 現在是 488 行的解析與接線交織，而 `AI_PROVIDER` 只在函式庫深處才被驗證——`want/orchestrator/init_helper.go:65` 會印一行中文 `[Fatal]` 然後從 `main.go:455` 的 `inference.NewWant` 裡面直接 `os.Exit(1)`，**完全繞過 slog**。3-4 天。

19. **把 `toolschema.Registry` 做成 repository 並支援單一 app 失效** — 把 `registry.go:183-310` 的 SQL 移到 `Store` 介面後面，只重載被改動的那個 app。目前每次 console 寫入都會呼叫完整的 `Reload()`（`registry.go:83, 97, 122, 159`），為了改一個工具而**重讀所有租戶的所有 app 與所有工具**；而這個介面也正是讓這個 package 終於可測試的關鍵——整個 backend 只有 4 個測試檔，全是 integration。1 週。

20. **🔴 真正的 middleware 鏈，並把 codegen 端點納入授權** — 今天只有 `recoverMiddleware` + `withCORS`（`main.go:283`）。更嚴重的是 `main.go:259-260` **未經任何認證**就把每個工具的名稱、描述、參數 schema 提供出去，還配上 `Access-Control-Allow-Origin: *`（`main.go:376`）——任何人只要猜到一個 appId，就能拿到那個開發者的**整個產品介面，以及一份現成的 prompt injection 目標清單**。1 週。

---

## 2. SDK 與開發者體驗（DX）

### 實用（低風險、一兩天可完成）

1. **`save-tools` 會拒絕一個文件明說可以省略 `appId` 的 `tools.yaml`** — `runSaveTools`（`main.go:441`）先 unmarshal 成 `toolschema.App` 才呼叫 `app.Validate()`，而 `loader.go:84` 第一件事就是檢查 `ValidAppID(a.AppID)`，於是對一個 `docs/index.html:583` 明確說「appId 可省略」的檔案報錯 `invalid appId ""`。修法：驗證前先用 CLI 參數填入 `app.AppID`。**1 行 + 一個測試。**

2. **被拒絕的 handshake 完全無聲：無限靜默重連** — key 錯誤、appId 未知、origin 未設定都讓伺服器在 upgrade 前回 401/403（`ws/handler.go:101,117,124`），瀏覽器只丟 `error`+`close`，而 `client.ts:204` 什麼都不做、`:198` 則永遠重連下去。**這是最常見的「五分鐘內失敗」情境，卻零診斷資訊**——沒有 `onError`、沒有 console 輸出。應新增 `onConnectionError` 並在連續 N 次失敗後 `console.error`。

3. **`returns.type === "object"` 應該在存檔時驗證，而不是拖到 codegen 才爆** — `codegen/typescript.go:69` 對非 object 的頂層 `returns` 直接報錯，而 `examples/analysis/tools.yaml:134` 宣告的正是 `type: array`。結果是**專案自帶的範例會讓 `GET /apps/analysis-app/tools.ts` 回 HTTP 500**，且完全沒有線索指向 YAML 才是問題所在。應把檢查加進 `App.Validate`，放在 `loader.go:108` 的 query/returns 規則旁邊。

4. **Console 編輯器會靜默把 `kind: query` 工具降級成 action** — `apps/console/src/schema.ts:17-22` 的 `Tool` 型別根本沒有 `kind` 欄位，而 `api.ts:121` 又把整個 `Tool[]` 原封 PUT 回去。於是在 UI 開啟任何含 query 工具的 app 再存檔，`kind` 就消失了，頁面的 query handler 從此不再餵資料給 LLM——**全程沒有任何錯誤訊息**。`validate.ts:15` 也缺少 `loader.go:108` 那條「query 必須有 returns」的規則。

5. **新增 `onagent types` 與 `onagent validate` 指令** — `types <appId> -o tools.d.ts` 抓 `/apps/{appId}/tools.ts`；`validate <file>` 純本機跑 `App.Validate`。目前 codegen 端點在 `docs/index.html` 完全沒被提到，**沒有人知道它存在**；而 `main.go:74-91` 的 usage 也沒有離線 lint，每個 typo 都要付一次網路往返。約 60 行，可重用現有 `apiClient`。

6. **讓 `@onagent/bridge` 真的裝得起來** — `docs/index.html:745` 寫 `npm install @onagent/bridge`，但 `.github/workflows/` 沒有任何 publish job，兩個範例都用 `file:../../packages/bridge`。另外 `package.json:3` 是 `0.0.1` 但 `client.ts:11` 每次 `hello` 都回報 `SDK_VERSION = "0.1.0"`，**伺服器端的版本遙測從一開始就是錯的**。需補 `exports`、`license`、`repository`、README 與 publish job。

7. **限制送出佇列的長度** — `client.ts:309-315` 與 `:327-333` 在 socket 非 OPEN 時無上限地 push。搭配上面第 2 點（key 錯誤導致永久重連），每次 `prompt()` 都會無限累積，然後在某次連上時被 `flushQueue`（`:317`）一次全部送出——直接變成打向 `ws/session.go:246` 額度閘門的驚群效應。應加 `maxQueuedMessages`（預設約 32）採 drop-oldest 並警告。

8. **`defineTool<Args, Result>`** — `client.ts:63` 只把參數泛型化，`handle` 回傳型別仍是 `Promise<unknown> | unknown`。但 codegen 已經為每個有 `returns` 的工具產生了 `XResult` 介面（`typescript.go:44-48`），query 工具又必須符合那個形狀——**偏偏在回傳型別最重要的情境下完全沒有型別**。加第二個可推導的型別參數，向後相容。

9. **三個看起來支援、實際什麼都沒做的選項** — `HelloPayload.initialData` 在 `protocol.ts:26` 與後端 `message.go:68` 都有定義，但 `client.ts:187-191` 從不填值；`beaconUrl`（`client.ts:349`）在整個 `backend/` 找不到任何接收路由；`validateHandlers`（`client.ts:268-275`）只檢查 backend→local 單向且僅 `console.warn`。三者都長得像已支援的功能。應補上反向檢查（本地註冊了後端不知道的 handler ≈ 幾乎必然是 typo）。

10. **範例本身在誤導使用者** — `react-demo/tools.yaml:2` 還寫著已改名的 `atp save-tools`；`react-demo/README.md` 是完全沒動過的 Vite 樣板、零 onagent 內容；`App.tsx:28-56` 沒傳 `apiKey` 且用舊的 `Record` 形式而非 `defineTool`；`analysis/App.vue:105` 用 `appId: 'analysis'` 但 `tools.yaml:1` 是 `analysis-app`——**只因為 key 會覆寫 appId 才碰巧能動**。兩個範例都讀 `VITE_AGENT_WS_URL`/`VITE_AGENT_API_KEY` 卻都沒有 `.env.example`。

### 有趣（需要設計討論或破壞性變更）

11. **`defineTool` 支援 Standard Schema** — 在現在 `parseArgs` 的位置接受任何暴露 `~standard` 的物件（zod 4、valibot、arktype）。`client.ts:63-72` 既然已經讓 `parseArgs` 成為型別的真相來源，這只是**加寬而非重新設計**，還能消滅 `analysis/App.vue:70-90` 那些手寫驗證。約 1 週（含「從同一個物件推導出 `parameters:` JSON Schema」那一半）。

12. **反轉編寫流程：TypeScript 是來源，YAML 由它產生** — `onagent push` 從 `defineTool` 呼叫中萃取工具定義並 PUT 上去。目前 `toolschema.Tool`（`schema.go:11`）、產生的 `ToolHandlers`（`typescript.go:52`）、handler 自己的 `parseArgs` 是**三份靠手動同步的來源**——`apps/console/src/schema.ts:1` 甚至直接寫著「兩邊請手動保持同步」的註解。2-3 週，需要先決定 YAML 的去留。

13. **codegen 產出 `defineApp` 而非裸的 `ToolHandlers` 介面** — 讓 codegen 產生一個帶型別的 factory，由建構子強制檢查完整性與名稱正確性。`typescript.go:31,52` 已經產生 `ToolName` 與 `ToolHandlers`，但 `AgentBridgeOptions.tools` 是 `Record<string, ToolHandler> | ToolEntry[]`（`client.ts:101`）——**產生的型別完全沒有被 SDK 檢查到**，漏掉一個工具至今仍只是 `client.ts:271` 的執行期 warning。約 1 週。

14. **發布 `@onagent/bridge/testing`** — 把假 transport 與斷言 helper 一起發出去。`examples/analysis/test/mock-websocket.js:13` 是一個精心手刻的 `MockWebSocket`，重新實作了 `client.ts` 用到的每一個 API——**每個採用者都得自己重造一次**，而且 SDK 只要多用一個 WebSocket API 就會壞掉。3-4 天，主要是把現有程式碼抽出來。

15. **離線/mock 模式與錄放（record-replay）** — `transport: "mock"` 重播一份錄好的 envelope log，讓 handler 完全不需要後端就能被驗證。目前 `analysis/dev-up.sh` 要先跑起 Go 後端、Postgres、console dev server 和一個 vLLM 端點，**才能試一個 tool handler**；而 `client.ts:182` 又硬寫 `new WebSocket(...)`，沒有任何接縫。1-2 週。

16. **React/Vue 轉接層（`useAgentBridge`、`createAgentBridge`）** — 框架慣用的包裝，負責生命週期與連線狀態。`client.ts:153-160` 在建構子裡直接連線，沒有 `connect()`/`reconnect()`、沒有公開的 ready 狀態，導致 `react-demo` 在 StrictMode 下**每次 dev mount 都開兩條 socket**，而 `analysis/App.vue:151` 在建構後立刻把 `connecting` 設為 false——**那個值根本是錯的**。需先拆生命週期，之後約 1 週。

17. **給 `prompt()` 一個生命週期** — 回傳一個 handle（`{ id, done, cancel }` 或 AsyncIterable），並把 `requestId` 貫穿到 `assistant_message`。`client.ts:163-166` 產生了 `requestId` 卻直接丟掉，而 `AssistantMessagePayload`（`protocol.ts:50-52`）不帶任何關聯 id——所以**沒有任何採用者能做逐訊息的 spinner、取消一個回合、或交錯兩個 prompt**。這也是 token streaming 的前置條件。協議變更，約 2 週。

18. **帶版本的 tool schema 與相容性握手** — 為每個 app 的工具集加版本；`hello` 帶上 SDK 預期的版本/雜湊，`ack` 回報漂移。目前 `main.go:311` 讀的是活的全域 registry，所以一次 `save-tools` 推送會**即時改寫所有已連線頁面底下的工具集**，唯一回饋是 `client.ts:271` 的 warning；反向情況（已部署頁面比推送的 schema 新）則完全偵測不到。可支撐分階段推出與回滾。2-3 週。

19. **可抽換的 transport** — 在 `client.ts:182` 後面放一個介面，WebSocket 只是其中一種實作，另外提供 SSE+POST 與同源 `postMessage` 版本。WebSocket 握手正是**API key 必須放在 query string 的唯一原因**（`client.ts:174-179`，文件在 `:83-89`）——HTTP transport 可以送真正的 `Authorization` header。也讓 SDK 測試不再綁著 socket。約 2 週。

20. **工具呼叫模擬器 + devtools 面板** — 開發模式專用的 `bridge.simulateToolCall(name, args)`，加上 console Playground 裡的「直接呼叫這個工具」按鈕與 envelope 檢視器。目前 `playground.go:218` 只能靠「說服 LLM 去呼叫它」來觸達一個 handler，所以除錯參數形狀的 bug 等於在玩 prompt 輪盤——正是 `analysis/App.vue:115-125` 那段 `clear`/`names` 註解記錄下來在對抗的那類 bug。1-2 週。

---

## 3. 產品策略、定位與商業模式

### 實用（低風險、一兩天可完成）

1. **定價頁寫的額度跟程式碼實際執行的不一致** — `pricing/index.html:185` 與 meta description 都寫「100 prompts **per app**, per month」，但 `quota.go:255-268` 的 `usageSince` 是 `JOIN apps ON owner_id` 跨所有 app 加總，實際是**每個帳號** 100 次。開發者若有 staging+prod+demo 三個 app，等於各只有 33 次，而頁面標題還寫著「Simple, honest pricing」。**這是全 repo 裡「每分鐘信任修復率」最高的一項，10 分鐘可改。**

2. **非production origin 應豁免或折扣計算額度** — 當 app 的 `allowed_origin` 是 localhost / 127.0.0.1 / 預覽網域時跳過 `Record`。文件的設定流程本身就鼓勵「每個環境開一個 app」，導致測試跟真實使用者吃同一份 100 次額度。成本：一個 `WHERE` 條件加一個 plan flag。

3. **`@onagent/bridge` 根本還沒發布到 npm** — `.github/workflows/` 只有 `deploy-cloudrun`、`release-image`、`release-onagent`，沒有 npm publish；兩個範例都用 `file:../../packages/bridge`。但 landing hero 與文件都寫 `npm install @onagent/bridge`——**整個 onboarding 的第 3 步對所有訪客都是死路**。成本：約一小時，但打通整條漏斗。

4. **已經在建置的 CLI 預編譯檔沒有被連結出來** — `release-onagent.yml` 已產出 darwin/amd64、darwin/arm64、windows/amd64 到 GitHub Releases，但 `docs/index.html` 提到 Releases 的次數是 0，只提供 `go install`。等於把第 1 步卡在「要有 Go 工具鏈」這個前提上，而 `marketing-strategy.md` §2 自己定義的 ICP 是前端開發者，多數沒有 Go。順帶補回 linux/amd64。

5. **文件應該以 Playground 開場，而不是 CLI** — `apps/console/src/Playground.tsx` 就是設計成「不用裝任何東西、不用有網站就能感受產品」，但 Playground 在 landing 與 docs 出現次數都是 **0 次**。現在的流程要求 Go → login → 建 app → 發 key → 設 origin → npm，全部做完才看得到價值。

6. **完全沒有任何埋點** — 全 `apps/` grep 不到 posthog/plausible/gtag/umami。而 `marketing-strategy.md` §8 明確承諾要追蹤「多少人完成 create-app → define-tool → embed-SDK」，目前這個數字無法被測量。

7. **定義並記錄啟用事件：`first_prompt_from_a_real_origin`** — 指某個 app 第一筆來自其設定 origin（而非 Playground）的 `usage_events`。這張表已經記了每次計費 prompt 與 `app_id`（`quota.go:106`），只差一個 join 就能知道「這個開發者是否真的上線了」——這是唯一能預測付費意願的數字。

8. **在 disabled 的 Starter 卡片放 email 收集** — 把 `pricing/index.html:204` 的 `<button disabled>` 換成「Starter 上線時通知我」。目前這張卡刻意展示一個不能買的方案，然後把它產生的 100% 購買意圖全部丟掉——這是取得定價訊號最便宜的來源。

9. **讓 `onQuotaExceeded` 有地方可去** — `client.ts:115` 已經把這個 hook 做完，`Sidebar.tsx:150` 也已顯示「used / limit」但只是靜態文字。兩處都加上升級/聯絡連結。額度用盡是開發者唯一保證會在意價格的時刻，目前整條訊號做完了卻沒有變現。

10. **修掉 H1 造成的「聊天機器人」誤讀** — hero 寫「give your website an AI assistant」（`index.html:438`），但 `marketing-strategy.md` §2 自己已經寫好更好的說法：「AI 呼叫**你自己的** JS 函式、點**你的**按鈕，不是外掛一個聊天機器人」。策略文件把這點列為最大認知障礙，然後線上頁面用了它警告的措辭。順帶改善對 Intercom/Fin 的 SEO 競爭位置。

### 有趣（需要產品決策）

11. **改成計 token 或 tool-call，而非計 prompt；並加上 BYO-model-key** — `usage_events.kind='prompt'` 讓「1 個工具的簡單回覆」跟「40k token 的多工具會話」計價相同。目前單一部署層級的 `AI_PROVIDER`/`AI_MODEL` secret 意味著**所有免費用戶的推論帳單都由你自己吸收，且沒有成本上限**。BYOK 能把模式翻轉成「每個 app 收平台費」，讓企業方案在不轉售 token 的前提下成立。

12. **在 orchestrator 修好之前無法銷售並發能力** — `NewRequestQueue(1, ...)` 加上跨 90 秒 `Complete()` 的單一 mutex，使全平台所有租戶被序列化。任何付費 SLA 今天都無法兌現，且一個卡住的 query tool 就能 DoS 所有客戶。修好之後，「保證並發 session 數」應該是**第一個**付費維度——因為那才是真正花你錢的東西。

13. **賣可觀測性，而不是賣 prompt 次數** — 做出 Tool-Call Observatory / Trace Inspector（`feature-ideas.md` #2、#9），把 transcript 保存期限當作付費軸：Free 24 小時、Starter 30 天、Team 1 年 + 匯出。沒有人會在沒有稽核紀錄的情況下，把一個自主呼叫工具的東西放進 production DOM。保存期限是你真實產生的成本，比 `plan.go:49` 那個註解直接寫著 `// placeholder` 的 100 次上限更有防禦性。

14. **改成按 app/站點收費，而非按帳號** — Free = 1 個 production origin、額度寬鬆；付費 = 每增加一個 production origin。目前 `quota.go` 的 per-owner 加總懲罰的正是你想鼓勵的行為（多開 app），而在 per-origin 定價下，把 onagent 嵌到多個客戶網站的**代理商/顧問公司會是最合適的早期買家**。

15. **專攻 `examples/analysis` 已經證明的問卷/分析垂直領域** — 那個範例已經有一個 100 行中文分析師人格寫在 `tools.yaml` 的 `thought` 欄位，驅動次數分配/交叉表/相關/迴歸的變數選擇。這是真正的垂直切入點——「問卷工具的自然語言變數選擇」，有實際買家（SurveyCake、Qualtrics 類、學術實驗室）；而 `examples/react-demo` 的 `click_checkout_button` 是跟每一家電商聊天機器人正面對撞。

16. **把 `thought` 欄位當成產品本身來行銷** — 每個 app 的自訂 system prompt（`ThoughtEditor.tsx`、`examples/analysis/tools.yaml`）本質是一個**託管、可版本控管的 agent 人格**，但 landing page 完全沒提。MCP 和 OpenAI function calling 給你 schema，但沒有人給你「託管 prompt + schema + 瀏覽器派發」這個三合一組合。那個組合才是真正的護城河，不是 tool calling 本身。

17. **提供 script-tag/UMD 版本，打開非 bundler 的網頁市場** — `packages/bridge` 目前是純 ESM（`"type": "module"`），沒有 IIFE/CDN 產物。WordPress、Shopify、Rails/Django、Webflow——這些「有值得被驅動的表單」的網站佔多數，現在完全裝不了。一個 `<script src>` 加 `data-` 屬性設定，是 Intercom/GA 的經典散布策略。

18. **開源 SDK + CLI，平台維持託管** — `packages/bridge` 與 `backend/cmd/onagent` 公開並採 MIT，推論/orchestration/quota/console 維持託管。`marketing-strategy.md` §4.3 已經把 repo 當成主要通路，但一個「要你貼 API key 進去的閉源 SDK」對重視安全的團隊是硬性拒絕——而且那把 key 本來就在瀏覽器 bundle 裡，沒什麼好藏的。

19. **在向任何人收費之前修好多租戶隔離** — `want` 的 `GlobalRegistry` 是 append-only、`GetTools` 是 first-match-wins，導致工具跨 app 洩漏、console 編輯 schema 靜默不生效。**你無法向一個「工具可能被其他租戶看見」的客戶開發票。** 可以把它轉化成 `feature-ideas.md` #1 的版本控管功能，順勢賣分階段推出。

20. **重新定位為「瀏覽器 DOM 的 MCP」，並提供 MCP bridge** — 把每個 app 的工具暴露成 MCP server，讓 Claude/Cursor 能驅動一個活著的使用者 session。`marketing-strategy.md` §3 已正確指出 MCP 是後端/無狀態的，而瀏覽器端的即時 DOM 狀態是無人認領的缺口——但現行策略是**迴避**這個比較。明確認領這個缺口是更強的位置，而且能透過每一個 MCP client 取得散布，而不只靠自己的 SDK。

> **一個凌駕以上所有項目的阻斷性問題**：Free 方案的推論全部計入你自己的 provider key 且無成本上限。**這件事在有人開始付錢之後是無法存活的。**

---

## 4. 前端架構與 Console UX

### 實用（低風險、一兩天可完成）

1. **SchemaEditor 改屬性名稱時每打一個字就失去焦點** — `SchemaEditor.tsx:133` 用 `key={name}`，名稱一變整列就重新掛載，輸入框每打一個字元就被拆掉重建；而 `:48` 的 `renameProperty` 又對空值/重複提早 return，**連退格都做不到**。應改用穩定 id 當 key（或維護本地 `draftName`、失焦時才提交）。這是工具編寫的核心流程。順帶一提，改名還會因為 delete+reinsert（`:50-54`）**把該屬性靜默移到物件最後**，連帶打亂 YAML 預覽順序。半天。

2. **「捨棄未儲存的變更？」在每次切換工具時都跳，按 OK 就把工作丟掉** — 在側欄點另一個工具會呼叫 `refreshDraftForSwitch()`，只要 `dirty` 就跳確認然後從伺服器重抓（`App.tsx:314-331` + `:155-157`）。一次 session 裡編輯兩個工具 = 每點一次跳一次視窗，而按 OK 會**丟掉使用者從沒打算放棄的編輯**——他只是想切換面板而已。應只在切換 app 時提示，乾淨狀態下靜默重抓。約 2 小時。

3. **「刪除工具」沒有確認，其他破壞性操作全都有** — `ToolForm.tsx:32` → `App.tsx:300` 立即刪除，但 `deleteApp`（`App.tsx:196`）、`revokeKey`（`:271`）、`issueKey`（`:228`）全都有確認。admin 端有同樣缺口：`admin/src/App.tsx:168` **在 select 變更當下就改掉使用者的計費方案，無確認**。1 小時。

4. **剪貼簿複製沒有防護 — 而 API key 只會顯示這一次** — `KeyModal.tsx:11` 直接 `await navigator.clipboard.writeText(...)`，沒有 try/catch 也沒有 fallback；在非安全來源（`http://192.168.x.x:5173`）`navigator.clipboard` 是 `undefined`，按鈕就只是**沒有反應**。而後端只保留雜湊（`api.ts:27-29`），這把 key 錯過就沒了。應加 try/catch → 錯誤 toast + 可選取的 fallback。1 小時。

5. **KeyModal 的整合範例漏掉必填的 `url` 選項** — `KeyModal.tsx:32` 印出 `new AgentBridge({ appId: "...", apiKey: "…" })`，但 `url` 是必填（`client.ts:76`、`docs/index.html:781` 寫著「url — Yes」）。**開發者複製 console 自己給的範例，第一步就會壞掉。** 應輸出真正的三行版本，`url` 由 `BASE` 推導成 `wss://<origin>/ws`。30 分鐘。

6. **儲存會丟掉 PUT 進行中所做的編輯** — `saveDraft`（`App.tsx:210-222`）先抓 `draft.tools` 快照，await 之後**無條件** `setDirty(false)`。在那趟往返期間打的任何字都被標記為已儲存，重新載入或切換 app 就消失。應比對送出的快照與當前 `draft`，不同則重新設回 `dirty`（或在 `busy` 時停用編輯器）。2 小時。

7. **被停用的儲存按鈕從不說明原因** — `canSave = dirty && issues.length === 0 && !busy`（`App.tsx:379,423`）。如果擋住的問題在一個沒被選取的工具上，使用者只會看到一顆死掉的按鈕，加上側欄某處一個小紅點——因為只有 `appLevelIssues` 會顯示在標頭（`:450`），工具層級的問題要點進那個工具才看得到。應加 `title`/行內文字：「2 個問題阻擋儲存 — 請修正 `get_orders`」。2 小時。

8. **Playground 斷線後永遠顯示「Connecting…」且無法重連** — `close`/`error` 時狀態是 `closed`，但輸入框 placeholder 用的是跟 `connecting` 同一個字串（`Playground.tsx:98`、`:123`），而唯一的復原方式是切到別的面板再切回來（effect 只在 `appId` 改變時重跑，`:39-73`）。應加重連按鈕、清除對話按鈕、以及真正的「已斷線 — 重新連線」提示。另外 `sending` 沒有逾時（`:86`），所以後端不回應時「Thinking…」會**永遠掛在那裡**。半天。

9. **Modal 與狀態點對鍵盤/輔助技術是隱形的** — 兩個 modal 都沒有處理 Escape、沒有焦點鎖定、也沒有把焦點還給觸發元素；`KeyModal.tsx:17` 連 autofocus 都沒有（`AddAppModal.tsx:30` 至少有）。側欄的健康狀態是一個 6px、**純靠顏色**的點，意義只寫在 `title=` 裡（觸控裝置與螢幕閱讀器都拿不到）。`style.css:294` 的 `.status-dot.warn` 還是死碼，沒有任何 TSX 用到。`apps/admin/src/App.tsx` 則是零個 `aria-` 屬性。半天。

10. **Landing 的主要 CTA 在 JS 執行前都是 `href="#"`** — 每個「Open Console」按鈕都以 `#` 出貨再由前端改寫（`index.html:415,445,627,642,644` + `:657-658`，`zh-tw/index.html:407` 同樣）。爬蟲、以及在 hydration 之前中鍵點擊的使用者，**兩者都拿到空的**。應直接在 HTML 裡放真正的 `/app`，讓 script 只負責覆寫。30 分鐘。

### 有趣（需要重構或設計決策）

11. **抽出 `packages/web-shared` 放 API client 與登入外殼** — 一份 `request()`/`ApiError`/`BASE` 加上共用的登入卡片與 modal 原件，console 與 admin 共同使用。`console/src/api.ts:80-97` 與 `admin/src/api.ts:50-67` **連錯誤字串都逐位元組相同**；而兩邊的登入表單（`console/src/Login.tsx:26-46`、`admin/src/App.tsx:24-64`）**已經開始漂移**（只有 console 會呼叫 `offerToSavePassword`）。2-3 天。

12. **一套設計 token 給三個前端共用** — 把 console 的 token 集發布成 CSS，admin 與 landing 都吃它。console 有完整的明暗系統（`console/src/style.css:5-76`），admin 卻硬寫一組不相干的純暗色（`admin/src/style.css:1-9`），landing 則每頁重新內嵌約 380 行 CSS。而且 console 明明有 `:root[data-theme='light'|'dark']` 覆寫（`style.css:51,68`），**UI 上卻沒有任何切換開關**。3-4 天。

13. **真正的路由與可用網址表達的狀態** — 導入 router，把 `app/tool/pane` 編進 URL。`console/src/main.tsx:12` 現在是一句字面的 `pathname === '/app/cli-auth'` 判斷，其餘全靠 18 個 `useState`（`App.tsx:23-52`）。於是：**無法把某個工具的連結傳給同事、重新整理就失去選取、瀏覽器上一頁會直接離開 console**。3-4 天。

14. **建立前端測試 — 工具鏈在隔壁目錄早就有了** — 把 `examples/analysis/vitest.config.js` 與 `"test": "vitest run"` 搬進 console/admin，先從 `codegen.ts`、`validate.ts` 的純函式測試開始，再做 save/dirty 流程的 RTL 測試。`examples/analysis/test/analysis-tool-calls.test.js` 已經證明這套工具鏈在這個 repo 能跑，而 console 連 `test` script 都沒有（`package.json:7-11`）。附帶一提，`Playground.tsx:72` 掛著一行 `eslint-disable-next-line`，**但兩個 app 都沒有安裝 eslint**。2 天建置，之後持續投入。

15. **從 Go 原始碼產生 TS schema 型別，不要手工鏡像** — 由 `backend/internal/toolschema` 產生 `schema.ts`、驗證規則與 `DEFAULT_THOUGHT`，並加 CI 檢查。目前**有三個檔案都寫著「請手動保持同步」的警告**（`console/src/schema.ts:1-4` 與 `:36-37`、`validate.ts:1-6`、`codegen.ts:1-4`），其中 `toTypeScript` 被描述為從 Go「逐行移植」——而沒有任何機制會偵測漂移。4-5 天。

16. **把 landing 改成 SSG 並建立真正的內容模型** — Astro/11ty，一份 layout + 各語系內容檔，讓 docs 也能翻譯。`index.html`（802 行）與 `zh-tw/index.html`（791 行）共用約 300 行完全相同的 CSS；`zh-tw/index.html:403,416` 連到的是**只有英文版的** `/docs/`（988 行，沒有語言切換、沒有中文版）；`public/sitemap.xml` 宣告了 `hreflang` 替代版本，但頁面自己的 `<head>` **從來沒有輸出對應標籤**；而 `vite.config.ts:12-18` 要求每加一個新頁面都得手動註冊 rollup input，否則會靜默 404。1 週。

17. **用 store + 自動儲存 + 復原取代目前的臨時 draft/dirty 狀態** — 把 app/tool 狀態移進 reducer 或小型 store，draft 存 localStorage，破壞性編輯可復原。`App.tsx:54-65` 在登出時手動重設七個狀態，四個呼叫點重複同一段四行重設區塊（`:164-167`、`:185-188`、`:201-204`、`:302-303`），而 `dirty` 是**使用者與資料遺失之間唯一的一道防線**（`:123-128` 的 `beforeunload`）。1 週。

18. **雙向工具編寫：表單 ⇄ 原始 YAML/JSON** — 讓 `PreviewPanel` 可編輯、即時解析，並支援貼上匯入現成的 `tools.yaml`。`PreviewPanel.tsx:13-47` 目前唯讀，所以一個已經有 `tools.yaml` 的開發者（文件在 `landing/docs/index.html:688` 推薦的正是這條 CLI 路徑）**必須把整份重新用 SchemaEditor 打一遍**——而深層巢狀 schema 用文字寫遠比穿過遞迴的 `<fieldset>`（`SchemaEditor.tsx:118-163`）快得多。1 週。

19. **把 Playground 變成真正的工具流程除錯器** — 結構化的 envelope 檢視器（原始 JSON、時間、requestId 關聯、「為什麼這個工具被選中」）、重播、以及每個 app 可儲存的 prompt 測試組。`Playground.tsx:63` 把一次工具呼叫壓成一行 `name(json)`；`:89` 送出的 `requestId` **沒有任何東西會關聯回來**，所以 `setSending(false)` 是被**任意**一則助理訊息觸發的（`:60`）。它還只渲染純文字，而範例那邊早就在渲染 Markdown 了。這是 console 上「我的工具到底能不能動」的主要介面。1-2 週。

20. **導入 workspace 並統一工具鏈** — 根目錄 `package.json` 加 npm workspaces、單一 lockfile、共用 tsconfig base、單一 lint 設定，以及一個會建置所有前端的 CI job。目前**沒有根 `package.json`、有六份各自獨立的 `package-lock.json`**；console/admin 是 React 18 + Vite 6，而 `examples/react-demo` 是 React 19 + Vite 8 + oxlint、`examples/analysis` 是 Vue 3 + Vitest——換句話說，**參考範例根本沒有在驗證 console 實際運行的版本**，而 console 與 admin 的 `build` 裡也沒有任何 lint 或 test 步驟。3-4 天。

---

## 5. 維運、安全、資料與可靠性

### 實用（低風險、一兩天可完成）

1. **🔴 刪除 app 會清空計費帳本 = 免費重置額度** — `usage_events.app_id` 是 `REFERENCES apps(app_id) ON DELETE CASCADE`（`schema.sql:150`），而 `deleteApp` 是使用者自助功能（`console.go:449` → `registry.go:94`）。`usageSince` 又是靠 join `usage_events → apps` 計算（`quota.go:257-263`），所以**「刪掉 app 再重建」就能把當月用量歸零，無限次、免費**。這是本份清單裡唯一真正嚴重的 bug——它讓整個額度子系統形同虛設。修法：把 `owner_id` 反正規化到 `usage_events` 並拿掉 cascade（或改成軟刪除）。半天。

2. **Cloud SQL 完全沒有設定任何備份** — 在 `deploy/`、`docs/deployment.md`、`.github/` 全域搜尋 `backup`/`pg_dump`/PITR 命中數為 0。一張被 drop 的表、或一個 `DELETE FROM apps` 手滑，**都沒有任何復原路徑**，而所有使用者、app、API key 雜湊與用量紀錄都在裡面。1 小時設定 + 半天演練一次還原。

3. **明文 bearer token 無限期停留在 Postgres** — `cliauth.Approve` 把明文 user token 寫進 `cli_auth_sessions.token`（`cliauth.go:82-84`），只有成功 `Exchange` 才會清空（`:110`），而**沒有任何程式碼會刪除 `cli_auth_sessions` 的資料列**。CLI 崩潰或使用者關掉分頁，就會留下一個仍然有效的長期憑證躺在欄位裡，超過 `expires_at` 也不會消失——任何 DB dump、replica 或備份都會一起把活的憑證帶走。`sessions`/`admin_sessions` 同樣只被過濾（`session.go:201`、`adminauth.go:178`）從不清理。2 小時。

4. **`/healthz` 會說謊** — 它無條件回 200，完全不碰資料庫（`main.go:261-264`）。搭配每晚的 Cloud SQL 關機，health endpoint 會在**每一個登入、handshake、額度檢查都 500 的時候**保持綠燈——你唯一的訊號在最可能發生的故障情境下保證無用。改成帶 2 秒逾時的 `conn.PingContext`。30 分鐘。

5. **沒有處理 SIGTERM — Cloud Run 會直接砍掉進行中的工作** — 全檔案沒有任何 `signal.Notify`/`Server.Shutdown`（`main.go:283` 用的是 `http.ListenAndServe`），`main.go:109` 的 `defer conn.Close()` 永遠不會執行。每次部署或縮容都會硬中斷推論中的 WebSocket session，而進行中的 `quota.Record`（`ws/session.go:274`）會直接遺失——**計費工作做了卻沒被記錄**。半天。

6. **`http.Server` 沒有任何逾時設定** — `main.go:283` 用 `ListenAndServe`，所以 `ReadHeaderTimeout`、`ReadTimeout`、`WriteTimeout`、`IdleTimeout` 全是 0。這是無上限的 Slowloris——幾百條半開連線就能無限期佔住 goroutine 與 Cloud Run 執行個體，**完全不需要認證**。這是資安研究者看完 CORS 之後會試的第一件事。1 小時。

7. **資料庫連線池無上限** — `db.Open` 從沒呼叫 `SetMaxOpenConns`/`SetConnMaxLifetime`（`db.go:22-36`），Go 預設是無限開。Cloud Run 水平擴展、預設並發 80，N 個執行個體 × 無上限連線池會直接衝破 Cloud SQL 的 `max_connections`，而**失效模式是全面性的、不是漸進的**。另外沒設 `SetConnMaxLifetime` 也代表池中連線會在每晚重啟後變成死 socket。15 分鐘。

8. **`.dockerignore` 漏掉了兩個真正放機密的目錄** — 它排除了 `backend/logs/` 與 `backend/sessions/`（`.dockerignore:20-22`），但**沒有排除 `backend/tmp/` 與 `backend/configs/`**。實際的對話記錄路徑是 `backend/tmp/logs/`（這台機器上此刻就有 70 個明文對話檔），而 `backend/configs/settings.json` 依 `.gitignore:26-28` 記載是放 provider API key 的地方。`COPY backend/ /src/backend/`（`Dockerfile:61`、`Dockerfile.release:44`）會把兩者都拉進中介 build layer——layer 快取、`--target build`、或 registry 快取匯出都會外洩。最終 distroless 階段是乾淨的，**builder 階段不是**。5 分鐘。

9. **日誌是純文字，Cloud Logging 看不到嚴重性** — `slog.NewTextHandler(os.Stdout, nil)`（`main.go:86`）。Cloud Run 會把 JSON stdout 解析成結構化條目與 severity，純文字則一律變成 `INFO` 等級的字串團。於是每一個 `log.Error`——包括 `recoverMiddleware` 帶堆疊的 panic（`main.go:301`）與額度 fail-open 警告（`ws/handler.go:149`、`ws/session.go:247`）——對任何你日後建立的 log-based 指標或告警都是**隱形的**。30 分鐘，解鎖後續所有告警能力。

10. **CI 沒有任何關卡就直接部署到生產環境** — `deploy-cloudrun.yml:41-74` 是 checkout → build → push → `gcloud run deploy`，沒有 `go vet`、沒有 `go test`、沒有機密掃描。而且僅有的 DB 測試都藏在 `//go:build integration` 後面（`schema_integration_test.go:1`），所以**就算加了 `go test ./...` 也跑不到它們**。應加一個帶 `postgres` service container 的 `test` job 跑 `go vet ./... && go test -tags integration ./...` 加 `gitleaks`，並讓 deploy job `needs: test`。半天。

### 有趣（需要基礎架構決策）

11. **導入版本化的 migration 框架** — 用 goose/atlas 加 Postgres advisory lock，取代每次開機都 `conn.Exec(schemaSQL)`（`db.go:31`）。`schema.sql` 已經帶著五個手寫的冪等補丁（`:82-88`、`:113`、`:139`），沒有順序也沒有回滾，`cmd/migrate/main.go` 又是另一套不相干的機制，而且**每個 Cloud Run 執行個體都在開機時搶著跑 DDL**。今天要改欄位名稱或型別沒有任何安全路徑。2-3 天。

12. **基礎架構即程式碼** — 用 Terraform 管理專案。`PROJECT_ID="onagent-prod"` 硬寫在三個地方（`deploy/setup.sh:27`、`set-ai-provider-secrets.sh:18`、`deploy-cloudrun.yml:16,19`），改一次專案 ID 要同步改多處；資料庫規格、Cloud Run 設定、IAM 綁定目前也都只存在於一次性執行過的 `gcloud` 指令裡，沒有任何地方可以「看出目前基礎架構長什麼樣」。1 週。

13. **真正的可觀測性：指標與追蹤** — OTel exporter 接 Cloud Monitoring，量測推論延遲、orchestrator 持鎖時間、每個 app 的 WS 連線數，特別是為兩個額度 fail-open 分支各加一個計數器（`ws/handler.go:149`、`ws/session.go:247`）。那兩個分支在任何 DB 抖動期間都會**免費送出無限推論**，而目前只會吐一行無法解析的文字日誌——你會從 LLM 帳單上才知道這件事。1 週。

14. **告警與錯誤追蹤** — 對一個真的會檢查 DB 的 `/healthz` 做 uptime check、對 5xx 率與 Cloud SQL `up` 設告警政策、把 Sentry（或 Error Reporting）接進 `recoverMiddleware`（`main.go:297-307`）。目前沒有任何東西在戳 `/healthz`，`docs/deployment.md:133` 把它當成部署後人工目視的項目。2-3 天。

15. **staging 環境加上正式環境的核准關卡** — 第二套 Cloud Run service + 資料庫；讓 `deploy-cloudrun.yml` 在打 tag 時部署 staging，正式環境則需要 GitHub Environment 核准。今天一個 `v*` tag 會直接上 `onagent.shuttle.tools`（`deploy-cloudrun.yml:5-6`），而同一個 tag 也會觸發 `release-onagent.yml`——**一個打錯的 tag 會同時把兩種產物送到真實使用者手上**。3-4 天。

16. **不可變、可回滾的部署** — 用 image digest 部署（而非 `:latest`，`deploy-cloudrun.yml:53,67`）、把 `--update-env-vars`/`--update-secrets` 換成 `--set-*` 並釘住 secret 版本（而非 `:latest`，`:72-73`）、加上 `--max-instances`、先 `--no-traffic` 部署再用腳本化的 `update-traffic` 切換與回滾。今天你**無法重現正在運行的是什麼**（merge 語意會靜默保留已移除的變數；一個壞掉的 Secret Manager 版本會立刻擴散到每個新執行個體），而回滾是沒有文件記載的 console 點擊。3-4 天。

17. **特權操作的稽核日誌表** — 一張 append-only 的 `audit_events(actor_type, actor_id, action, target, ip, at)`，由 `console.go`/`adminconsole.go` 的每個變更操作寫入。今天管理員可以更改任何使用者的方案（`adminconsole.go:41`）、開發者可以發/撤 key 與刪除 app（`console.go:91-93`），**全部零痕跡**。當第一個客戶問「是誰重置了我們的額度」時，沒有答案——而這也是任何 SOC2 對話的基本門檻。1 週。

18. **資料保存政策與 GDPR 刪除/匯出工具** — 一條帳號刪除路徑、一份資料匯出、以及 want 對話記錄的保存政策。在測試以外全域搜尋 `DELETE FROM users` 命中數為 0——**使用者沒有任何辦法刪除自己的帳號**，而 `backend/tmp/logs/` 會在每台主機上無上限累積明文 prompt 與 system prompt。schema 的 `ON DELETE CASCADE` 鏈讓刪除在機制上很容易，缺的是政策、那些記錄檔、以及真的去執行它。1-2 週。

19. **機密管理翻修與書面輪替流程** — `GH_PAT` 改用 GitHub App installation token；`ADMIN_BOOTSTRAP_EMAIL`/`PASSWORD`（`main.go:187`）放進 Secret Manager 而不是某個手動設定的明文環境變數——它們在 `deploy-cloudrun.yml:72-73` 完全沒出現，代表**要嘛沒設定、要嘛不知不覺留在 revision 上**，任何有 `run.services.get` 權限的人都讀得到。`GH_PAT` 目前有兩份獨立副本（`deploy/setup.sh:90` 與 GitHub Actions secret），**沒有到期日、沒有負責人、沒有任何輪替程序記載**。1 週。

20. **在資料庫層做租戶隔離** — 以 `apps.owner_id` 為鍵的 Postgres RLS 政策，應用程式以非 owner 角色連線並逐請求設定 `app.current_user_id`。今天的隔離**完全是一個 Go 程式碼層的約定**——`withOwnedApp`（`console.go:163`）是租戶之間唯一的那道牆，而 `ws.Handler` 刻意完全不檢查所有權。未來某個 handler 少包一層 wrapper，就是一次跨租戶資料外洩。這是已知 `want` 全域 registry 洩漏問題在資料層的對應物。2 週。

---

*建立於 2026-07-24。與 `docs/project-audit.md`（2026-07-15 稽核）、
`docs/project-health-review-2026-07-22.md`（跨面向健檢）互補：那兩份是「找出現存問題」，
這份是「該往哪些方向改良」，包含尚不存在的功能與方向性提案。*
