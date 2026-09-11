# onagent 功能/架構稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。安全性發現另外記在 `docs/audit-security.md`，本檔案只收邏輯錯誤、狀態管理問題、架構債、效能、程式碼品質等非安全性發現。

---

## 最新掃描：2026-09-11

> 方法：本日兩輪。第一輪從一次 Playground 實測（`get_weather` 查詢工具的假資料回傳，LLM 卻只收到「executed successfully」罐頭訊息）反查根因，人工逐檔追蹤前後端資料鏈。第二輪為全專案 6-agent 並行稽核（後端核心邏輯、auth/quota/session、並發穩定性、安全、console 前端、SDK/協定一致性），每個 agent 被要求「必須讀過實際程式碼、必須給出具體失敗情境」才能提報，主 session 再對每一項高嚴重度發現親自讀碼複核，剔除無實際觸發路徑者（例如一項被提報為 CRITICAL 的 `tool_call` requestId 不對應問題，經查證正式路徑永不觸發而降為 🟡）。安全類發現記於 `docs/audit-security.md`，並發/穩定性類記於 `docs/audit-stability.md`。

### 🔴 Console 編輯畫面完全沒有 `kind`/`backendDispatch` 欄位，經它存檔一次就會把這兩個既有值靜默覆寫成預設值（新發現，已實測重現）
- **位置**：前端型別 `apps/console/src/schema.ts:17-40`（`Tool` interface 缺 `kind`/`backendDispatch`，只有 `id`/`name`/`description`/`parameters`/`returns`/`sourceTemplate`）；整個工具編輯 UI（桌面版 `ToolForm.tsx`、手機版 `ToolEditSheet.tsx` 及其四個子欄位 sheet、`ToolWizard.tsx`）都沒有任何 `kind`/`backendDispatch` 相關輸入或顯示；後端全欄位覆寫寫入邏輯在 `backend/internal/toolschema/registry.go:404-407`（`kind` 空字串時預設回填 `ToolKindAction`）與 `:428-434`（`Updates(map[string]any{...})` 明確把 `kind`、`backend_dispatch` 列入覆寫欄位，非 partial update）。
- **問題**：後端 `toolschema.Tool`（`backend/internal/toolschema/schema.go:12-81`）完整欄位是 `ID`/`Name`/`Description`/`Parameters`/`Returns`/`Kind`/`BackendDispatch`/`SourceTemplate`，但前端 `Tool` 型別只覆蓋其中 6 個，完全遺漏 `Kind`（action/query，決定工具呼叫是否要把頁面回傳的真實資料帶回給 LLM）跟 `BackendDispatch`（讓後端呼叫開發者自己 HTTP endpoint 的設定）。`saveTool`/`updateAndSaveTool` 送出的 payload 因此永遠不含這兩個欄位；後端 `saveTool()` 是 `Updates(map[string]any{"kind": ..., "backend_dispatch": ...})` 這種明確列出全部欄位的寫法，不是只更新有傳的欄位——所以任何工具只要透過 console 網頁存檔一次（哪怕只是改個 description），資料庫裡原本正確的 `kind: query` 或既有的 `backendDispatch` 設定都會被前端沒傳的空值覆蓋掉：`kind` 被強制改回 `action`（`registry.go:404-407` 的預設回填），`backendDispatch` 被整個清空成 `null`。
- **repro**：實測時建立一個 `get_weather` 查詢工具（有 `returns` schema，理應是 `kind: query`），Playground 的假資料回傳邏輯（`fakeDataFromSchema`）正確產生並送出了 `{ok: true, result: {temperature: ..., conditions: ...}}`，但 `agent_WS-PG-1-mya.json` 推論 log 顯示 LLM 收到的 `tool_result` 內容始終只有「`"get_weather" executed successfully."`」這句罐頭訊息，資料完全沒有送達。追查後端 `internal/inference/agent_roles.go` 的 `toolFactoryFor`（179-193 行）發現：`kind: action` 的工具會走 `forwardingTool.Call`（205-225 行），該函式**故意**丟棄 `askPage` 回傳的實際內容，只回一句罐頭成功訊息；只有 `kind: query` 才會走 `queryTool.Call`（265-282 行），把頁面實際回傳的 `answerJSON` 交給 LLM。確認 `get_weather` 的 `kind` 是空/`action`，而不是預期的 `query`——這正是本條目描述的存檔覆寫問題導致的結果。
- **影響範圍**：不只是「AI tool builder 產生的查詢工具沒被正確標註 kind」這一種情境（那是原因之一，仍待修），而是**任何** app 的**任何**工具，只要曾經（透過 CLI 手動 YAML、或未來補上 kind UI 之前的任何管道）被設成 `kind: query` 或帶有 `backendDispatch`，之後只要有人在 console 網頁編輯畫面存檔一次，就會被靜默改回預設值，沒有任何錯誤或警告，且下次要診斷「工具明明設對了但 LLM 拿不到資料」時完全沒有痕跡可查。
- **修法**：(1) 前端 `schema.ts` 的 `Tool` interface 加上 `kind?: 'action' | 'query'` 欄位；(2) `ToolForm.tsx`/`ToolEditSheet.tsx`（含手機版子欄位 sheet）新增可編輯的 `kind` 選擇器，並正確帶著現有值往返；(3) `aiToolGenerator.ts` 的 `toTool()` 保留 LLM 回傳的 `kind`；(4) `tool-builder-tools.yaml` 的 `propose_tool` schema 加上明確 `kind` 欄位讓 AI 產生工具時能標註；(5) `backendDispatch` 若短期內不打算做完整編輯 UI，至少要讓前端存檔時把既有值原樣帶回（而非整個遺漏），避免同樣的靜默覆寫；(6) 手動修正這次已在正式機建立、被錯誤覆寫成 `action` 的 `get_weather` 工具。
- **現況（2026-09-11 複核）**：`kind` 的半邊已於 v0.5.0 修復——修法 (1)~(4) 均已落地（`schema.ts` 有 `kind?: ToolKind`、兩個編輯畫面都有「Query tool」欄位、`toTool()` 保留 `kind`、`propose_tool` schema 有必填 `kind` enum）。**`backendDispatch` 的半邊（修法 (5)）仍未修**：前端 `Tool` 型別至今沒有這個欄位，任何工具只要經 console 存檔一次，既有的 `backend_dispatch` 設定仍會被 `registry.go:428-434` 的全欄位覆寫寫成 `null`。修法 (6) 屬正式機資料，非程式碼問題。

