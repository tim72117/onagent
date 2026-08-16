# onagent 功能/架構稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。安全性發現另外記在 `docs/audit-security.md`，本檔案只收邏輯錯誤、狀態管理問題、架構債、效能、程式碼品質等非安全性發現。

---

## 最新掃描：2026-08-16

> 方法：14-agent workflow（4 路並行 scan：console/quota 業務邏輯、WS/inference 流程、console+admin 前端、bridge SDK/codegen → extract → 對抗式 verify）。只列出通過對抗式驗證（confidence ≥ 7/10）的項目。

### 🟠 高風險：completeTimeout 分支未呼叫 `orch.Interrupt()`，殘留的 RunAgent goroutine 會污染下一輪對話（confidence 9/10）
- **位置**：`backend/internal/inference/want.go:268-275`（`WantService.Complete` 的 `select`）
- **問題**：`select` 有兩個逾時類退出分支：`ctx.Done()` 會呼叫 `orch.Interrupt()` 才 return；但 `time.After(completeTimeout)`（90 秒）分支沒有呼叫。因為同一個 session 的 `*orchestrator.Orchestrator` 是長駐、跨多輪 prompt 共用的，且 `want` 的 `activationQueue` 不會等前一個 `RunAgent` goroutine 結束才 dispatch 下一個 `Submit`，一次「慢但沒真的卡死」的 LLM 呼叫（超過 90 秒但小於供應商自己的逾時）會讓 `RunAgent` goroutine 在背景繼續跑，即使前端已經被告知這次 prompt 失敗。
- **後果**：這個殘留 goroutine 會繼續往 orchestrator 共用的 `agent.inference` event bus topic 發布事件，該 topic 沒有 per-Submit/per-turn 的關聯 id（只有固定的 `AgentID`）。如果使用者在同一個 session 立刻送出下一個 prompt，新的訂閱者會收到舊那輪殘留的事件混在自己的回應裡——文字可能串錯輪、殘留的 idle 狀態可能讓新的呼叫提前被判定完成、殘留的 tool call 甚至可能觸發不該出現的 `tool_call`/`tool_query` 送到瀏覽器端。
- **修法**：`completeTimeout` 分支也呼叫 `orch.Interrupt()`（比照 `ctx.Done()` 分支），或把兩個逾時類分支重構成共用同一段 cleanup 路徑。`Interrupt()` 會取消該 orchestrator 追蹤的所有 agentID，這與 `ctx.Done()` 分支現有的防護網一致。

### 🟠 高風險：取消「捨棄變更」確認對話框後，畫面仍然切換到新的工具/agent/playground，未儲存的編輯會被靜默覆蓋（confidence 9/10）
- **位置**：`apps/console/src/App.tsx:341-372`（`refreshDraftForSwitch` 及其呼叫者 `selectTool`/`selectAgent`/`selectPlayground`）
- **問題**：`refreshDraftForSwitch()` 在使用者點擊「取消」（`confirmDiscard()` 回傳 `false`）時正確地提早 return、不動 `draft`/`dirty`。但呼叫它的 `selectTool`、`selectAgent`、`selectPlayground` 三個函式在 `await` 之後**不論回傳值為何都會**繼續呼叫 `setActiveToolIndex`/`setAgentSelected`/`setPlaygroundSelected` 切換畫面。對照之下，同檔案裡的 `selectApp`（186-198 行）有正確地做 `if (!confirmDiscard()) return`。
- **repro**：編輯工具 A 的描述使 `dirty=true` → 點側欄的工具 B → 跳出捨棄變更確認框 → 點「取消」，意圖繼續編輯 A → 畫面卻切到 B，但 `draft.tools` 裡仍靜默保留對 A 的未儲存修改，此時若在 B 的畫面點 Save，會把使用者從未在編輯器裡再次看到的 A 的隱藏修改一併存檔。
- **修法**：讓 `refreshDraftForSwitch` 回傳布林值（安全/已確認可繼續為 `true`，使用者取消為 `false`），三個呼叫者依這個回傳值決定要不要真的切換畫面，比照 `selectApp` 已有的 `if (!confirmDiscard()) return` 寫法。

