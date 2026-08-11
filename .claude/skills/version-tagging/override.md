# version-tagging skill override：onagent 專案專屬規則

`.claude/skills/version-tagging` 是跨多個 repo 共用的通用 skill，其「破壞性變更」判準（公開符號被移除/改名/簽名變更，即為破壞性）預設情境是「別人會把你的程式碼當 library import」。這份檔案只補充/覆寫 onagent 這個專案適用的部分，不修改共用 skill 本體，避免污染其他 repo。

## 為什麼需要 override

onagent 是應用型 SaaS，不是被其他 repo import 的 library：`internal/*` 底下的 package 全部受 Go 語言層級保護，物理上不可能有這個 module 以外的程式碼 import 它們。對這類專案，直接套用「公開符號簽名變了就算破壞性」會系統性判斷過嚴——`internal/*` 裡的簽名變更（例如把某個建構子的參數型別從 `*sql.DB` 換成 `*gorm.DB`）不可能影響任何外部呼叫方，因為不存在這種呼叫方。

## 核心問題

判斷破壞性變更，不要看「這行程式碼改了多少」，而是問：**舊版本的使用者，在完全沒改自己程式碼/設定的情況下升級，會不會壞掉或行為突然不一樣？** 只要答案是「會」，不管改動規模大小，都算破壞性；只要答案是「不會」，即使 Go 編譯器角度看是「公開符號簽名變了」，也不算。

真正的判準是「有沒有一個**外部依賴此介面的東西**會因此壞掉」——這個介面可以是函式簽名、CLI 旗標、HTTP endpoint，也可以是一個設定檔欄位。semver 正式定義只精確覆蓋「有公開 API 的東西」，但實務上這個邏輯類推到所有會被別人依賴的介面。

## 依軟體型態的判斷

onagent 本身就是好幾種型態的組合，各部分要分開判斷：

**`@onagent/bridge`（函式庫/SDK，會被第三方 `npm install`）**
- 公開函式、類別、方法被移除或改名
- 函式簽名變了（參數順序、型別、必填/選填改變）
- 回傳值的型別或結構改變
- 例外/錯誤的拋出時機或類型改變

**onagent CLI（CLI 工具）**
- 移除或改名既有的旗標/參數
- 預設行為改變（例如某個旗標的預設值從 `false` 變 `true`）
- 輸出格式改變到會讓下游 script 解析失敗（例如把純文字輸出改成 JSON）

**backend 的對外 HTTP/WebSocket API（Web API / 後端服務）**
- 移除或改名 endpoint、欄位（含 `internal/protocol` 序列化出去的 JSON 形狀——即使套件路徑在 `internal/` 底下，其序列化結果就是跟 SDK/第三方之間的實際合約）
- 改變 request/response 的 schema（拿掉一個回應欄位、必填欄位變了）
- 改變 auth 機制（例如 `ALLOWED_ORIGIN` 如果哪天改成預設拒絕而非預設允許，就是破壞性）

**設定/部署**
- 環境變數、CLI 參數改名或移除，且原本的值會被靜默忽略而非報錯（例如 `OLLAMA_URL`——目前判斷不算破壞性，因為從未在任何實際部署中真正生效過；但如果它曾經有人依賴，移除就會是破壞性）
- 資料庫 schema 變更，且沒有向下相容的遷移路徑（改名/刪除既有欄位、改變既有欄位型別或 nullable 性算；單純新增欄位或新增索引不算，因為那是 `CREATE ... IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` 這種相容式演進）
- 部署行為改變（例如某個原本會啟動失敗的情境變成警告後繼續跑，或反過來）

**不算破壞性**：`internal/*` 套件之間彼此呼叫的函式/建構子簽名變更、純內部重構、`cmd/*` 內部不可見的型別變更——這些完全不在上面任何一個外部依賴得到的介面清單裡，不管 Go 編譯器角度看簽名變了多少。

## 範例

v0.3.0 把 `internal/db.Open` 回傳型別從 `*sql.DB` 改成 `*gorm.DB`，並連動改了 7 個 `internal/*` 套件建構子的參數型別——這在 library 判準下是破壞性，但在本專案的 override 判準下**不是**，因為它沒有改變 `DATABASE_URL` 的用法、沒有改變任何對外 API、schema 只有新增欄位。這類變更應升 **patch**，不是 minor。

## 為什麼 0.x 階段用 minor 承擔破壞性訊號

onagent 目前是 `0.x`（尚未宣告穩定 API），沒有 major 版位可用，所以 `version-tagging` skill 才會建議用 **minor** 位承擔破壞性訊號、**patch** 位給不影響呼叫方式的變動——minor 扛起「這次可能要你自己檢查一下」的警示責任，等專案宣告 1.0 之後才會回到標準 semver 的 MAJOR 位。