### 🔴 六個 console handler 在 `OwnerOf`（DB）與 `Get`（快取）不一致時會 nil 解參照 panic（2026-09-11 新發現）

- **位置**：`backend/internal/console/console.go:587`、`:616`、`:678`、`:728`、`:753`、`:779` — 六處皆為 `app, _ := h.Apps.Get(appID)` 後直接 `len(app.Tools)`（已逐行複核確認）
- **問題**：授權走 `withOwnedApp` → `Registry.OwnerOf`（`registry.go:225-233`，**即時查 DB**），取資料走 `h.Apps.Get`（`registry.go:79-84`，**記憶體快取**）——兩個不同的真實來源。六處都用 `app, _ :=` 丟棄 `ok` 後解參照，而 `Get` miss 時回傳 `nil` 指標。
- **佐證這不是理論問題**：同一個檔案的 `listApps`（`:518-521`）對**完全相同**的呼叫明確檢查了 `ok`，並附註解「owner_id row exists but Registry cache hasn't caught up; skip rather than fake zero tools」——證明這個分歧是**已知的真實狀況**，只是其他六處沒有比照防護。
- **具體失敗情境**：多實例部署時，實例 A 服務 `POST /console/apps` 建立 `myapp`（DB 已 commit），實例 B 的 `Registry` 快取尚未重載（`Reload` 只在 B **自己**的寫入時觸發，沒有任何跨實例失效機制）。使用者下一個 `GET /console/apps/myapp` 打到 B：`OwnerOf` 在共用 Postgres 找到列因而授權通過，`Get` 在 B 的舊快取 miss 回傳 nil，handler 解參照 → panic。`SaveTool` 內部 `Reload()` 失敗時（`registry.go:146-148` 回傳錯誤但快取留在舊狀態）亦同。
- **修法**：六處比照 `listApps` 加上 `app, ok := ...; if !ok { http.Error(w, "unknown appId", 404); return }`。更根本的作法是讓 `ownedAppOrNotFound` 從 `Get` 讀取的**同一份**快取解析 ownership，使授權與取資料無法分歧。

