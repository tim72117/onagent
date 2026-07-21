# onagent 專案稽核報告

> 產出日期：2026-07-15。方法：三個 Sonnet subagent 分別深度閱讀後端、安全、前端/SDK/部署，加上本次開發過程已確認的架構問題，交叉驗證後綜合。關鍵發現（跨租戶洩漏、settings.json）已用主線程親自複核程式碼。
>
> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low

---

## 一、安全問題（最優先）

### 🔴 S1. 跨租戶工具宣告洩漏 — want 全域 registry 的 first-match 查詢
- **位置**：`want/internal/toolbox.go:77-82`（`GetTools`）+ `want/types/registry.go:29-32`（`RegisterTool` append-only）+ `backend/internal/inference/agent_roles.go:107-112`（註解宣稱「不可能跨 app 洩漏」——**這個宣稱是錯的**）
- **親自複核確認**：`GetTools` 對每個白名單名稱，掃描**全域**（跨所有 app 共用）的 `Declarations` slice，取**第一個**名稱相符的就 `break`。`RegisterTool` 只 append、從不去重，registry 是 process 全域單例。
- **攻擊情境**：A 開發者註冊名叫 `search` 的工具，description 含業務邏輯（例如「以身分證末四碼查詢客戶記錄」）。B 開發者（任何其他租戶）之後也建一個叫 `search` 的工具。`GetTools` 會把 **A 的 `search` 宣告**（description + parameter schema）回傳進 **B 的 LLM context**，因為 A 先註冊、是第一個相符。惡意租戶可藉「工具名稱搶註」蓄意遮蔽/竊取其他租戶的工具定義。
- **這不只是 UX bug**：`docs/known-issues-want-dependency.md` 與 `docs/TODO-want-registry-append-only.md` 目前只把它記為「編輯 schema 不生效」的功能缺陷，但它同時是**租戶隔離破口**。
- **修法**：在全域 registry 對工具名稱加 appId 命名空間（例如註冊成 `"{appID}::{toolName}"`，白名單/呼叫時翻譯），或修 `want` 讓 `Declarations` 以名稱為 key、last-write-wins，且 `GetTools` 只查該 app 自己註冊的集合。**必須改 `want` 本身**。

### 🟠 S2. 無任何 rate limit ＋ 單一序列化 orchestrator = 一把 key 就能癱瘓全平台
- **位置**：全 `backend/` 無 rate-limit middleware；`backend/internal/inference/want.go:91-93`（全域 mutex 握滿整個 `Complete()`）；`backend/internal/ws/session.go:289`（query tool 的 20s `interactionTimeout` 嵌在同一個 mutex 內）
- **攻擊情境**：一個免費帳號建一個 app、定義一個 `ToolKindQuery` 工具、開 WebSocket、送出觸發該工具的 prompt，然後**永遠不回答** `tool_query`。每一次這樣的呼叫佔用**唯一**的 orchestrator 長達 20 秒才逾時；攻擊者可開**無上限**的並發 WS 連線（`ws/handler.go`/`session.go` 無連線數上限）各自迴圈這樣做，把全平台每個租戶的推論吞吐量壓到零、無限期。
- **修法**：per-app 或 pooled orchestrator（見架構章節 A1）；過渡期至少加 per-appId/IP 的並發與速率限制、限制每 key/app 的同時 WS 連線數。

### 🟠 S3. 完全沒有設定任何安全 header
- **位置**：全 `backend/` 無 `Strict-Transport-Security`／`X-Frame-Options`／`X-Content-Type-Options`／`Content-Security-Policy`
- **影響**：session-cookie 認證的 console SPA 可被 clickjacking（無 `X-Frame-Options`/`frame-ancestors`）；無 HSTS 留下 HTTP 降級窗口（即使 `COOKIE_SECURE=true`，除非 LB 另外補）；無 CSP，缺少對未來 XSS 的縱深防禦。
- **修法**：在 `main.go` 的 `withCORS` 或新 middleware 包住 `mux` 統一加上。成本低、CP 值高。

