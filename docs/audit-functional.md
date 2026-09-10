# onagent 功能/架構稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。安全性發現另外記在 `docs/audit-security.md`，本檔案只收邏輯錯誤、狀態管理問題、架構債、效能、程式碼品質等非安全性發現。

---

## 最新掃描：2026-09-09

> 方法：3 路並行掃描——(1) console 前端這次未提交的手機版重構（邏輯不一致＋過時註解）、(2) backend 邏輯不一致（排除已記錄條目）、(3) 專案級文件（README/CHANGELOG/apps 說明/`.env.example`/skill 文件）跟實際程式碼現況比對。全部發現皆已人工複核程式碼驗證，非直接採信 agent 結論。

### 🟠 `ToolNameSheet.tsx`/`ToolDescriptionSheet.tsx`：可儲存判斷用 trim 後字串，實際送出未 trim，導致帶尾隨空白的工具名稱能通過「可儲存」檢查（新發現）
- **位置**：`apps/console/src/ToolNameSheet.tsx:30,38`、`apps/console/src/ToolDescriptionSheet.tsx:27,35`；驗證端 `apps/console/src/validate.ts:24`（`TOOL_NAME_RE.test(tool.name)`，未 trim）
- **問題**：`saveDisabled={draft.trim() === name}` 用**修剪後**的字串判斷 Save 按鈕是否可按，但 `onSave(draft)` 送出的是**未修剪**的原始 `draft`。使用者在工具名稱後多打一個空格（如 `"my_tool "`）時，`draft.trim() === name` 為 false，Save 被啟用；存檔後 `tool.name` 帶著尾隨空白，之後在 `validate.ts:24` 的 `TOOL_NAME_RE.test(tool.name)`（同樣未 trim）判定為不合法名稱格式，跳出驗證錯誤——使用者剛按下 Save 就看到報錯，但介面上看不出是尾隨空白造成的。桌面版 `ToolForm.tsx` 沒有這個問題，因為它是逐鍵直接 `onChange`，沒有「本地草稿 + trim 比較 + 未 trim 送出」這層落差，是手機重構新引入的行為。
- **修法**：`onSave` 送出前統一 trim（`onSave(draft.trim())`），讓比較與送出用同一個字串；或 `saveDisabled` 改用未 trim 的字串比較，讓兩者的正規化程度一致（前者較合理，因為工具名稱本來就不該允許前後空白）。

### 🟡 `quota.Record` 的 doc comment 自相矛盾——前段仍宣稱靠 `eventID` 去重、`ON CONFLICT` 讓重試安全，後段（同一段註解）已改口說明去重機制已移除（新發現）
- **位置**：`backend/internal/quota/quota.go:135-137`（矛盾的前段）vs `:151-166`（正確反映現況的後段）vs `:177-182`（實際 SQL，確認無 `ON CONFLICT`）
- **問題**：第 135-137 行寫「Record appends one usage event for appID, keyed by eventID for idempotency (...) — the ON CONFLICT below makes the insert a no-op the second time」；但第 151 行起明確說「eventID is stored for audit/debugging only — it is NOT used to deduplicate anymore」，並詳述改掉的原因（`apps/console` Playground 的 `requestId="0"` 在跨頁面重載時退化成不可靠的去重鍵，曾造成真實 prompt 被誤判為重試而漏記）。實際 SQL（177-182 行）也已確認沒有 `ON CONFLICT` 子句。這是同一段 doc comment 裡新舊事實並存、前段沒有跟著後面的修訂清乾淨——字面上第一段仍會誤導讀者以為重試安全、不會重複計費，但代碼與後段都指出現在**會**重複計費（且是刻意接受的權衡，見後段對 Stripe 上線後要重新評估的說明）。
- **修法**：刪除或改寫第 135-137 行，讓函式開頭第一段就直接反映「不再去重、eventID 僅供稽核」的現況，避免只讀開頭兩行的讀者被誤導。

---