### 🔴 超長 app id 使 `sessionKeyFor` 摺疊成 `""`，不同使用者共用同一個對話 orchestrator（2026-09-11 新發現）

- **位置**：`backend/internal/inference/want.go:349`（`sessionIDRE = ^[a-zA-Z0-9_-]{1,128}$`）、`:356-361`（`sessionKeyFor`）、`:194-210`（`getOrCreate`）；`backend/internal/toolschema/loader.go:18`（`appIDRE`）
- **問題**：`sessionKeyFor` 對不符 `sessionIDRE` 的 id 一律回傳 `""`，而 `getOrCreate` 就以 `s.sessions[""]` 當鍵——**所有落到這條路徑的呼叫者共用同一個 orchestrator、同一份對話歷史**（該函式自己的註解也承認 `""` 是「a single shared orchestrator for every caller」）。關鍵在於 `appIDRE` 是 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`，用 `*` 量詞、**完全沒有長度上限**（已複核確認），`apps.app_id`/`tools.app_id` 在 schema 中也是無長度限制的 `TEXT`。
- **具體失敗情境**：Playground 的 sessionID 是 `PG-<userID>-<appID>`（`playground.go:208`），所以 appID 超過約 122 字元就會讓整串超過 128 而被摺疊成 `""`。開發者 Alice 用一個 130 字元的 app id 建立 app（`Create` → `ValidAppID` 正常放行）並開 Playground → key 為 `""`；開發者 Bob 對他自己的長 id app 做同樣的事 → key 也是 `""`。兩人此刻共用同一個 `*orchestrator.Orchestrator` 與同一份對話 transcript，Bob 的 prompt 看得到 Alice 先前的對話內容，反之亦然。這是經由完全正常、通過驗證的建立流程即可達成的跨租戶對話洩漏。`?fresh=1` 與 tool-builder 的隨機後綴（`playground.go:209-211`）多加 17 字元，只會讓觸發更容易。
- **修法**：(1) 在 `loader.go` 的 `appIDRE` 加上長度上限（例如 `{1,64}`），確保任何衍生 id 都不可能溢出；(2) 讓 `sessionKeyFor` **fail closed**——回傳錯誤或改用雜湊，而不是靜默落到「所有人共用」的 `""` 鍵。

### 🔴 前端 `refreshDraftForSwitch` 的捨棄確認是無窮迴圈，桌面版導覽會完全卡死（2026-09-11 新發現）

- **位置**：`apps/console/src/App.tsx:697-719`，關鍵在 `:704`
- **問題**：`confirmDiscard('Discard unsaved tool changes?', () => refreshDraftForSwitch(switchView))` 的回呼是**遞迴呼叫自己**，而 `draft` 是同一個物件、`isToolDirty` 讀的是同一份 `savedToolsRef.current`——點擊與重新進入之間沒有任何東西清除或覆寫髒資料狀態，所以 `anyDirty` 必然仍為 `true`，立刻again 跳出同一個對話框（已逐行複核確認）。
- **repro（桌面版）**：選一個有至少一個已存工具的 app → 點工具 A → 編輯它的 Description 但不存檔 → 點側欄的工具 B → 跳出「Discard unsaved tool changes?」→ 點 **Discard** → **同一個對話框立刻再次出現**，之後每次 Discard 都一樣。只有 Cancel 能脫身，使用者永遠離不開工具 A。
- **影響範圍**：`selectTool`、`selectAgent`、`selectPlayground`、`selectSettings`、`selectAppSettings`、`selectPreview` 全都經由此函式——只要有任何一個工具處於未存檔狀態，**整個桌面版導覽都被鎖死**。
- **修法**：確認的回呼必須繞過髒資料檢查——把函式尾段（`switchView()` + 重新抓取）抽成不含 `anyDirty` 閘門的 `doSwitch`，讓 `confirmDiscard` 呼叫它。（重新抓取本來就會用伺服器狀態覆寫 `draft`，正是「捨棄」該有的語意。）

### 🟠 Escape 鍵會同時關閉巢狀子 sheet 與父層 `ToolEditSheet`，靜默丟棄所有批次編輯（2026-09-11 新發現）

- **位置**：`apps/console/src/BottomSheet.tsx:67-74`（document 層級 Escape handler，只以自身 `open` 為條件）、`ToolEditSheet.tsx:128-134`、`:244-271`
- **問題**：每個 `BottomSheet` 都常駐掛載並各自註冊 document 層級的 Escape handler，而 `ToolEditSheet` 把四個子 sheet 渲染在**自己內部**——所以子 sheet 開啟時，兩者的 `open` 都是 `true`，一次 Escape **兩個 handler 都會觸發**。handler 沒有 `stopPropagation`，也沒有任何「最上層才反應」的判斷（為 z-index 新增的 `SheetDepthContext` 在此並未被參考）。而 `ToolEditSheet` 的 `handleClose` 只在 `isNew` 時才有 `onConfirmDiscard` 保護，一般既有工具的實例（`MobileWorkspaceCards.tsx:188-198`）沒有傳這個 prop，會直接關閉。
- **repro**：開啟一個工具 → 點 **Name** → 改成 `renamed_tool` → 點 Done → 點 **Description** → 重寫內容 → 按 **Escape**。ToolDescriptionSheet 關閉，**ToolEditSheet 也一併關閉**，名稱與描述兩筆修改（都只存在 `ToolEditSheet` 的本地 `draft`、從未寫進 `draft.tools`）全部消失，無任何確認或錯誤提示。
- **修法**：讓 `BottomSheet` 只在自己是最上層開啟的 sheet 時才處理 Escape（例如以 context 維護一個開啟中的 sheet 堆疊），或由子層 handler `stopPropagation` 並確保捕獲順序。

### 🟠 已輸入但未按 Add 的 origin 在存檔時被靜默丟棄（2026-09-11 新發現）

- **位置**：`apps/console/src/AppSettingsView.tsx:69-78`、`apps/console/src/OriginEditSheet.tsx:70-79`，對應 `App.tsx:418-425`
- **問題**：`onOriginDraftsChange([...originDrafts, trimmed])`（即 `setOriginDrafts`）之後，**同一個同步流程**立刻呼叫 `onSaveOrigins(e)`；React 不會在這兩行之間套用狀態更新，而 `saveOrigins`（`App.tsx:422`）的 `await api.setOrigins(draft.appId, originDrafts)` 讀的是**當次 render 閉包裡的舊陣列**，新 origin 從未被送出。更糟的是存檔後會 `refreshSummaries()`，而 `App.tsx:298-301` 的 effect 會用伺服器回應重設 `setOriginDrafts`，把樂觀新增的本地項目也一併覆蓋掉。
- **repro**：App settings → 在 origin 輸入框打 `https://example.com` → **不按 Add**，直接按 **Save origins**（按鈕此時是啟用的）→ 請求送出、走成功路徑 → 但 origins 清單回來後沒有 `https://example.com`，使用者的輸入完全消失。由於 app 沒有任何 allowed origin 時**所有** WebSocket 連線都會被拒絕，這正是靜默丟失最要命的欄位。
- **修法**：把合併後的清單顯式傳下去——`onSaveOrigins` 改為接受 origins 陣列（`onSaveOrigins(e, [...originDrafts, trimmed])`），`saveOrigins` 送出該參數而非讀取 state。