### 🟡 中風險：`quotaResponse.Used` 為 0 時因 `omitempty` 被 JSON 省略，console 側欄配額顯示異常（confidence 9/10）
- **位置**：`backend/internal/console/console.go:261`（欄位定義）、`:283-296`（`getQuota` handler）
- **問題**：`Used int` 欄位標了 `json:"used,omitempty"`，Go 的 `encoding/json` 會把值為零值（0）的 int 欄位整個省略，而不是輸出 `"used":0`。前端型別（`apps/console/src/api.ts:50`）把 `used` 當成可選欄位，`Sidebar.tsx:154` 直接 render `quota.used`，導致新帳號或每月額度剛重置的使用者，側欄配額顯示變成空白/異常，而不是正確的「0 / 100」。對照 admin 後台平行使用的 `quota.UserSummary.Used`（`admin.go:65`）並沒有加 `omitempty`，可確認這是疏忽而非刻意設計。
- **修法**：把 `console.go` 這個欄位的 `omitempty` 拿掉，跟 `quota.UserSummary.Used` 保持一致。可以順便在 `Sidebar.tsx:154` 加 `quota.used ?? 0` 防禦性寫法，並在後端修好後把 `api.ts` 的 `Quota.used` 型別收緊成非 optional。

### 🟡 中風險：`pascalCase` 命名碰撞會產生重複的 TypeScript interface（confidence 9/10）
- **位置**：`backend/internal/codegen/typescript.go:37`（`pascalCase`）
- **問題**：`pascalCase(name)` 沒有碰撞偵測，`get_user` 和 `getUser` 這種不同的工具名稱都會轉成同一個 `GetUser`。`TypeScript()` 因此會產生兩個衝突的 `GetUserArgs`/`GetUserResult` interface 宣告。唯一的重複檢查（`App.Validate()`，`toolschema/loader.go`）只比對字串完全相等，`get_user` 和 `getUser` 是不同字串，兩者都會通過驗證並存進資料庫。
- **repro**：在同一個 app 註冊 `get_user` 和 `getUser` 兩個工具，`GET /apps/{appId}/tools.ts` 會產生兩個衝突的 `GetUserArgs` 宣告，對任何使用該生成檔案的消費端都是 TypeScript 編譯錯誤。
- **修法**：在 `App.Validate()`（或 codegen 前）加一個以 pascalCase 形式追蹤的 seen-set，兩個不同工具名稱轉成相同 PascalCase 識別字時回傳明確錯誤，讓這個不變量在資料存進 DB 之前的同一個驗證關卡就被擋下。

### 🟡 中風險：`Validate()` 沒有強制頂層 `Parameters`/`Returns` 的 `type` 必須是 `object`，會讓整個 app 的 TypeScript codegen 端點壞掉（confidence 9/10）
- **位置**：`backend/internal/toolschema/loader.go:100`（`Validate()`）
- **問題**：`Validate()` 只檢查 `Parameters.Type`/`Returns.Type` 非空字串，從未檢查它是否等於 `"object"`。但 `codegen/typescript.go` 的 `writeInterface`（69 行）在頂層硬性要求必須是 `"object"`，否則回傳錯誤。一個 `returns: {type: array}` 這種寫法的工具可以通過驗證、透過 console API 的 `saveTools` 存進資料庫，之後任何呼叫該 app 的 TypeScript codegen 端點都會失敗——而且是整個 app 的所有工具都拿不到，不只是那一個壞掉的工具。
- **repro**：透過 console API 存一個 `returns.type = "array"` 的工具，`Validate()` 照樣通過並存檔；之後該 app 的 TypeScript codegen 端點對所有工具都會失敗/回錯。
- **修法**：在 `Validate()`（`loader.go`）明確要求 `t.Parameters.Type == "object"`，若 `t.Returns != nil` 也要求 `t.Returns.Type == "object"`，跟 `writeInterface` 實際的要求對齊。回傳明確指出是哪個工具的錯誤，讓 console UI 能在儲存當下就擋下，而不是延後到 codegen 才 500。