## 舊掃描：2026-08-16

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
2. ~~**🟠 A2 Playground 同步阻塞**~~ — 已解決（2026-09-04，見「已解決的項目」）。
3. **🟠 S2 / A1 orchestrator 序列化＋無 rate limit**（S2 見 `docs/audit-security.md`，A1 見下）— 平台級瓶頸與 DoS 面，最重要但工程量最大，過渡期先加 rate limit。
4. **🟠 F5 ADDR/PORT**（見下）— 部署正確性，改動小。
5. **🟠 F1/F2 SDK 重連斷路器**（見下）— 第三方直接依賴，影響外部開發者體驗。

---

## 進行中的發現（依嚴重度排序）

### 🔴 手機版新增工具（空白／精靈以外／AI 生成）從未真正存檔，重新整理就消失（2026-09-10 發現並修復，實測重現）
- **位置**：`apps/console/src/App.tsx` 的 `appendTool`（第 572-576 行，只更新本地 state）vs `addToolFromWizard`（第 587-594 行，多呼叫一次 `persistTool`）；`MobileWorkspaceCards.tsx` 的 `onCreateTool` prop 原本接的就是 `appendTool`
- **問題**：`MobileWorkspaceCards.tsx` 的 `ToolEditSheet`（`isNew` 實例，涵蓋手機版「+ New tool」空白新增、AI 生成兩種入口——Wizard 精靈是另一條獨立路徑，不受影響）只有**一個**提交點：使用者在 sheet 裡按下自己的 Save，觸發 `onChange` → `onCreateTool(next)`。這個 prop 原本接的是 `appendTool`，它只做 `updateDraft({...draft, tools: [...draft.tools, tool]})`——**純粹更新前端本地畫面，從未呼叫任何後端存檔 API**。使用者體感上完全看不出異常：工具出現在畫面上、畫面切到該工具的編輯視圖，一切看起來都成功了——但重新整理頁面、或切換 app 再切回來，這個工具就會靜默消失，沒有任何錯誤訊息。桌面版不受影響：桌面 `ToolForm` 有自己獨立的 `onSave`（呼叫 `saveTool(index)`，內部正確呼叫 `persistTool`），跟手機版的 `isNew ToolEditSheet` 是兩套不同元件走不同路徑。`addToolFromWizard`（Wizard 精靈新增，桌面/手機共用同一個函式）本身是對的——它在附加工具後多做了一步 `persistTool(...)`，證明「新增工具要記得存檔」這件事在那條路徑上是正確實作的，只有 `appendTool`／`onCreateTool` 這條路徑被漏掉，兩者本該一致卻沒有。
- **修法**：新增 `appendAndSaveTool`（`App.tsx`），複製 `appendTool` 的邏輯但額外呼叫 `persistTool(draft.appId, index, tool)`，同 `addToolFromWizard` 的模式——因為 `ToolEditSheet` 的 `isNew` 實例保證呼叫 `onChange` 時內容已經完整確認（sheet 自己的 `saveDisabled` 邏輯會擋掉不合法名稱才能按 Save），不會有「半成品被提早存檔驗證失敗」的風險，不同於桌面版空白新增（`addTool` → `appendTool(emptyTool())`，仍然故意保留純本地更新，因為那條路徑是「先放空殼，使用者自己填完再按 `ToolForm` 自己的 Save」）。`MobileWorkspaceCards` 的 `onCreateTool` 改接 `appendAndSaveTool`，`appendTool` 本身維持不動（`addTool()` 仍需要它）。
- **驗證**：`tsc --noEmit`、`vite build`（254 個模組）、47 個既有測試全數通過。