### 🟠 Playground 連線中斷後 UI 完全死鎖，只能重整頁面（2026-09-11 新發現）

- **位置**：`apps/console/src/Playground.tsx:141`、`:212-298`、`:504`
- **問題**：`sending` 在 `sendPrompt`（`:445`）設為 `true`，只在 `onAssistantMessage`（`:268`）與 `onError`（`:278`）清除——**`onClose`/`onConnectionError` 都沒有清除**，連線 effect 的重設區塊（`:213-216`）也只重設 `messages`/`toolCalls`/`state`/`ready`，沒有 `sending`。而系統沒有自動重連。
- **具體後果**：送出 prompt 後連線中斷時，Send 按鈕停用（`!connected`）、輸入框停用（`!connected`）、**連「Reset context」也停用**（`resetDisabled = sending || ...`，而 `sending` 仍是 `true`）。Reset context 是唯一能重跑連線 effect 的控制項，三個全部停用等於頁面內無任何復原手段。
- **repro**：開啟 Playground、送出 prompt，在助理回覆前關掉後端或斷網。狀態顯示「Disconnected」、「Thinking…」永久停留，所有控制項灰掉，只有整頁重新整理能救。
- **修法**：在 `onClose` 與 `onConnectionError` 都補上 `setSending(false)`，並把它加進連線 effect 的重設區塊。