### 🟠 S4. API key 以 WS URL query 參數傳輸 — 實際的日誌/歷史外洩
- **位置**：`backend/internal/ws/handler.go:92`（`r.URL.Query().Get("token")`）＋ `packages/bridge/src/client.ts:105`
- **影響**：這是刻意的取捨（瀏覽器無法對 WS upgrade 設 header），但「只用 wss://」只保護傳輸線路，**不保護** Cloud Run/LB 的 access log（多數預設會記完整 URL）、瀏覽器歷史、Referer 外洩。任何記錄完整 request URL 的存取日誌都會**持久儲存明文 API key**。SDK 也未在 runtime 強制 `wss://`。
- **修法**：在 Cloud Run/LB 存取日誌層 redact `token` query 參數；SDK constructor 加 runtime 檢查，`apiKey` 有值但 `url` 非 `wss://`（localhost 例外）時大聲警告；長期考慮改用短效、單次 WS ticket（HTTPS 認證後換發、WS 一次兌換）取代長效 key。

### 🟡 S5. `deleteApp` 不清除 want 全域 registry，且 appId 可被不同擁有者重用
- **位置**：`backend/internal/console/console.go:384-395`（只 `Apps.Delete` + `Auth.Revoke`，不 unregister want role/工具宣告）；`registry.go:110-123`（`Create` 只檢查當前 registry，不擋已刪除的 appId 重建）
- **影響**：搭配 S1，被刪除 app 的工具宣告永遠留在全域 `Declarations`，可被同名工具「搶贏」或被之後重建同一 appId 的**不同擁有者**復用。
- **修法**：記錄已刪除 appId 並擋重建；或做命名空間（併入 S1 修法）讓 stale entry 無法在新擁有者下復活。

### 🟡 S6. `createApp` 無每使用者數量上限
- **位置**：`backend/internal/console/console.go:283-296`
- **影響**：任何登入使用者可迴圈 `POST /console/apps` 無限建 app，每個都消耗一個全域 want role 註冊，放大 S1 的 registry 污染與 S2 的 orchestrator 競爭。
- **修法**：server 端限制每使用者 app 數量。

### 已複核為「安全」的項目（無需處理）
- **SQL injection：無**。`session`/`auth`/`usertoken`/`cliauth`/`toolschema/registry` 全部用 `$N` 參數化，無字串拼接。
- **CSRF：足夠**。靠 `SameSite` + 嚴格 CORS（`main.go` 只對 `ALLOWED_ORIGINS` 內的 origin 回 credentialed CORS），state-changing 端點都是 JSON POST/PUT/DELETE，需 preflight，非白名單 origin 過不了。前提是 production 的 `ALLOWED_ORIGINS` 維持收緊（已有 fail-fast）。
- **Bearer token 不能自我增生**：`issueToken`/`approveCliAuth` 正確限定 `withCookieAuth`（`console.go:91-103`），有註解說明就是防這個。
- **CLI device flow（`internal/cliauth`）**：單次使用、redirect_uri 僅 loopback 且 server 端解析、10 分鐘 TTL、32-byte 隨機 id。無問題。
- **`sanitizeSessionID`（`want.go:210-220`）**：`^[a-zA-Z0-9_-]{1,128}$`，無 path traversal。
- **codegen public 端點**：只吐 LLM schema 形狀（無 Returns/thought/owner），appId-scoped，可接受。
- **bcrypt cost = DefaultCost(10)**：可接受，可考慮調高（低優先）。

---

## 二、優先優化項目（依 CP 值排序）

1. **🔴 S3 安全 header** — 一個 middleware 搞定，成本最低、直接消除 clickjacking/HSTS 缺口。
2. **🔴 A2 Playground 死結（見下）** — 剛在 `ws/session.go` 修好的死結，`playground.go` 有一份未修的複製。範圍小、性質已知。
3. **🟠 S2 / A1 orchestrator 序列化＋無 rate limit** — 平台級瓶頸與 DoS 面，最重要但工程量最大，過渡期先加 rate limit。
4. **🟠 F5 ADDR/PORT** — 部署正確性，改動小。
5. **🟠 F1/F2 SDK 重連斷路器** — 第三方直接依賴，影響外部開發者體驗。

---

## 三、程式架構優化