### 🟠 CLI `tool list`/`tool create` 輸出入格式不對稱，無法 round-trip（2026-09-10 新發現）
- **位置**：`backend/cmd/onagent/main.go` 的 `runGetTools`（`tool list`）與 `runSaveTools`（`tool create`）；`apiClient.getApp` 的 doc comment 也重複同樣的錯誤宣稱
- **問題**：`tool list` 印出整個 `toolschema.App`（`appId`/`tools:[...]`/`thought`），其註解宣稱「輸出可以直接存檔、餵回去 round-trip」；但 `tool create` 用 `yaml.Unmarshal(data, &tool)` 讀進的是**單一 `toolschema.Tool`**，沒有外層 `tools:` 包裹、也沒有 `appId`/`thought`，其自身註解也承認這點——兩處註解互相矛盾。只要 app 有 ≥1 個工具，`tool list <appId> > out.yaml` 的輸出直接餵給 `tool create <appId> out.yaml` 必定失敗：整個 `App` 結構被硬塞進 `Tool` 型別，`name`/`description`/`parameters` 全變零值，`Validate()` 因空 `name`/空 `parameters.type` 報錯。沒有任何測試涵蓋這條路徑（`apiclient_test.go` 只測 HTTP client 層），這個矛盾因此從未被抓到。這個問題是我在把 `backend/internal/console/tool-builder-tools.yaml`（整份 App 結構）推送到本機時親自踩到的——必須先手動拆出 `tools[0]` 到獨立檔案才能用 `tool create`。
- **修法方向（已確認、尚未拍板哪個）**：(a) 把 `tool list` 輸出格式改成單一 `Tool` 陣列（不包 `appId`/`thought`），`tool create` 同步支援吃單一 Tool 或 Tool 陣列，讓兩者真正 round-trip；或 (b) CLI 額外提供一個「整份 App-shaped YAML 一次載入」指令（例如 `onagent app load <file.yaml>`），讓 `tool-builder-tools.yaml` 這類完整 App 定義檔可以直接部署，不用拆成多個單一 Tool 檔案。

### 🟠 AI tool builder 產生的查詢類工具，`kind` 意圖從沒被保存，存檔後會靜默變成錯誤的 `action`（2026-09-10 新發現，實測重現）
- **位置**：`backend/internal/console/tool-builder-tools.yaml`（`propose_tool` 的 `parameters` schema，第 50-84 行）、`apps/console/src/aiToolGenerator.ts` 的 `toTool()`（第 53-62 行）、`apps/console/src/schema.ts`（`Tool` 型別，無 `kind` 欄位）
- **問題**：`tool-builder-tools.yaml` 的 Thought 指令教 LLM「用 `returns` 欄位有無暗示這個工具是 query 還是 action」（"omit the whole returns key for a fire-and-forget action tool... only include this field if... (a 'query' tool)"），但 `propose_tool` 這個 function 的參數 schema **完全沒有 `kind` 欄位**讓 LLM 明確表態——LLM 對 `kind` 的判斷完全靠 `returns` 有無這個間接訊號，且這個訊號從沒有被轉換成真正的 `Tool.kind` 值。實測重現（debug log `debug_googleapis_WS-PG-1-tool-builder-9bc8aeedb7ac1144.json`）：使用者描述「讀取房價資訊」，LLM 正確理解這是查詢意圖，產生的 `read_housing_prices` 工具帶了結構化的 `returns`（`properties: [{location, price}]` 陣列）——LLM 這一步判斷完全正確。但 `aiToolGenerator.ts` 的 `toTool()` 只複製 `name`/`description`/`parameters`/`returns` 四個欄位，`kind` 從沒被讀取也沒被寫入；`apps/console/src/schema.ts` 的 `Tool` 型別本身也沒有 `kind` 欄位（既有發現，見下方「console 編輯器存檔會靜默刪掉 `kind: query` 工具」條目）。這個工具存檔後，後端 `kind` 會落到 `toolschema.Tool` 的預設值（`ToolKindAction`）——一個「讀取房價」這種明顯該回傳資料給對話的查詢工具，被靜默存成 fire-and-forget 的 action，實際使用時會壞掉（查到的房價資料傳不回 LLM，對話裡看不到查詢結果）。
- **修法**：兩個層面都要補：(1) `propose_tool` 的 schema 加一個明確的 `kind` enum 欄位（`"action"` / `"query"`），Thought 指令改成直接要求 LLM 明確填這個欄位，而不是靠 `returns` 有無去反推；(2) 這個修法依賴既有發現「console 前端 `Tool` 型別完全沒有 `kind` 欄位」先被解決——`toTool()` 才有地方可以把 LLM 回傳的 `kind` 放進去，`ToolEditSheet` 也才能讓使用者存檔前檢視/修正 AI 判斷錯的情況。