### 🟠 CLI 授權失敗時留下孤兒 bearer token，且註解宣稱的正好相反（2026-09-11 新發現）

- **位置**：`backend/internal/console/console.go:933-959`（`approveCliAuth`），`Issue` 在 `:943`、`Approve` 在 `:948`、錯誤註解在 `:951-954`；`usertoken.Issue` 的持久化在 `usertoken.go:85-88`
- **問題**：handler **先**鑄出 token（`h.Tokens.Issue` 內部 `s.db.Create(&row)`，立刻寫入一列有效的 `user_tokens`），**才**呼叫 `h.CliAuth.Approve`。當 `Approve` 回傳 `ok=false` 時 handler 回 409，並附註解說「The minted token above was never persisted anywhere or shown to anyone」——**這句話與程式碼事實不符**：`Issue` 早已 commit 該列。明文被丟棄了，但 hash 列存活下來，成為一把沒人看得到、無法稽核、也無從刻意撤銷的有效憑證。
- **具體失敗情境**：使用者在兩個分頁開啟 CLI 同意頁並都按核准（雙擊／上一頁的常見操作）。分頁 1：`Issue` 建立 token #1、`Approve` 成功 → 200。分頁 2：`Issue` 建立 token #2（有效、hash 已存），`Approve` 的條件式 `WHERE ... approved = false` 匹配 0 列 → `ok=false` → 409。token #2 就此留在 `user_tokens`，名稱同為 `"browser login"`，在 `GET /console/tokens` 中與正牌的那一把**完全無法區分**，且 `user_tokens` 無 expiry 欄位、`usertoken.Verify` 也不檢查到期——永久有效。使用者看到兩筆一模一樣的項目，撤銷錯的那一把就會弄壞正在運作的 CLI。
- **修法**：改為先做單次宣告再鑄 token——新增 `cliauth.Claim(id)` 只執行 `approved=false → true` 的條件式 UPDATE，成功後才 `Issue` 並回寫。或在 `Approve` 回傳 false 時以 `Issue` 已回傳的 id（目前被 `_` 丟棄，而它回傳 `id int64` 正是為了讓呼叫端日後能參照）呼叫 `h.Tokens.Revoke` 補償。無論採哪種，都要修正那段錯誤註解。

### 🟠 `schemaCheckTargets` 漏掉 schema.sql 十四張表中的兩張，漂移檢查回報 `ok: true` 卻對它們完全盲目（2026-09-11 新發現）

