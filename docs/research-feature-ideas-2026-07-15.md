# onagent 新功能構想（10 個）

> 產出日期：2026-07-15。方法：三個 Sonnet subagent 從不同角度（開發者體驗、終端使用者/執行期、平台/商業信任）發散腦力激盪共 22 個構想，去重、挑選後綜合成最有槓桿且最貼合 onagent 產品形狀（瀏覽器內 tool-calling、action/query 雙型別、多租戶第三方嵌入）的 10 個。
>
> ⭐ = 最推薦的前三個。分三組：授權/開發體驗、執行期/終端使用者、平台/信任。

---

## A. 授權與開發體驗（Authoring / DX）

### ⭐ 1. 版本化即修法：把 append-only bug 變成明確的工具版本控制
- **要解的痛**：`want` registry 是 first-match-wins、append-only（已確認的 bug），開發者在 console 就地編輯工具 schema **不會生效**，卻毫無察覺——等於默默 ship 了無效的改動。
- **怎麼運作**：把「隱性的 bug」翻轉成「顯性的功能」——每次 schema 編輯在工具的穩定 ID 底下建立一個新版本，console 顯示版本歷史 diff；per-app 開關可把一定比例的真實流量導到新版本（shadow 模式：只 log 新版本「本來會 match 什麼」而不真的 dispatch），確認 OK 再 promote 到 100%。
- **為何重要**：**修法與功能是同一個改動**——把意外的 append-only registry 變成刻意、可見的版本機制，同時給開發者一條安全的 promotion 路徑，取代現在的「改了就祈禱」。直接對應審計報告的 S1/A1。

### ⭐ 2. Tool Trace Inspector：看見 LLM「當時看到什麼、為什麼這樣選」
- **要解的痛**：LLM 選錯工具或填錯參數時，開發者完全看不到**原因**——是 description 措辭問題？跟另一個工具語意重疊？還是 query 工具的 page-state 對不上？prompt-to-tool-call 天生是黑箱。
- **怎麼運作**：每次 dispatch 記錄完整決策脈絡：使用者 prompt、LLM 實際看到的候選工具清單（含送出當下的 description）、選中的工具+參數、query 工具的回傳資料與延遲。console 以 per-session timeline 呈現，附「replay」按鈕——用**當前**工具定義重送同一個 prompt，讓你拿失敗的那個 case 直接 A/B 一次 description 修改。
- **為何重要**：這是**其他所有 DX 功能都預設存在的除錯基礎**。本 session 花大量時間讀 `tmp/logs/*.json` 手動追 LLM 決策，正是這個功能該自動化的東西。

### 3. `onagent dev` — 本機工具 shadowing 的即時開發迴圈
- **要解的痛**：現在測一個工具改動要「console 編輯 → 存檔 → 重整目標網站 → 祈禱 WS 抓到新 schema」，慢，而且很難拿未發佈的工具去測真實 page state。
- **怎麼運作**：`onagent dev` 跑一個本機 process，攔截你 app 的 WS session，讓你在本機 YAML/TS 檔案裡「shadow」已發佈的工具——SDK 連 prod，但被 shadow 的名稱其定義與 dispatch 從你筆電供應。改本機檔案，下一個 prompt 就生效，不用 console 存檔、不用發佈。
- **為何重要**：action/query 型別讓工具與 live DOM 緊密耦合，你需要對**真實**嵌入網站的快速迴圈，不是 mock。把最大的開發稅（改 schema → alt-tab → 重打 → 重整）變成即時迭代。

### 4. Schema-First 型別產生 + 型別安全的 handler 契約
- **要解的痛**：工具參數在 console 是 JSON Schema，但 SDK 端 handler 是手寫 JS/TS——兩者漂移造成 call 當下才爆的靜默不匹配（欄位改名 → dispatch 壞掉但只在呼叫時才發現）。直接對應審計 F4。
- **怎麼運作**：`onagent generate` 拉出 app 的工具定義，產生強型別 `handlers.d.ts`——每個工具一個 callback 簽名（參數型別由 JSON Schema 推導、query 工具**強制**回傳型別、action 工具**強制** void）。開發者 import 進 `registerHandlers({...})`，TypeScript 自己就會拒絕不符當前 schema 的 handler。
- **為何重要**：action/query 之別本身是型別層的真實契約（fire-and-forget vs 必須回傳資料），目前在「bug 最貴的邊界」（嵌入頁面內）完全沒被強制。把一整類 runtime dispatch bug 變成編譯錯誤。

---

## B. 執行期與終端使用者（Runtime / End-user）

### ⭐ 5. 多步計畫預覽 + 逐步確認
- **要解的痛**：現在一個 prompt 只選一個工具。「訂 3 點的位子並把 John 加為來賓」需要兩次 tool call，盲目連發等於使用者事後才知道發生什麼。
- **怎麼運作**：執行前，LLM 先產出有序計畫（`[{tool, args, rationale}, ...]`），SDK 在助理 UI 渲染成 checklist widget。使用者可整批核准、inline 改參數、或丟掉某步；SDK 再依序執行 action，並在步驟間**重新拉 page context**，讓第 2 步的參數能依賴第 1 步的結果。
- **為何重要**：終端使用者能在頁面**實際改動之前**看到並操控計畫——當工具會 mutate 真實資料（訂位、下單、送表單）且難以復原時，這是關鍵。也把 onagent 從「單工具/prompt」提升到能處理真實複合意圖。