### 🟡 `aiToolGenerator.ts` 重造 `Playground.tsx` 已有的 WebSocket 協定邏輯（2026-09-10 發現，同日已修復）
- **位置**：`apps/console/src/aiToolGenerator.ts`（AI tool builder 核心邏輯）vs `apps/console/src/Playground.tsx`
- **問題**：`aiToolGenerator.ts` 自己手刻了一份 WebSocket 協定處理（hello → 等 ack → prompt → 處理 `tool_call` → 回 `tool_result`），跟 `Playground.tsx` 已經寫好、驗證過的協定處理邏輯是兩份獨立、平行維護的實作，沒有共用程式碼。這被認為是 AI tool builder 曾經完全壞掉（`propose_tool` 設成 `kind: query` 但 `aiToolGenerator.ts` 只監聽 `tool_query`，實際上後端對 `kind: action` 的工具送的是 `tool_call`，訊息類型完全對不上、生成永遠逾時失敗）這個 bug 的背後根因——若當初重用 `Playground.tsx` 的協定處理，這類訊息類型不匹配本可以在寫程式當下就被既有邏輯的行為約束住。這個 protocol type bug 本身已在 commit `552db38` 修正（`kind: action` + 監聽 `tool_call`），**重複實作本身也已解決**：新增 `apps/console/src/playgroundProtocol.ts` 共用模組（連線建立、`hello`/`ack` 握手、訊息 parse/分派、共用型別），`aiToolGenerator.ts`/`Playground.tsx` 都改為呼叫它，各自只保留自己特有的部分（`toTool()` 轉換 vs mock 效果邏輯）。共用模組刻意不管連線生命週期（開/關時機仍各自決定），確保 `Playground.tsx` 的穩定 session（跨重連沿用同一個 `PG-<userID>-<appID>`）跟 `aiToolGenerator.ts` 的一次性 session（每次 Generate 都是新的 `PG-<userID>-tool-builder-<隨機後綴>`）不會被意外混用。
- **驗證**：`tsc --noEmit`、`vite build`（254 個模組）、47 個既有測試全數通過；並實測重打一次完整流程（`debug_googleapis_WS-PG-1-tool-builder-9bc8aeedb7ac1144.json`），確認整條協定鏈路正常運作到 `propose_tool` 被正確呼叫、回應正確回傳前端。

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

### 🟠 A3. `ws.Session.run()` 的 `ctx.Done()` 無法中斷進行中的阻塞讀取
- **位置**：`session.go:84-91`——`select { case <-ctx.Done(): return; default: }` 只在兩次 `ReadMessage()` 之間檢查；`ReadMessage()` 本身不綁 `ctx`，只有獨立的 `pongTimeout`（60s，每收到 pong 就重置）。
- **影響**：request context 被取消時（server shutdown），idle-but-connected 的連線要等下一次 `ReadMessage()` 自然返回才退出（最長 60s，或客戶端持續 pong 就永遠不退），graceful shutdown 非確定性；且 `defer inference.UnregisterAsker(s.id)`（防 stale asker 卡住未來 query tool）被同樣延遲。
- **修法**：shutdown 時明確 `conn.Close()` 以 error 中斷 `ReadMessage`，或確認 hijacked 連線的 per-request context 語意後不依賴它。