### 🟠 A1. 單一共用 orchestrator 序列化全平台吞吐（最大架構限制）
- **位置**：`backend/internal/inference/want.go:68-93`——一個 `*orchestrator.Orchestrator`、一把 mutex 握滿整個 `Complete()`（含 LLM 呼叫，最長 90s）。`orch.AgentID`/`orch.Role` 是無同步保護的 struct 欄位，`WantService` 那把 mutex 是唯一讓「換欄位→Submit」安全的機制。
- **本質**：對話**內容**有隔離（每 session 各自 AgentID/transcript），但**吞吐量**完全序列化——全平台任何時刻只有一個使用者的一輪推論在跑。
- **修法方向**：改成每 app（或 pool）獨立 orchestrator 實例。關鍵前提（本 session 已查證）：`InitializeWithConfig` 建立的 `GlobalEngine`/`RequestQueue` 是 process 全域單例，且 `want` 的 provider `RequestQueue` 寫死 `maxConcurrent=1`——所以就算拆多個 orchestrator，實際打 LLM 的 HTTP 請求還是會卡在這個全域限流的 1。要真正並行，`NewRequestQueue(1, ...)` 的 `1` 也得一起調（取決於後端 LLM 服務能承受的並發）。**這是改 `want` 才能根治的。**

### 🔴 A2. Playground 有一份未修的死結複製，且從不註冊 asker
- **位置**：`backend/internal/console/playground.go:169-210`——prompt 迴圈**同步**呼叫 `h.Inference.Complete`，在同一個呼叫 `conn.ReadMessage()` 的迴圈裡，**沒有** goroutine 分派（對照剛修好的 `session.go:153` 的 `go s.handlePrompt(...)`）。且 Playground 從不呼叫 `inference.RegisterAsker`，其 wire protocol 也無 `tool_result` 訊息類型。
- **影響**：現在從 Playground 測 `ToolKindQuery` 工具，`askPage` 會 fast-fail「no connected page」，但這個失敗仍得經過同一把全域 orchestrator mutex 傳回；更糟的是，任何之後想在 Playground 接上真正 `AskInteraction` 路徑的人，會**重新引入**原本已修掉的單 goroutine 死結。
- **修法**：Playground 的 prompt 也比照 `session.go:153` 分派到獨立 goroutine，避免它變成一個已修 bug 的第二份複製。

### 🟠 A3. `ws.Session.run()` 的 `ctx.Done()` 無法中斷進行中的阻塞讀取
- **位置**：`session.go:84-91`——`select { case <-ctx.Done(): return; default: }` 只在兩次 `ReadMessage()` 之間檢查；`ReadMessage()` 本身不綁 `ctx`，只有獨立的 `pongTimeout`(60s，每收到 pong 就重置)。
- **影響**：request context 被取消時（server shutdown），idle-but-connected 的連線要等下一次 `ReadMessage()` 自然返回才退出（最長 60s，或客戶端持續 pong 就永遠不退），graceful shutdown 非確定性；且 `defer inference.UnregisterAsker(s.id)`（防 stale asker 卡住未來 query tool）被同樣延遲。
- **修法**：shutdown 時明確 `conn.Close()` 以 error 中斷 `ReadMessage`，或確認 hijacked 連線的 per-request context 語意後不依賴它。

### 🟡 A4. `askers` 是靠呼叫端紀律的 package 全域狀態
- **位置**：`interaction.go:27-30`（`askers` 有 RWMutex，但 process 全域 key、無 TTL）
- **影響**：`askers` 若 process 中途重啟留下 stale entry。（原本一併記載的 `callSink` data-race 風險已隨該機制移除而解除——action-kind 工具現在直接透過 `askPage` 同步回報，不再有 package 全域 sink。）
- **修法**：至少加註解記錄假設；長期把這狀態綁定到 orchestrator 實例而非 package 全域。

### 🟡 A5. `RegisterAppRole` 是跨套件手動維護的 invariant
- **位置**：`console.go` 的 `syncWantRole` 在三個 mutation 點呼叫 `RegisterAppRole`——型別系統不強制，第四條忘記呼叫的 mutation 路徑會重現同類 bug。
- **架構評語**：套件邊界與依賴方向大致乾淨（`toolschema` 無上行依賴，`inference` 依賴 `toolschema`，`ws`/`console` 是 `inference.Service` 的唯一消費者），want 耦合在**介面層**隔離良好（`inference.Service`/`MockService` 可換）——但透過 (a) package 全域狀態 (A4)、(b) 這個手動 invariant，兩處滲漏出來。

### 🟡 A6. `listApps` 的 N+1 查詢
- **位置**：`console.go:246-268`——`OwnedBy` 一次查詢後，迴圈裡每個 app 各呼叫 `HasKey`+`OriginFor`（各一次 `db.QueryRow`）。N 個 app = `1+2N` 次查詢。
- **修法**：批次查詢（`WHERE app_id = ANY($1)`），或把 `api_key_hash IS NOT NULL`/`allowed_origin` 直接併進 `OwnedBy` 的 SELECT。