### 🟡 中風險：`tsType()` 對 null 的屬性 schema 沒有 nil 檢查，會讓 TypeScript codegen 端點 panic（confidence 9/10）
- **位置**：`backend/internal/codegen/typescript.go:86, 91`（`tsType()`）
- **問題**：`tsType()` 對 `*ParameterSchema` map 值直接解參考，沒有 nil 檢查。客戶端可以對工具儲存端點 POST `"properties": {"bad": null}`，Go 的 JSON decoder 會把這個存成 nil pointer，`Validate()` 抓不到，於是存進資料庫。之後任何呼叫該 app 的 TypeScript codegen 端點都會因為 nil-pointer dereference 而 panic（被 middleware 的 recover 接住變成 500，但該端點對這個 app 已經完全壞掉）。
- **repro**：POST 一個含 `properties: {"bad": null}` 的工具到儲存端點，成功存檔；之後對該 app 呼叫 TypeScript codegen 端點會 panic 並回 500。
- **修法**：在 `writeInterface` 對 `prop == nil` 做檢查（回傳清楚的錯誤而不是 crash），`tsType` 的 array/object 分支同樣要對 `s.Items`、`s.Properties[name]` 做保護。更根本的做法是讓 `App.Validate()` 遞迴驗證整棵 `ParameterSchema` 樹（含巢狀 `Properties`/`Items`），在資料進資料庫之前就擋掉 nil 項目——這也同時保護 `ToLLMTools`/`llmschema.go` 等其他消費者。

---

## 優先優化項目（依 CP 值排序，2026-07-15 原稽核排序，含跨檔案的安全項目）

> 這份排序橫跨本檔案（功能/架構）與 `docs/audit-security.md`（安全）兩份報告，故單獨列在此處，不併入下方任何單一項目。安全項目（S 開頭）的現況以 `docs/audit-security.md` 為準。

1. **🔴 S3 安全 header**（見 `docs/audit-security.md`）— 一個 middleware 搞定，成本最低、直接消除 clickjacking/HSTS 缺口。
2. **🟠 A2 Playground 同步阻塞**（見下）— `ws/session.go` 已改用 goroutine 分派，`playground.go` 尚未跟進，架構不一致。範圍小、性質已知。
3. **🟠 S2 / A1 orchestrator 序列化＋無 rate limit**（S2 見 `docs/audit-security.md`，A1 見下）— 平台級瓶頸與 DoS 面，最重要但工程量最大，過渡期先加 rate limit。
4. **🟠 F5 ADDR/PORT**（見下）— 部署正確性，改動小。
5. **🟠 F1/F2 SDK 重連斷路器**（見下）— 第三方直接依賴，影響外部開發者體驗。

---

## 進行中的發現（依嚴重度排序）