- **位置**：`backend/internal/adminconsole/schema_check.go:153-166`（`schemaCheckTargets`）對照 `backend/internal/db/schema.sql` — 缺 `identities`（`schema.sql:38`）與 `agent_experiences`（`:402`）
- **問題**：`schema.sql` 宣告 14 張表，註冊表只列 10 張。該函式自己的註解警告「add a table's reference struct above and an entry here whenever schema.sql gains one, or the new table silently drops out of this check」——這件事**已經發生兩次**且無任何機制偵測。`schemaCheck`（`:178-190`）只在**列入清單**的表失敗時才設 `ok = false`，所以 `GET /admin/api/schema-check` 會回傳 `{"ok": true, ...}` 與 10 筆 `tables`，而兩張表根本沒被檢查。
- **具體失敗情境**：`agent_experiences` 正是這個檢查最該盯的表——`schema.sql:415` 對它套用手寫遷移 `ALTER TABLE agent_experiences ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT ''`。若有人在 `schema.sql` 改名 `exp_id` 卻沒同步 `sessionstore.experienceRow`（`sessionstore.go:23-29`），每次 `Append` 都會因缺欄位而失敗、整個對話歷史功能損壞，但 admin 的 schema-check 頁面仍顯示十張表全綠、`ok: true`，主動誤導正在排查的人。`identities`（支撐 Google 登入）同樣暴露。
- **修法**：補上 `identitiesFull`／`agentExperiencesFull` 參考結構與註冊表條目。更根本的作法是讓 `schemaCheck` 先查 `information_schema.tables` 取得實際表清單，對任何「資料庫有、註冊表沒有」的表回報為一項失敗，讓未來的遺漏能自我暴露。

### 🟡 `session.go` 事後補送 `tool_call` 的迴圈使用 prompt 的 requestId，回覆永遠無法對應（2026-09-11 新發現）

- **位置**：`backend/internal/ws/session.go:329-334`
- **問題**：`Complete` 返回後的 `for _, tc := range result.ToolCalls` 迴圈以 `env.RequestID`（**prompt 的** requestId）送出 `TypeToolCall`，且從未在 `s.pendingCalls` 登記任何條目。真正能對應的路徑是 `AskInteraction`（`:392-412`），它自行產生 `requestID := randomID()`、登記 `pendingCalls` 後才送出。同一個訊息類型存在兩套互不相容的 requestId 慣例。
- **現況（為何降為 MEDIUM 而非 CRITICAL）**：已複核 `want.go:335-341` 的註解與實作——正式的 want 路徑**刻意讓 `Result.ToolCalls` 永遠為空**（工具呼叫改由 `forwardingTool`/`queryTool` 經 `askPage` 直接同步送出），唯一會填充它的是 `MockService`（`mock.go:28`），而該服務只在 `cmd/server/main.go:541` 的非預設開發分支可達。**正式環境不會觸發**，因此是死碼與架構債，而非 live bug。
- **潛在後果**：若未來任何 `inference.Service` 實作重新填充 `Result.ToolCalls`，瀏覽器會執行工具並回送一個帶著 prompt requestId 的 `tool_result`，`handleToolResult`（`:350-363`）找不到對應的 pending channel，只會靜默記一行 log 丟棄——工具在客戶頁面上真的執行了，結果卻無聲消失，雙方都收不到錯誤。
- **修法**：依 `want.go:335` 已陳述的現實直接刪除該迴圈（讓 `AskInteraction` 成為唯一的 `tool_call` 發送者），並從 `inference.Result` 移除 `ToolCalls` 欄位；或讓迴圈為每次呼叫以新的 `randomID()` 登記 `pendingCalls` 使回覆可對應。前者較符合既有設計。

### 🟡 手機版在頁面載入時就開啟真實的 Playground WebSocket，使用者根本還沒點開（2026-09-11 新發現）

