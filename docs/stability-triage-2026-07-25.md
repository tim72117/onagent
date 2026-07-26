# 穩定性優先處理清單（2026-07-25）

> 產出方式：三個 Opus subagent 分別扮演**工程師**、**架構師**、**測試專家**，各自從自己的專業角度
> 對同一批已驗證事實做穩定性 triage，並被要求彼此交叉檢視。本文件整合三方清單，以「三方共識強度」
> 為主要排序依據——多個角色獨立點名的項目，共識訊號最強、最該先做。
>
> **當前優先目標（使用者指定）**：① 觀測使用者狀態　② 確保核心功能（連線 → prompt → 推論 →
> 派發工具到頁面 → 回傳答案）穩定運作。其他改良（含併發重構）暫緩。

---

## 為什麼「先觀測、後併發」有技術理由，不是保守

原本規劃的「每個 session 一個獨立 orchestrator」被兩個硬事實擋住，三個角色一致確認：

1. **`want` 的 orchestrator 沒有 `Stop()`/`Close()`**——`Start()` 開的 `for cmd := range activationQueue`
   goroutine（`want@v0.1.0/orchestrator/orchestrator.go:154`）沒有關閉路徑，channel 永不關閉。每 session
   一個 orchestrator = goroutine 洩漏，且 `want` 沒提供任何回收手段。
2. **`want` 的 LLM provider 是 process 全域單例**（`GlobalEngine`）——`SetupWith` 每次呼叫都會覆寫它
   （`want@v0.1.0/orchestrator/init.go:47`），且內建 `RequestQueue(1, 100ms)` 寫死並行為 1。天真地建 N 個
   orchestrator 會讓**最後一個的 provider 設定蓋掉全部**，是正確性 bug 而非只是效能問題。

架構師的定論：這條併發改造是「want-BLOCKED」——必須先在 `want` 上游加 `Stop()` + 可設定的 engine/queue
才能安全執行；而且**在觀測能力（下方 #1）建立之前，你根本無法驗證併發改造有沒有生效**。所以觀測項
理應排在天花板項之前。

---

## 🔴 三方全數點名（最強共識，最該先做）

### 1. 結構化 JSON 日誌 + session/app 關聯 ID
- **三方點名**：工程師 #1、架構師 #3、測試 #7
- **問題**：`main.go:86` 用 `slog.NewTextHandler`，Cloud Logging 看不到 severity，每個 `log.Error`
  （`session.go:120`、`main.go:301`）都變成無法查詢的 INFO 字串團。**這是所有其他觀測能力的前提**——
  沒有結構化欄位，quota fail-open 警告、inference 錯誤、"tool_result with no pending caller"
  （`session.go:311`）全都無法查詢、無法告警。
- **做法**：換成 `slog.NewJSONHandler`，把帶 `session`/`app` 屬性的 logger 貫穿 `NewSession`。
- **成本**：約 0.5 天。**這是本清單投報率最高的一項——是後面所有觀測項的地基。**

### 2. `/healthz` 必須真的檢查 DB
- **三方點名**：工程師 #5、架構師 #4、測試 #6
- **問題**：`main.go:261` 無條件回 200。DB 掛掉時，quota 檢查全部 fail-open（見 #4）、auth 壞掉，但
  load balancer 仍把流量導向這個壞掉的 instance。**一個永不失敗的 liveness probe 比沒有還糟。**
- **做法**：帶短逾時的 `conn.PingContext`；另可加 `/readyz` 區分 liveness 與 readiness。
- **成本**：約 2 小時。**今天就能做。**

### 3. 斷線時取消進行中的推論
- **三方點名**：工程師 #2、測試 #4（disconnect-mid-dispatch）、架構師（#10 相關）
- **問題**：`handler.go:162` 把 HTTP request context 交給 `NewSession`，但 `session.go:87` 的讀取迴圈在
  客戶端斷線時從不取消它；`handlePrompt` 又把它直接傳給 `Complete`（`session.go:255`）。因為 `Complete`
  持有全平台唯一的 `s.mu`（`want.go:100`），**一個關掉的分頁會鎖住整個平台唯一的推論槽長達 90 秒**
  （`completeTimeout`，`want.go:63`）。這是核心路徑最脆弱的一點。
- **做法**：在 `run` 裡衍生一個可取消的 ctx，`ReadMessage` 出錯時取消它。
- **成本**：約 0.5 天。

### 4. quota fail-open 要可觀測、可告警
- **三方點名**：工程師 #7、架構師 #9、測試 #5
- **問題**：`handler.go:149` 與 `session.go:247` 在任何 DB 錯誤時 log-and-allow，發放無限免費推論。搭配
  純文字日誌（#1），這些完全隱形——**一次 DB 分區會靜默變成無上限的免費 LLM 開銷**。
- **做法**：每次 fail-open 發一個獨立、可告警的 counter/事件；可考慮 circuit breaker。
- **成本**：約 0.5 天（做完 #1 後大多是順手）。

---

## 🟡 兩方點名或單方高信心（次優先）

### 5. 核心路徑的端到端整合測試（mock LLM → 派發 → 假 asker → 結果）
- **點名**：測試 #1（最高優先）、架構師與工程師都承認核心路徑零驗證
- **問題**：整條主幹 `handlePrompt → Complete → forwardingTool/queryTool.Call → askPage → AskInteraction
  → channel 往返`（`session.go:209-289`、`agent_roles.go:204-273`）**零覆蓋**，所有架構宣稱只活在散文註解裡。