### 🟠 CLI `save-tools` 拒絕文件說可省略的 `appId`（原 improvement-backlog 2026-07-24，併入於 2026-08-16）
- **位置**：`backend/cmd/onagent/main.go:431-467`（`runSaveTools`）＋ `backend/internal/toolschema/loader.go:18-84`（`ValidAppID`/`Validate`）
- **問題**：`runSaveTools` 把 YAML 檔解析成 `toolschema.App` 後直接呼叫 `app.Validate()`（451 行），但從沒有把 CLI 參數傳入的 `appID`（436 行）填進 `app.AppID`。`Validate()`（`loader.go:84`）要求 `ValidAppID(a.AppID)`，而 `appIDRE`（`loader.go:18`）是 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`，不接受空字串。所以一份文件說「appId 可省略」的 `tools.yaml`（appId 由 command-line 參數指定），會在本機 `Validate()` 直接失敗，回報 `invalid appId ""`，完全還沒送到後端。
- **注意**：console 前端的 `PUT /console/apps/{appId}/tools` 路徑不受影響——它是從 URL path 拿 `appId`，request body 只需要 `[]toolschema.Tool`，這條路徑已確認正常。只有 CLI 的 `save-tools` 指令受影響。
- **修法**：`runSaveTools` 在呼叫 `app.Validate()` 之前，先用 CLI 參數的 `appID` 覆寫 `app.AppID`（不論檔案裡有沒有寫）。

### 🟡 console 編輯器存檔會靜默刪掉 `kind: query` 工具（原 improvement-backlog 2026-07-24，併入於 2026-08-16）
- **位置**：`apps/console/src/schema.ts:17-22`（`Tool` 型別定義）
- **問題**：前端的 `Tool` TypeScript 型別完全沒有 `kind` 欄位（全 `apps/console/src` grep 零命中）。任何在 console 編輯器裡開啟、修改、存檔的 app，只要含有 `kind: query` 的工具，`api.ts` 把整個 `Tool[]` 原封 PUT 回後端時該工具的 `kind` 就會被靜默丟掉——變成一般 action 工具，其 query handler 從此不再把資料餵給 LLM，且全程沒有任何錯誤訊息。前端的 `validate.ts` 也缺少後端 `loader.go`（`Validate()`）那條「query 工具必須有 `returns`」的規則，所以這類問題連前端自己的存檔前驗證都攔不到。
- **修法**：`schema.ts` 的 `Tool` 型別加上 `kind` 欄位並在存檔流程中保留；`ToolForm.tsx` 提供對應 UI（見「建議新增功能」的 console `kind: query` 編輯 UI 項目）；`validate.ts` 補上與後端一致的「query 必須有 returns」規則。

### 🟡 定價頁文案跟實際配額計算方式不一致（原 improvement-backlog 2026-07-24，併入於 2026-08-16）
- **位置**：`apps/landing/pricing/index.html:200`（文案）vs `backend/internal/quota/quota.go:13-14, 254-290`（`usageSince`/`ownerStanding`）
- **問題**：定價頁文案寫「100 prompts **per app**, per month」，但 `quota.go` 的用量計算是 **per owner**（依 `owner_id` 跨該使用者所有 app 加總）。一個開發者若開了 3 個 app（例如 staging/prod/demo），實際上是這 3 個 app 共用 100 次，不是各自 100 次，跟頁面文案直接矛盾。
- **修法**：修正 `pricing/index.html` 文案為「100 prompts per account/owner, per month」，或反過來改配額計算邏輯為 per-app（產品面決策，非單純程式碼修正）。

### 🟠 A2. Playground 仍是同步阻塞呼叫
- **位置**：`backend/internal/console/playground.go`
- **問題**：prompt 迴圈在同一個 `conn.ReadMessage()` 迴圈裡直接同步呼叫 `h.Inference.Complete`，沒有用 `go` 關鍵字分派到獨立 goroutine（`ws/session.go` 已有 `go s.handlePrompt(...)`，playground 沒有跟進）。
- **修法**：Playground 的 prompt 也比照 `session.go` 分派到獨立 goroutine，維持兩處架構一致。
- **現況**：確認仍未修。因為 A1 已修好物件層級隔離（每個 session 各自 orchestrator），這裡的同步阻塞不再是「鎖住全平台」的死結，影響範圍縮小為「這一個 Playground 連線自己卡住」，嚴重度從 🔴 調降為 🟠。

### 🟠 A3. `ws.Session.run()` 的 `ctx.Done()` 無法中斷進行中的阻塞讀取
- **位置**：`session.go:84-91`——`select { case <-ctx.Done(): return; default: }` 只在兩次 `ReadMessage()` 之間檢查；`ReadMessage()` 本身不綁 `ctx`，只有獨立的 `pongTimeout`（60s，每收到 pong 就重置）。
- **影響**：request context 被取消時（server shutdown），idle-but-connected 的連線要等下一次 `ReadMessage()` 自然返回才退出（最長 60s，或客戶端持續 pong 就永遠不退），graceful shutdown 非確定性；且 `defer inference.UnregisterAsker(s.id)`（防 stale asker 卡住未來 query tool）被同樣延遲。
- **修法**：shutdown 時明確 `conn.Close()` 以 error 中斷 `ReadMessage`，或確認 hijacked 連線的 per-request context 語意後不依賴它。

### 🟠 A1. 單一共用 orchestrator 序列化全平台吞吐（最大架構限制）——物件隔離已修復，吞吐量瓶頸仍未解決
- **位置**：`backend/internal/inference/want.go`
- **現況**：`WantService` 每個 SessionID 各自有獨立的 `*orchestrator.Orchestrator`（`want.go` 的 `sessions` map），對話內容層級的隔離已經是真正的物件隔離。**仍未解決**：每個 session 的 orchestrator 仍然共用同一個 process-wide 的 `GlobalEngine`/`RequestQueue`（`want` 的 provider `RequestQueue` 寫死 `maxConcurrent=1`）——吞吐量仍然完全序列化。要真正並行需要 `want` 開放「每個 orchestrator 各自的 provider/佇列」機制，這是改 `want` 才能根治的，詳見 `docs/known-issues-want-dependency.md`。（DoS 面的影響見 `docs/audit-security.md` 的 S2。）

### 🟡 A4. `askers` 是靠呼叫端紀律的 package 全域狀態
- **位置**：`interaction.go:27-30`（`askers` 有 RWMutex，但 process 全域 key、無 TTL）
- **影響**：`askers` 若 process 中途重啟留下 stale entry。
- **修法**：至少加註解記錄假設；長期把這狀態綁定到 orchestrator 實例而非 package 全域。

### 🟡 A5. `RegisterAppRole` 是跨套件手動維護的 invariant
- **位置**：`console.go` 的 `syncWantRole` 在三個 mutation 點呼叫 `RegisterAppRole`——型別系統不強制，第四條忘記呼叫的 mutation 路徑會重現同類 bug。

### 🟡 A6. `listApps` 的 N+1 查詢
- **位置**：`console.go:246-268`——`OwnedBy` 一次查詢後，迴圈裡每個 app 各呼叫 `HasKey`+`OriginFor`（各一次 `db.QueryRow`）。N 個 app = `1+2N` 次查詢。
- **修法**：批次查詢（`WHERE app_id = ANY($1)`），或把 `api_key_hash IS NOT NULL`/`allowed_origin` 直接併進 `OwnedBy` 的 SELECT。

### 🟡 A7. `codegen.ToLLMTools`/`Request.Tools` 在真實推論路徑是死碼
- **位置**：`WantService.Complete`（`want.go`）從不讀 `req.Tools`（工具來源全靠預註冊的 want role）；唯一讀者是 `mock.go`。但兩個真實呼叫點（`session.go`、`playground.go`）每次 prompt 仍計算 `codegen.ToLLMTools(app)` 傳進去——熱路徑上的浪費，也誤導讀者以為 `Tools` 對 want 有作用。
- **修法**：要嘛讓 `Complete` 真的用 `req.Tools` 對已註冊 role 做一致性檢查，要嘛從兩個真實呼叫點移除、保留 mock-only。

### 🟠 F1. SDK 無限重連無斷路器/終端狀態
- **位置**：`packages/bridge/src/client.ts:132-145`——`scheduleReconnect` 永遠重試（backoff 封頂 10s），無法區分暫時性斷線 vs 致命狀況（key 錯/被撤銷/app 被刪/appId 錯）。stale 分頁會每 10s 無限敲後端。無回呼告訴嵌入方「這連線已永久死掉」。
- **修法**：加 max-attempt/max-elapsed 上限＋獨立終端狀態，透過新回呼（如 `onDisconnected(permanent)`）曝露；分頁 hidden 時暫停/減速重連。

### 🟠 F2. SDK 吞掉 WS close/error code，auth 失敗看起來跟斷線一樣
- **位置**：`client.ts:132-141`——close handler 完全忽略 `event.code`/`reason`，error 是純 no-op。撤銷 key 產生的 auth 拒絕 close 與暫時性斷線無法區分，兩者都無限重試、零信號。
- **修法**：檢查 `ev.code`，把 4xxx auth 類 code 當終端、停止重試（需先確認 `internal/ws` 實際用什麼 code 關閉）。

### 🟠 F5. ADDR-vs-PORT — 確認的 Cloud Run 風險，且文件把它講反了
- **位置**：`backend/cmd/server/main.go`——`addr := envOr("ADDR", ":8080")`；全 `backend/` 從不讀 `PORT`。Cloud Run 一律注入 `PORT` 並期望容器聽它；`ADDR` 是 Cloud Run 不認識的自訂變數。現在能動只因 fallback `:8080` 剛好等於 Cloud Run 目前預設 `PORT=8080`。
- **修法**：改成 `":" + envOr("PORT", "8080")`（`ADDR` 保留為非 Cloud Run 用的完整位址覆寫），並修正文件說法。

### 🟡 F3. SDK queue 無上限成長（配合 F1 的記憶體洩漏）
- **位置**：`client.ts:80`——`queue` 無 size cap，配合無限重連，對永久死掉的後端頁面會累積每一次 `prompt()` 呼叫。
- **修法**：限制 queue 長度（丟最舊，比照 gtag），或曝露 `queue.length`。

### 🟡 F4. SDK `ToolHandler` 是 `any` 型別，違背「型別安全」訴求
- **位置**：`client.ts:14`——`ToolHandler = (args: any) => ...`。handler 的 `args` 與工具宣告的 JSON schema 無泛型連結；console 的 `codegen.ts` 產生的 `ToolHandlers` interface 也沒有自動接進 `AgentBridgeOptions.tools` 的機制。
- **修法**：讓 `AgentBridgeOptions` 對 `ToolHandlers` 形狀泛型化，把 console 已產生的 interface 接上，讓 `tools:` 有真正編譯期檢查。

### 🟡 F6. `tool_query`/`tool_call` 的阻塞語意只在程式碼註解、不在公開 API doc surface
- **位置**：`client.ts:168-178` 有內部註解說明兩者現在都會阻塞後端 LLM 推論。公開的 `ToolHandler`/`AgentBridgeOptions` JSDoc 仍完全沒提到 handler 會阻塞 LLM 推論直到 resolve。開發者可能不知情地寫慢/網路綁定的 handler，靜默拖慢每個 prompt。
- **修法**：在公開 `tools` 欄位的 doc comment 說明；handler 超過 N 秒才 resolve 時 runtime 警告。

### 🟠 CI/CD 部署前沒有跑測試（原 project-health-review 2026-07-22，併入於 2026-08-16）
- **位置**：`.github/workflows/deploy-cloudrun.yml`、`release-onagent.yml`
- **問題**：兩個 workflow 皆無 `go test`/`go vet` 步驟（grep 零命中）。目前流程是「build 完直接上生產環境」，沒有自動化安全網；也沒有 rollback 腳本或文件化的 rollback SOP（Cloud Run 本身保留舊 revision 可手動切流量，但無腳本化流程）。
- **修法**：deploy workflow 加 `go test ./...`/`go vet ./...` 關卡；補文件化的 rollback SOP。

### ⚪ 低優先（多為 cosmetic）
- **後端測試覆蓋率偏低**：Go 後端 14 個 `internal/` package 只有 4 個（`adminauth`、`adminconsole`、`db`、`quota`，29%）有測試，且多為 `*_integration_test.go`（需真實 DB）。`auth`、`ws`、`session`、`usertoken`、`cliauth`、`inference`（LLM 核心邏輯）等安全/核心敏感模組完全沒有單元測試。最高風險未測路徑：ws.Session 的 mutex 狀態機（`handlePrompt`/`handleToolResult`/`AskInteraction` 競爭 `pendingCalls`/`app`）、`sanitizeSessionID`/`AgentIDToSessionID` 的 `"WS-"` prefix round-trip（單邊改就默默壞掉所有 query tool）、`saveApp` 的 delete-then-insert transaction、`withOwnedApp` 的 404-not-403 隔離 invariant。`backend/internal/codegen` 整個套件也無任何測試檔，2026-08-16 複掃確認的三個 codegen bug 都出在這個無測試覆蓋的套件。前端 `apps/admin`、`packages/bridge` 仍是零測試；`apps/console` 已補上 vitest + jsdom（`ThoughtEditor.markdown.test.ts`，14 個測試涵蓋 Markdown 編輯的字元/段落層級狀態），但僅此一支測試檔，其餘元件（`App.tsx`、`Sidebar.tsx` 等）仍未覆蓋。`quota/quota_test.go`（222 行）是後端最完整的測試，顯示團隊有測試意識但尚未鋪開。
- **console 無 `kind: query` UI**（`schema.ts:17-22` 的 TS `Tool` interface 根本沒有 `kind`）：只能手改 YAML 才能建 query 工具；需確認 `saveTools` 的 payload 會不會把 `kind` drop 掉。
- **`codegen.ts:143-153` 巢狀 object 屬性 description 在 TS 預覽被丟棄**（`tsType` 的 `case 'object'` vs `writeInterface`）：僅預覽準確度，不影響 runtime。
- **`db.Open` 每次開機重跑 `schema.sql`、無 migration 版本控制**：additive 時 OK，但與 `cmd/migrate` 兩套 schema 變更機制並存，未來破壞性變更（改欄位型別/rename）易 drift。
- **`main.go` 的 `wsAuth := authStore` 永遠非 nil**：`ws/handler.go` 的 `Auth == nil` dev-mode 分支實質不可達，是誤導性的死防禦碼。
- **`cloudbuild.yaml` 不存在**（並非「死碼待清」，是從未存在）：唯一部署路徑是 GH Actions workflow，文件也只寫這條。原本以為它存在是 stale 認知。
- **前後端程式碼重複**：`apps/console/src/api.ts` 與 `apps/admin/src/api.ts` 幾乎是複製貼上的同一份 fetch wrapper（相同的 `ApiError`、`credentials: 'include'` 模式、`BASE` 環境變數 fallback）。已有 `packages/bridge` 先例，值得抽出共用 package。
- **`PROJECT_ID="onagent-prod"` 散落多處各自硬編碼**（deploy 腳本 + `deploy-cloudrun.yml`），無單一真相來源，變更專案 ID 需同步改多處。
- **完全沒有監控告警**：無 Sentry/Datadog/Prometheus/Grafana 等工具接入；`/healthz` 端點存在但沒有外部服務定期戳它，僅供人工部署後檢查用。`/healthz` 本身「無條件回 200、未真的檢查 DB」的問題見 `docs/audit-stability.md`。
- **Monorepo 內前端版號跨專案不一致**：`apps/console`/`apps/admin` 用 React `^18.3.1` + TypeScript `^7.0.2` + Vite `^6`；`examples/react-demo` 用 React `^19.2.7` + Vite `^8.1.1`。TypeScript `^7.0.2` 這個版號較可疑，值得確認是否為筆誤。
- **CI 未接 secret-scanning 工具**（如 gitleaks/trufflehog），完全依賴 `.gitignore` 紀律與人工審查。
- **兩個 Dockerfile（`Dockerfile`、`Dockerfile.release`）皆無 `HEALTHCHECK` 指令**：Cloud Run 有自己的健康檢查機制，非致命缺口，但若 `Dockerfile.release` 被用於其他 orchestrator（其設計初衷）則會缺這一環。

---

## 已解決的項目

- **admin 後台「Users」清單在 `QUOTA_ENABLED=false` 時完全壞掉**（2026-08-16 修復並實測確認）：`backend/internal/quota/admin.go` 的 `CountUsers`/`ListUsers` 只要 `quota.Service` 是 `nil`（停用配額服務時）就直接回傳 `"quota: service is disabled"` 錯誤，`adminconsole.go` 把這個 500 原樣丟給前端，前端吞掉顯示成「No users yet」。已修復為：`main.go` 讓 admin 後台拿自己獨立、恆常建構的 `quota.Service`（`quota.New(database)`），與 `/ws`/`/console` 用來做額度**執行**的可為 nil 的 `quotaSvc` 分開。實測：`QUOTA_ENABLED=false` 下註冊 2 個帳號，`/admin/api/users` 正確回傳 `total:2` 與完整資料。
- **console 登入頁密碼欄位 placeholder 是字面上的 `••••••••`**（2026-08-16 修復並截圖確認）：`apps/console/src/Login.tsx` 空白密碼欄位視覺上看起來像已填密碼，易誤導使用者。已改成 `Enter your password`。

---

## 建議新增功能（非安全相關）

1. **可觀測性**：目前只有 log、無 metrics。至少加：每次 query-tool 呼叫的「lock-held-for-interaction 時長」、inference 排隊等待時長、per-app 呼叫量。
2. **console 的 `kind: query` 編輯 UI**：讓 query 工具能在網頁管理，不必手改 YAML。
3. **`onagent get-tools <appId>` CLI 指令**：目前 CLI 只能推、不能拉，確認「實際存了什麼」只能查 DB 或開 console。後端已有 `GET /console/apps/{appId}` API，CLI 加一個指令即可。
4. **串流回覆**：目前 `Complete()` 是一次性回傳，前端等整輪推論結束。串流可大幅改善體感延遲（但要注意跟 A1 序列化的互動）。
5. **部署設定 fail-fast 擴充**：`AI_PROVIDER=googleapis` 但 `GOOGLE_API_KEY` 未設時、production 缺關鍵 secret 時，啟動即拒絕（延續現有 `APP_ENV=production` 機制）。