- **位置**：`apps/console/src/PlaygroundSheet.tsx:34-47`、`MobileNav.tsx:68`、`BottomSheet.module.css:24`
- **問題**：`BottomSheet` 關閉時只是 `transform: translateY(100%)`，**子元件仍保持掛載並持續運作**。而 `PlaygroundSheet` 對 `<Playground>` 的渲染條件是 `appId &&`——**不是** `open &&`。所以手機版只要選了 app（`App.tsx:315-320` 會自動選），`Playground` 就掛載、連線 effect 執行、呼叫 `refreshQuota()` 並開啟一條到 `/console/apps/{appId}/playground` 的 WebSocket。
- **repro**：在手機（或 <860px 視窗）以已登入、至少有一個 app 的狀態載入 console，完全不碰底部工具列。DevTools Network 會看到一個 `GET /console/quota` 與一條開啟中的 playground WS。從上方選單切換 app 會拆掉再開一條。後端為一個使用者從未開啟的 Playground 配置了 want orchestrator 與 session。
- **修法**：渲染條件改為 `open && appId`，或維持掛載但傳入 `paused`/`enabled` prop 讓連線 effect 遵守。

### 🟡 重新命名 schema 屬性會讓該列跳到清單最下方並奪走焦點（2026-09-11 新發現）

- **位置**：`apps/console/src/SchemaEditor.tsx:72-85`
- **問題**：`const nextProps = { ...properties }; delete nextProps[oldName]; nextProps[newName] = properties[oldName]` — JS 物件的字串鍵維持插入順序，先刪再插會把該屬性移到**最後**。而列表（`:172`）以 `Object.keys(properties)` 迭代、每列 `key={name}`，於是每按一個鍵該列就從原位置卸載、在底部重新掛載，焦點隨之消失。
- **repro**：工具參數依序為 `alpha`、`beta`、`gamma`。點進 `alpha` 的名稱欄位打一個字使其成為 `alphax`——該列立刻跳到 `gamma` 下方、input 被重新掛載、游標丟失，因此要打完一個多字元的新名稱必須每按一鍵就重新點一次欄位；同時該參數在 schema 中的位置（也就是 LLM 看到的工具定義順序）被靜默重排。
- **修法**：改為保留位置的重建方式 `Object.fromEntries(Object.entries(properties).map(([k, v]) => [k === oldName ? newName : k, v]))`，並給該列一個能跨越改名的穩定 key。

### 🟡 `interaction.go` 的 `AgentIDToSessionID` 註解描述已被移除的行為，且引用了不存在的函式（2026-09-11 新發現）

- **位置**：`backend/internal/inference/interaction.go:65-79`
- **問題**：註解宣稱「只剝除 `WS-`；Playground 的 `PG-<userID>-<appID>` session **從不註冊 asker**，所以從 Playground 使用 query tool 會正確地以 "no page connected" 失敗」。兩項宣稱自 Playground 遷移至共用 `ws.Session` 後皆已不成立：(1) `want.go:206` 對**每一個** session 都加 `"WS-"` 前綴，Playground session 的 AgentID 是 `WS-PG-1-myapp`，剝掉後得 `PG-1-myapp`；(2) `ws/session.go:118` **無條件** `RegisterAsker(s.id, s)`，Playground 的 `PG-…` id 確實有註冊。
- **具體風險**：維護者讀了這段註解會以為 query tool 到不了 Playground、且 `"PG-"` 的情況已被處理。若據此「補上」缺少的 `PG-` 剝除，`WS-PG-1-myapp` 會變成 `1-myapp`，對不上任何已註冊的 asker，**靜默弄壞 Playground 裡所有 query tool 與 action tool**。這段註解正把讀者導向該迴歸。
- **附帶**：本註解（`:25`）與 `agent_roles.go:257` 的交叉引用都提到 **`sanitizeSessionID`** 這個**已不存在**的函式（全 repo 零個定義，只剩這兩處懸空引用），它已更名為 `sessionKeyFor`。
- **修法**：改寫註解陳述現況（所有 session 一律帶 `WS-` 前綴；Playground 的 id 位於該前綴**之內**且確實註冊 asker），並把兩處 `sanitizeSessionID` 更新為 `sessionKeyFor`。

### 🟡 `apps_without_owner` 完整性檢查永遠不可能觸發，且說明描述的是已不存在的程式碼（2026-09-11 新發現）

