# 產品構想與待討論項目（持續追蹤）

> 這份文件持續追蹤尚未拍板方向的產品構想，不限定單一主題，不帶日期，每次新發現/進展都直接更新對應項目，不新增日期章節。跟已確認的程式碼缺陷/架構債不同——那些記在 `docs/audit-functional.md`（`docs/audit-security.md`/`docs/audit-stability.md` 分別收安全性、並發/穩定性面向），這份檔案只收「尚未拍板方向」的構想層級內容。

## Tool 定義簡化設定（構想，尚未拍板）

目前建立 tool 定義只能用兩種方式：console 網頁的 tool 編輯器手動輸入，或撰寫本機單一 tool 的 YAML 檔用 `onagent tool create` 推送——兩者都要求使用者自己寫出完整的 JSON Schema（`name`/`description`/`parameters`/`properties` 等），對不熟悉 JSON Schema 的使用者有門檻。

（本節寫成時 CLI 指令仍叫 `save-tools`，已隨 CLI 指令樹重構改名為 `tool create`，且語意從整批覆蓋一個 app 的所有 tools 改成單一 tool 的 upsert——不影響這裡的構想方向本身。）

構想方向：新增一種對話式引導建立 tool 的方式，作為現有兩種方式（console 手動編輯、YAML + CLI）之外的第三種選項，不取代、也不影響 YAML + `onagent tool create` 這條既有路徑——依序詢問使用者這個工具的用途、類型、可能的參數有哪些、參數類型，由介面（可能搭配 LLM）幫使用者組出完整的 tool 定義，不需要使用者自己寫 JSON Schema。

（這個構想已實作為 AI Tool Builder——console 的「Generate with AI」流程，見 `apps/console/src/aiToolGenerator/aiToolGenerator.ts`/`AiToolGeneratorSheet.tsx`，其 onagent app 的 tool 定義（`tool-builder-tools.yaml`）也在同一個目錄下。設計文件已刪除，per-user provisioning、從 app 清單隱藏等尚未完成的部分見這兩個檔案的註解。這個功能本身曾經完全不能用（`tool_call`/`tool_query` 訊息類型不匹配）及其協定邏輯重複實作的架構債，記在 `docs/audit-functional.md`，不重複收錄於此。）

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