### 6. 風險分級確認閘門 + Undo
- **要解的痛**：現在每個 tool call 都以同等信心執行，不管是「highlight 這個欄位」還是「取消訂閱」。開發者無法說「這個要人工複核」。
- **怎麼運作**：工具 schema 加 `risk: low | confirm | destructive` 欄位（且**後端強制**：`confirm` 工具需要 client 端 ack token 才算執行）。`confirm`/`destructive` 工具，SDK 攔截 LLM 選好的呼叫，顯示原生確認卡（「取消 jane@x.com 的訂閱——確定？」，帶**已解析的實際參數**），明確點擊才執行。開發者可選擇為 action 工具註冊配對的 `undo` 工具，執行後 N 秒內顯示「復原」按鈕。
- **為何重要**：把「LLM 能在我網站上呼叫任意程式碼」從**風險**變成**可控光譜**——確認卡顯示真實參數（非模糊描述）讓使用者能攔截誤觸。這是玩具與「法務/風控願意簽字放行」之間的差別。

### 7. 澄清問題作為一等的工具回應
- **要解的痛**：prompt 模糊時（有三個草稿卻說「刪掉那個草稿」），現在的流程逼 LLM 要嘛用猜的（差），要嘛開發者得在每個工具裡手寫消歧邏輯。
- **怎麼運作**：讓任何 tool call 可解析成特殊 `needs_clarification` 回應（而非執行），帶結構化 `options`（直接從 pushed page context 拉，例如三個草稿的標題/id）。SDK 渲染成可點的 chips；使用者的選擇餵回成解析後的參數，原本的 tool call 自動重發。
- **為何重要**：消歧變成平台原語而非 per-tool 樣板，終端使用者得到「點一下回答」而非「重打一個更明確的 prompt」。

### 8. Query 工具串流 + 部分結果
- **要解的痛**：query 工具現在阻塞 LLM 直到頁面回傳資料——快速查詢還好，但慢的（大表搜尋、頁面代理的 API 呼叫）就很痛，終端使用者只看到轉圈、不知道到底有沒有在動。（也直接呼應本 session 剛修的 query 工具阻塞架構。）
- **怎麼運作**：擴充 query 工具契約，讓頁面能在終端 `query.result` 之前，於同一組 WS frame 序列送出增量結果（`query.partial`）。SDK 呈現成即時更新的「目前找到 3 筆…」，LLM 可在使用者中斷時選擇基於部分資料行動。
- **為何重要**：把死等時間變成可見進度，在資料密集網站（搜尋、儀表板）讓助理感覺是**跟頁面協作**而非卡在它後面。

---

## C. 平台與信任（Platform / Trust）

### ⭐（並列）9. Conversation & Tool-Call Observatory（對話與工具呼叫觀測台）
- **要解的痛**：開發者把 LLM 嵌進 production 網站，預設**零可見性**——不知道終端使用者實際問什麼、AI 有沒有做對事。這是採用前的**最大阻礙**。
- **怎麼運作**：每個 WS session 記錄 prompt → 選中工具 → 參數 → 執行結果（成功/錯誤/逾時）→ 延遲，keyed by app ID。console 儀表板顯示 per-tool 呼叫量、失敗率、p50/p95 延遲、可搜尋的 transcript（儲存前先做 PII redaction）。附「replay」看特定對話的工具決策。
- **為何重要**：沒人會在沒有事後稽核能力的情況下，把一個自主 tool-caller ship 進自家 production DOM。這與 #2（Trace Inspector）是同一套資料的開發者面 vs 除錯面呈現，可共用底層。也對應審計「建議新增功能」的可觀測性。

### 10. 使用計量 + 每 app 硬性 quota（含 BYO-model-key）
- **要解的痛**：多租戶共用一個 LLM 成本池是計費惡夢也是濫用向量——一個失控（或惡意）的 app 就能把全平台的推論成本/吞吐拖垮（直接對應審計 S2/S6 的 DoS 面）。
- **怎麼運作**：per-app key 計量 token-in/out 與 tool-call 數，滾成月度用量，開放分級（免費試用 → 用量計費 → 承諾量）。硬性 quota（每日 token 上限、最大並發 session）在 **WS gateway 就擋掉**、還沒到 orchestrator，並給 SDK 可攔截的 `quota exceeded` 事件。搭配 **BYO-model-key**：per-app 設定自帶 provider key，該 app 的推論走開發者自己的帳號，onagent 仍處理 tool-selection、SDK、觀測層，計費從 token 計量轉成平台/seat 費。
- **為何重要**：沒有計量就無法定價、也無法在共用 orchestrator 架構下保護自己不被單一租戶的流量尖峰拖垮；BYOK 讓 onagent 能賣進企業而不必變成昂貴的 token 轉售商，同時給開發者 model 選擇權。

---

## 附註：與現有審計/已知問題的關聯
- **#1**（版本化）直接是 `docs/known-issues-want-dependency.md` / `docs/TODO-want-registry-append-only.md` 記錄的 append-only bug 的**建設性修法**。
- **#2 / #9**（Trace Inspector / Observatory）呼應審計「建議新增功能」第 1 項（可觀測性），且本 session 手動追 `tmp/logs` 的除錯過程正是它們要取代的。
- **#8**（query 串流）與本 session 剛修的 query 工具阻塞架構（`ws/session.go` 的 goroutine 分派）相關。
- **#10**（quota/rate limit）對應審計 S2/S6 的 DoS 與濫用面。

**其他被納入但未進前 10 的構想**（來自三個 brainstorm，可作後續參考）：Playground Scenario Recorder / `onagent test` 回歸測試、工具選擇準確度的自動 regression eval、Tool Description Linter（同名工具語意重疊偵測）、Origin-Scoped 本機預覽 snippet（首次上手 <1 分鐘跑起來）、Tool Template Marketplace、Session Memory + 主動 nudge、Rich Context（DOM/accessibility tree + context delta）、PII redaction 與資料留存控制。