- **做法**：用 `want` 的 `MockProvider` 腳本化一個 `tool_use`，包一個 `WantService`，用假的
  `InteractionAsker` 取代 `ws.Session`。斷言：腳本化的 tool_use 真的帶著正確名稱/參數抵達 asker、答案流回。
- **⚠️ 已知限制**：`MockProvider`（`mock.go:56`）**忽略傳入的工具宣告**，所以這個測試能證明「派發管線
  可運作」，但**無法驗證「LLM 看到的是正確/更新後的 schema」**——後者只能在資料層測（`agent_roles_test.go`
  已覆蓋）。兩者是互補的兩半，缺一不可。
- **成本**：中到大。

### 6. 核心路徑的指標端點（counters + latencies）
- **點名**：工程師 #6、架構師 #3
- **問題**：完全沒有任何指標。「產品現在對使用者到底能不能用」這個問題無法回答。
- **做法**：至少涵蓋——活躍 WS session 數、in-flight prompt 數、`Complete` 延遲分佈、inference 逾時次數、
  `interactionTimeout` 觸發次數、quota 拒絕次數。這是觀測目標的骨幹。
- **成本**：約 1 天。

### 7. CI 部署前加 `go test`/`go vet`/`go build` 關卡
- **點名**：測試 #3
- **問題**：`deploy-cloudrun.yml:41-74` 是 tag → build → `gcloud run deploy`，**沒有任何測試/vet/lint 步驟**。
  即使剛加的 `agent_roles_test.go` 也擋不下壞掉的部署——目前所有測試都是裝飾用的。
- **做法**：加一個帶 postgres service container 的 job 跑 `go vet ./... && go test -tags integration ./...`，
  deploy job `needs: test`。
- **成本**：小。**一個 job step 就能讓這裡寫的每個測試變成真正的回歸防線。**

### 8. `askers` map 加 TTL/eviction，並用它當「活躍 session」觀測訊號
- **點名**：工程師 #4、架構師 #2（結構性）
- **問題**：`interaction.go:36` 是 process 全域 map，只在 `run` 的 defer（`session.go:76`）反註冊。漏掉一次
  defer 就洩漏一筆，導致 query tool 的 `askPage`（`interaction.go:90`）觸達死掉的 session、阻塞到逾時。
- **做法**：加關閉追蹤/eviction，並輸出一個「活躍 asker 數」gauge（順帶就是便宜的活躍 session 觀測訊號）。
- **架構師補充**：這個 map 是 process-local 的事實，讓後端**在架構上就無法水平擴展**——跑兩個 pod 時，
  推論落在 pod B 的 query tool 無法觸達連在 pod A 的瀏覽器。長期要移到共享匯流排（如 Redis）。
- **成本**：TTL 約 0.5 天；水平擴展的完整解是大工程。

### 9. 在 admin console 呈現即時 session/錯誤狀態
- **點名**：工程師 #8
- **問題**：`adminconsole.go:34` 目前只有 users/plans/integrity，**沒有活躍 session、in-flight prompt、
  近期錯誤的檢視**。而「觀測使用者狀態」正是明確的優先目標。
- **做法**：加一個 `/admin/api/live`，後面接 #6/#8 的 gauge。
- **成本**：約 1 天（依賴 #6）。

### 10. 補齊 integrity check 缺漏的關鍵不變量 + 為它本身寫測試
- **點名**：測試 #8
- **問題**：`integrity.go` 涵蓋 4 個不變量，但**漏了跟即時路徑最相關的**：`owner_id` 指向不存在使用者的
  usage_events、以及溜過 idempotency 的重複 `(app_id, event_id)`（`quota.go:120`）。更關鍵的是
  `CheckIntegrity` **自己沒有測試**——一個壞掉的查詢會讀成「0 = healthy」（`integrity.go:103`），正是這個
  檔案自己警告的靜默失敗模式。目前唯一的「觀測使用者狀態」介面本身可能會說謊。
- **做法**：為每個查詢寫「餵一筆違規資料，斷言它被抓到」的測試；補上缺漏的兩個不變量。
- **成本**：小到中。

---

## 建議執行順序

**今天就做（便宜、onagent 單獨可完成、讓一切變得可見）**：
→ #2（healthz 檢查 DB）→ #1（結構化日誌）→ #4（fail-open 可觀測）

**接著（把觀測骨幹建起來，並用測試把核心釘住）**：
→ #6（指標）→ #7（CI 關卡）→ #5（端到端測試）→ #3（斷線取消）→ #8（asker TTL）

**依賴前面的觀測基礎**：
→ #9（admin 即時狀態）→ #10（integrity 補洞）

**明確暫緩（want-BLOCKED，需上游先加 `Stop()` + engine-per-orchestrator）**：
併發重構（每 app / 每 session 一個 orchestrator）、水平擴展（interaction bridge 移到共享匯流排）、
對話記憶持久化（`GlobalSessionStorage` 換成可插拔儲存）。這些在 #1 的觀測能力就緒前無法安全驗證。

---

*三方共識最強、且應最先動手的兩件事：**#1 結構化日誌**（所有觀測的地基）與 **#2 healthz 檢查 DB**
（最便宜的真實健康訊號）。兩者都是 onagent 單獨可完成、當天可上線，且是後續所有項目的前提。*