### 🟡 A7. `codegen.ToLLMTools`/`Request.Tools` 在真實推論路徑是死碼
- **位置**：`WantService.Complete`（`want.go`）從不讀 `req.Tools`（工具來源全靠預註冊的 want role）；唯一讀者是 `mock.go:22`。但兩個真實呼叫點（`session.go:235`、`playground.go:193`）每次 prompt 仍計算 `codegen.ToLLMTools(app)` 傳進去——熱路徑上的浪費，也誤導讀者以為 `Tools` 對 want 有作用。
- **修法**：要嘛讓 `Complete` 真的用 `req.Tools` 對已註冊 role 做一致性檢查（能在**程式碼**層抓到 S1 這類 bug，而非只靠文件），要嘛從兩個真實呼叫點移除、保留 mock-only。

---

## 四、需要調整的功能設計 / 品質問題

### 🟠 F1. SDK 無限重連無斷路器/終端狀態
- **位置**：`packages/bridge/src/client.ts:132-145`——`scheduleReconnect` 永遠重試（backoff 封頂 10s），無法區分暫時性斷線 vs 致命狀況（key 錯/被撤銷/app 被刪/appId 錯）。stale 分頁會每 10s 無限敲後端（本 session 實際觀察到）。無回呼告訴嵌入方「這連線已永久死掉」。
- **修法**：加 max-attempt/max-elapsed 上限＋獨立終端狀態，透過新回呼（如 `onDisconnected(permanent)`）曝露；分頁 hidden 時暫停/減速重連。

### 🟠 F2. SDK 吞掉 WS close/error code，auth 失敗看起來跟斷線一樣
- **位置**：`client.ts:132-141`——close handler 完全忽略 `event.code`/`reason`，error 是純 no-op。撤銷 key 產生的 auth 拒絕 close 與暫時性斷線無法區分，兩者都無限重試、零信號。
- **修法**：檢查 `ev.code`，把 4xxx auth 類 code 當終端、停止重試（需先確認 `internal/ws` 實際用什麼 code 關閉）。

### 🟠 F5. ADDR-vs-PORT — 確認的 Cloud Run 風險，且文件把它講反了
- **位置**：`backend/cmd/server/main.go:218`——`addr := envOr("ADDR", ":8080")`；全 `backend/` **從不讀 `PORT`**。Cloud Run 一律注入 `PORT` 並期望容器聽它；`ADDR` 是 Cloud Run 不認識的自訂變數。現在能動只因 fallback `:8080` 剛好等於 Cloud Run 目前預設 `PORT=8080`。`docs/deployment.md` 把這講成「刻意相容」而非巧合——一旦 service 改設非預設 port，容器會靜默綁錯 port、deploy 失敗且無明確錯誤指向此行。
- **修法**：改成 `":" + envOr("PORT", "8080")`（`ADDR` 保留為非 Cloud Run 用的完整位址覆寫），並修正文件說法。

### 🟡 F3. SDK queue 無上限成長（配合 F1 的記憶體洩漏）
- **位置**：`client.ts:80`——`queue` 無 size cap，配合無限重連，對永久死掉的後端頁面會累積每一次 `prompt()` 呼叫。
- **修法**：限制 queue 長度（丟最舊，比照 gtag），或曝露 `queue.length`。

### 🟡 F4. SDK `ToolHandler` 是 `any` 型別，違背「型別安全」訴求
- **位置**：`client.ts:14`——`ToolHandler = (args: any) => ...`。handler 的 `args` 與工具宣告的 JSON schema 無泛型連結；console 的 `codegen.ts` 產生的 `ToolHandlers` interface 也沒有自動接進 `AgentBridgeOptions.tools` 的機制。
- **修法**：讓 `AgentBridgeOptions` 對 `ToolHandlers` 形狀泛型化，把 console 已產生的 interface 接上，讓 `tools:` 有真正編譯期檢查。