### 🟠 A1. 單一共用 orchestrator 序列化全平台吞吐（最大架構限制）——物件隔離已修復，吞吐量瓶頸仍未解決
- **位置**：`backend/internal/inference/want.go`；`session.go`/`playground.go` 現在共用同一段 `ws.Session.handlePrompt` 呼叫路徑（Playground 已改用 `ws.AppResolver` 接入共用的 `ws.Session`，不再是各自獨立的實作）。
- **現況**：`WantService` 每個 SessionID 各自有獨立的 `*orchestrator.Orchestrator`（`want.go` 的 `sessions` map），對話內容層級的隔離已經是真正的物件隔離。**仍未解決**：每個 session 的 orchestrator 仍然共用同一個 process-wide 的 `GlobalEngine`/`RequestQueue`（`want` 的 provider `RequestQueue` 寫死 `maxConcurrent=1`）——吞吐量仍然完全序列化，且 Playground 連線現在也吃這個瓶頸（先前 Playground 走獨立協定，不受影響）。要真正並行需要 `want` 開放「每個 orchestrator 各自的 provider/佇列」機制，這是改 `want` 才能根治的，詳見 `docs/known-issues-want-dependency.md`。（DoS 面的影響見 `docs/audit-security.md` 的 S2。）

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
- **位置**：`WantService.Complete`（`want.go`）從不讀 `req.Tools`（工具來源全靠預註冊的 want role）；唯一讀者是 `mock.go`。唯一真實呼叫點是 `session.go:295`（`handlePrompt`）——Playground 改用共用 `ws.Session` 後，`playground.go` 已不再自己組 `inference.Request`/呼叫 `codegen.ToLLMTools`（原本各自獨立時是兩個呼叫點,現已收斂成一個）,但這一處每次 prompt 仍計算 `codegen.ToLLMTools(app)` 傳進去——熱路徑上的浪費，也誤導讀者以為 `Tools` 對 want 有作用。
- **修法**：要嘛讓 `Complete` 真的用 `req.Tools` 對已註冊 role 做一致性檢查，要嘛從這個呼叫點移除、保留 mock-only。

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
- **後端測試覆蓋率偏低**：Go 後端 `internal/` package 多數仍是 `*_integration_test.go`（需真實 DB）為主，`auth`、`session`、`usertoken`、`cliauth`、`inference`（LLM 核心邏輯）等安全/核心敏感模組完全沒有單元測試。`ws` package 已有基本覆蓋：`AskInteraction`/`handleToolResult` 的 `pendingCalls` 配對/逾時/race（`session_test.go`）、`resolveSessionID`（`TestResolveSessionID`）、`ws.Handler.ServeHTTP`/`AppResolver` 分流與 `APIKeyResolver` 六個認證分支（`handler_test.go`/`handler_integration_test.go`）；`internal/console` 也新增了 `playgroundResolver.ResolveApp` 七個分支的測試（`playground_integration_test.go`，含 404-not-403 隔離，等同 `withOwnedApp` 邏輯的覆蓋）。仍未覆蓋的最高風險路徑：**`handlePrompt` 本身**（需要真實 `inference.Service`/`toolschema.Registry`/`quota.Service`，目前完全沒有測試碰到它）、`sanitizeSessionID`/`AgentIDToSessionID` 的 `"WS-"` prefix round-trip（單邊改就默默壞掉所有 query tool）、`saveApp` 的 delete-then-insert transaction、`withOwnedApp` 函式本身（其邏輯等價物 `playgroundResolver.ResolveApp` 已有測試，但兩者是各自獨立維護的程式碼，見上方新增的架構債條目）。`backend/internal/codegen` 整個套件也無任何測試檔，2026-08-16 複掃確認的三個 codegen bug 都出在這個無測試覆蓋的套件。前端 `apps/admin`、`packages/bridge` 仍是零測試；`apps/console` 已補上 vitest + jsdom（`ThoughtEditor.markdown.test.ts`，14 個測試涵蓋 Markdown 編輯的字元/段落層級狀態），但僅此一支測試檔，其餘元件（`App.tsx`、`Sidebar.tsx` 等）仍未覆蓋。`quota/quota_test.go`（222 行）是後端最完整的測試，顯示團隊有測試意識但尚未鋪開。
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
- **A2. Playground 仍是同步阻塞呼叫**（2026-09-04 修復並複核確認）：`backend/internal/console/playground.go` 原本在同一個 `conn.ReadMessage()` 迴圈裡直接同步呼叫 `h.Inference.Complete`，沒有像 `ws/session.go` 用 `go` 關鍵字分派。根本解法不是「補上這一個 goroutine」，而是整個刪除 Playground 自己重寫的獨立 WebSocket 協定，改為共用 `internal/ws.Session`——`playground.go` 現在透過新增的 `ws.AppResolver` 介面（`playgroundResolver`）把認證方式（console session cookie + ownership）接進 `ws.NewSession(...)`，之後的 prompt 處理走的就是 `ws.Session.handlePrompt` 既有的 `go s.handlePrompt(ctx, ...)` 非同步分派，兩處架構自然一致，不再是兩份需要手動同步的程式碼。順帶修復了 Playground 從未呼叫 `inference.RegisterAsker` 導致 `ToolKindAction`/`ToolKindQuery` 工具必然失敗（"no connected page for session..."）的獨立缺陷（這個缺陷本身未曾被稽核記錄過，僅在此併記）。複核：`go build`/`go vet`/`go test`（含新增的 `handler_test.go`/`handler_integration_test.go`/`playground_integration_test.go`）全數通過，並用真實 WebSocket client 手動驗證過 hello/ack 握手正確共用 `ws.Session`。
- **`playgroundResolver.ResolveApp` 與 `withOwnedApp` 的手動同步授權邏輯**（2026-09-09 複核確認已修復，修復本身未記錄確切 commit 時間，推測隨後續重構一併完成）：原本兩處各自重寫等價的 ownership／404-not-403 判斷，程式碼註解曾自陳「the two must be kept in sync by hand」。現況：`backend/internal/console/console.go:279-286` 已抽出共用函式 `ownedAppOrNotFound(apps appOwnerLookup, userID int64, appID string) bool`，`withOwnedApp` 與 `backend/internal/console/playground.go:115` 的 `playgroundResolver.ResolveApp` 都直接呼叫它（後者第 80-83 行的註解已更新為「the ownership check itself is shared... so this and withOwnedApp can't drift apart」，與程式碼一致）。複核：讀原始碼確認呼叫點與共用函式簽名相符，非僅命名巧合。
- **手機版重構留下的 3 處過時註解**（2026-09-09 發現，v0.3.0 打 tag 前修復並確認）：`apps/console/src/AppList.tsx:4` 的「mobile MobileSidebar drawer」已改成「mobile AppPickerSheet」；`apps/console/src/SheetHeader.tsx:3-11` 已從舉例清單改成泛化描述（不再窮舉呼叫端，避免新增 sheet 時又漏更新）；`apps/console/src/useSheet.ts:3-8` 補上遺漏的 `ToolEditSheet.tsx` 四次呼叫（name/description/parameters/returns）。複核：修正後三處註解與 grep 出的實際呼叫點一致。
- **AI 輔助工具產生器（「Generate with AI」）從未真正運作過，前端永遠 30 秒逾時**（2026-09-10 由 commit `552db38` 修復，本機重推 tool 定義後實測確認）：`apps/console/src/aiToolGenerator.ts` 原本只監聽 `tool_query`，但 `propose_tool` 本質是 fire-and-forget（其確認回傳從未被進一步推理），應該是 `ToolKindAction` 不是 `ToolKindQuery`，後端因此實際送出的是 `tool_call`——前端從未收到過它在等的訊息，每次使用都卡滿 30 秒逾時，即使 LLM 已經成功產生工具提案。`backend/internal/console/tool-builder-tools.yaml` 當時的 `kind: query` 記錄的正是這個錯誤假設，跟前端的監聽方向一致地錯，不是互相矛盾。`552db38` 同時修正了兩處：`aiToolGenerator.ts` 改監聽 `tool_call`，`tool-builder-tools.yaml` 的 `kind` 改成 `action`（映射見 `backend/internal/ws/session.go:404-407`：`ToolKindAction` → `TypeToolCall`）。本機環境另外需要用 `onagent tool create` 重新推送這份 YAML 才會生效（見下一條），因為 `git commit` 本身不會更動已經存在資料庫裡的舊 tool 定義。
- **部署一致性陷阱：修好原始碼裡的 tool 定義，不代表資料庫裡已存的內容會自動跟著更新**（2026-09-10 操作中發現，非程式碼 bug，記錄作為維運提醒）：`tool-builder` app 的工具定義是透過 `onagent tool create` CLI 指令主動推送進資料庫的，不是每次部署自動同步。`552db38` 把 `tool-builder-tools.yaml` 的 `kind` 改成 `action` 之後，本機資料庫裡先前存的 tool 定義（`kind` 仍是修正前的 `query`）並不會自動跟著變，親自用 `onagent tool create backend/internal/console/tool-builder-tools.yaml` 重推才會生效——這件事在這次操作中一度被忽略，導致本機即使已經拉到修好的程式碼，实際行為仍然卡逾時，需要另外意識到「程式碼修好」跟「當前部署的資料狀態」是兩回事才排查出來。任何環境（本機、預發、正式）都需要有人記得在程式碼修正後手動重推這類工具定義，目前沒有 CI/CD 流程或啟動時檢查會自動偵測「原始碼裡的 tool 定義」跟「資料庫裡實際存的 tool 定義」是否一致或過時。
- **Playground 頁面重新整理後 `requestId` 歸零，導致用量遺漏**（2026-09-03 發現並修正，原記錄併自已刪除的 `docs/known-issues-pending-discussion.md`）：`usage_events` 表用 `(app_id, event_id)` 唯一索引 + `ON CONFLICT DO NOTHING` 做 idempotency 去重（`event_id = sessionID + ":" + requestID`，`requestID` 完全由呼叫端決定，後端不驗證）——這個機制本身是刻意設計的，目的是讓「客戶端重試同一個 request」不會被重複扣費（注意：此後 `quota.Record` 的去重機制已於後續變更整個移除，見本檔案上方「`quota.Record` 的 doc comment 自相矛盾」條目，這裡記的是移除前的行為）。`apps/console/src/Playground.tsx` 的 `nextId`（`useRef(0)`）同時被用來當 React 訊息顯示 id 跟 WebSocket 的 `requestId`；`useRef` 的值會在元件重新掛載（使用者重新整理頁面）時重置為 `0`，而 `sessionID`（`PG-<userID>-<appID>`）對同一使用者、同一 app 是固定字串——重新整理頁面後，新一輪對話的第一句話（`requestId="0"`）跟過去某次頁面載入時第一句話的 `event_id` 完全相同，被 `ON CONFLICT DO NOTHING` 靜默吃掉，沒有任何錯誤或警告，前端仍收到正常的推論回應，但 `usage_events` 沒有新增記錄。診斷方式：因為 `Quota.Record()` 的錯誤原本被完全吞掉且無 log，只能透過還原正式資料庫快照到獨立 staging 環境、加上完整斷點式 log，才追出 `Record()` 回傳「無錯誤」但實際插入 0 列的真相。修法：`requestId` 改用 `crypto.randomUUID()`，不再依賴任何會重置的計數器。驗證：修正後在 staging 重新整理頁面多次測試，未再重現。

---

## 建議新增功能（非安全相關）

1. **可觀測性**：目前只有 log、無 metrics。至少加：每次 query-tool 呼叫的「lock-held-for-interaction 時長」、inference 排隊等待時長、per-app 呼叫量。
2. **console 的 `kind: query` 編輯 UI**：讓 query 工具能在網頁管理，不必手改 YAML。
3. **`onagent get-tools <appId>` CLI 指令**：目前 CLI 只能推、不能拉，確認「實際存了什麼」只能查 DB 或開 console。後端已有 `GET /console/apps/{appId}` API，CLI 加一個指令即可。
4. **串流回覆**：目前 `Complete()` 是一次性回傳，前端等整輪推論結束。串流可大幅改善體感延遲（但要注意跟 A1 序列化的互動）。
5. **部署設定 fail-fast 擴充**：`AI_PROVIDER=googleapis` 但 `GOOGLE_API_KEY` 未設時、production 缺關鍵 secret 時，啟動即拒絕（延續現有 `APP_ENV=production` 機制）。