- **位置**：`backend/internal/quota/integrity.go:56-62` 對照 `backend/internal/db/schema.sql:132-133`
- **問題**：兩個獨立缺陷。(1) `schema.sql:132-133` 在**每次啟動**都執行 `UPDATE apps SET owner_id = 1 WHERE owner_id IS NULL;` 後接 `ALTER TABLE apps ALTER COLUMN owner_id SET NOT NULL;`（`db.Open` 每次開機套用整份檔案），所以任何伺服器成功啟動過的資料庫該欄位都是 `NOT NULL`，`SELECT count(*) FROM apps WHERE owner_id IS NULL` 結構上保證回傳 0。(2) 它的 `detail` 寫著「ownerStanding requires owner_id IS NOT NULL, so Check() fails open」——`ownerStanding` 已更名為 `userStanding`（`quota.go:319`），且 `Check` 早已完全不碰 `apps` 表（改為直接收 `userID`、只 join `users`+`subscriptions`，`quota.go:125-151`）。所描述的失效模式來自 `userID` 改版前的設計。
- **具體後果**：維運人員開啟 admin 完整性頁面排查計費異常，看到 `apps_without_owner: 0, ok: true, severity: critical`——看似安心，實則是套套邏輯而非證據；同時該條目的文字把他導向閱讀一個不存在的符號、推敲一條已被移除的 fail-open 路徑。這個檢查佔著一個「專門用來抓靜默帳本損壞」的註冊表名額，卻提供零訊號。
- **修法**：刪除該條目（`NOT NULL` 約束本身就是更強的保證），或改指向一個真的可能被違反的不變量——例如 `usage_events` 中 `owner_id` 與同 `app_id` 現行 `apps.owner_id` 不一致的列（`Record` 的去正規化寫入在 app 易主時確實會產生這種漂移）。無論何者都要改寫 `detail` 以符合改版後的 `Check`。

### ⚪ 其他已驗證的小問題

- **`playgroundStatus` 是死的 export，且註解描述了不存在的 prop**（`apps/console/src/Playground.tsx:27-32`）：以「供 `onStatusChange` 回報給父層 PlaygroundSheet」為由 export，但全 repo 沒有任何檔案 import 它，且 `Playground` 根本沒有 `onStatusChange` prop（實際機制是 `renderHeaderExtras`，傳的是已渲染好的節點）。export 的理由不成立。修法：拿掉 `export` 與註解中過時的那半段。
- **`Template.noParameters` 不可達且潛在錯誤**（`apps/console/src/ToolWizard.tsx:140`、`:322`）：`TEMPLATES`（`:145-269`）沒有任何一項設定它，`visibleSteps` 恆為完整五步，該 `filter` 分支是死碼。同時它潛在不正確——`pickTemplate`（`:336-340`）硬寫 `setStepIndex(1)`，而 `back()`/`next()` 以索引走訪 `visibleSteps`，所以若真有模板設了此旗標，「Parameters」那一步對應的索引會被靜默位移。
- **`session.Login` 未 trim 也未正規化它回傳的 email**（`backend/internal/session/session.go:184-201`，`adminauth.Login` 同）：`Register`（`:120`）有 `strings.TrimSpace`，`Login` 沒有，所以密碼管理員補上的尾隨空白會導致「帳密錯誤」而使用者無從得知原因；且它回傳呼叫端傳入的 `email` 而非資料庫的 `row.Email`，使得以 `TIM@X.COM` 登入時 `POST /console/login` 回 `{"email":"TIM@X.COM"}` 而 `GET /console/me` 回 `{"email":"tim@x.com"}`，重新整理後顯示的帳號身分會改變。
- **`quota` 套件的死欄位**（`backend/internal/quota/quota.go:35-41`、`:61-66`）：`usageEventRow` 只被當作 `Model(&usageEventRow{})` 用來指定表名，五個宣告欄位無一被讀寫（`Record` 走原生 SQL）；`standingScanRow.OwnerID` 從未被 `userStanding` 的 `Select(...)` 選取，恆為 0，而其註解仍描述著 `StandingFor`/`ownerStanding` 兩個呼叫者的分工——該安排在 `StandingFor` 改為委派給 `userStanding` 後已不存在。

---

## 舊掃描：2026-09-09

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