### 🟡 F6. `tool_query`/`tool_call` 的阻塞語意只在程式碼註解、不在公開 API doc surface
- **位置**：`client.ts:168-178` 有內部註解說明兩者現在都會阻塞後端 LLM 推論（只差結果資料會不會轉給 LLM）——**這段註解本身在本次稽核中發現曾經寫錯**（舊版說 `tool_call` 是 fire-and-forget，已於本次一併修正為正確描述），可見這類語意只活在程式碼註解裡、沒有可驗證的公開 doc surface 有多容易跟實際行為脫鉤。公開的 `ToolHandler`/`AgentBridgeOptions` JSDoc（第三方在編輯器裡實際看到的）仍完全沒提到 handler 會阻塞 LLM 推論直到 resolve。開發者可能不知情地寫慢/網路綁定的 handler，靜默拖慢每個 prompt。
- **修法**：在公開 `tools` 欄位的 doc comment 說明；handler 超過 N 秒才 resolve 時 runtime 警告。

### ⚪ 低優先（已確認，多為 cosmetic）
- **後端零測試覆蓋**：`backend/` 無任何 `*_test.go`。最高風險未測路徑：ws.Session 的 mutex 狀態機（`handlePrompt`/`handleToolResult`/`AskInteraction` 競爭 `pendingCalls`/`app`）、`sanitizeSessionID`/`AgentIDToSessionID` 的 `"WS-"` prefix round-trip（單邊改就默默壞掉所有 query tool）、`saveApp` 的 delete-then-insert transaction、`withOwnedApp` 的 404-not-403 隔離 invariant。
- **console 無 `kind: query` UI**（`schema.ts:17-22` 的 TS `Tool` interface 根本沒有 `kind`）：只能手改 YAML 才能建 query 工具；需確認 `saveTools` 的 payload 會不會把 `kind` drop 掉。
- **`codegen.ts:143-153` 巢狀 object 屬性 description 在 TS 預覽被丟棄**（`tsType` 的 `case 'object'` vs `writeInterface`）：僅預覽準確度，不影響 runtime。
- **`db.Open` 每次開機重跑 `schema.sql`、無 migration 版本控制**：additive 時 OK，但與 `cmd/migrate` 兩套 schema 變更機制並存，未來破壞性變更（改欄位型別/rename）易 drift。
- **`main.go` 的 `wsAuth := authStore` 永遠非 nil**：`ws/handler.go` 的 `Auth == nil` dev-mode 分支實質不可達，是誤導性的死防禦碼。
- **`cloudbuild.yaml` 不存在**（並非「死碼待清」，是從未存在）：唯一部署路徑是 GH Actions workflow，文件也只寫這條。原本以為它存在是 stale 認知。

---

## 五、建議新增功能

1. **可觀測性**：目前只有 log、無 metrics。至少加：每次 query-tool 呼叫的「lock-held-for-interaction 時長」、inference 排隊等待時長、per-app 呼叫量——在結構性修 A1/S2 之前先讓風險**可量測**。
2. **Rate limiting / quota**：per-app、per-user、per-IP 的速率與並發限制，含每 key 同時 WS 連線上限（直接對應 S2/S6）。
3. **短效 WS ticket**：取代長效 API key 直接進 URL（對應 S4）——HTTPS 認證後換發單次 ticket、WS 一次兌換。
4. **console 的 `kind: query` 編輯 UI**：讓 query 工具能在網頁管理，不必手改 YAML（對應 F 低優先項）。
5. **`onagent get-tools <appId>` CLI 指令**：目前 CLI 只能推、不能拉，確認「實際存了什麼」只能查 DB 或開 console。後端已有 `GET /console/apps/{appId}` API，CLI 加一個指令即可。
6. **串流回覆**：目前 `Complete()` 是一次性回傳，前端等整輪推論結束。串流可大幅改善體感延遲（但要注意跟 A1 序列化的互動）。
7. **部署設定 fail-fast 擴充**：`AI_PROVIDER=googleapis` 但 `GOOGLE_API_KEY` 未設時、production 缺關鍵 secret 時，啟動即拒絕（延續現有 `APP_ENV=production` 機制）。

---

## 附註：本次分析修正的兩個先前認知
- want append-only bug 的實際影響**比原記載窄**：工具**白名單 + Thought** 的編輯**會**立即生效（走 `agentreg.Register` 的 map 寫入），只有工具**parameter schema** 的編輯不生效（走 append-only 的 `Declarations`）。
- 記錄此 bug 的文件是 `docs/known-issues-want-dependency.md`；本 session 另建了 `docs/TODO-want-registry-append-only.md`，兩份並存。
