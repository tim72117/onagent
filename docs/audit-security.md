# onagent 安全稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。

---

## 最新掃描：2026-09-04

> 方法：針對「Playground 改用共用 `ws.Session`」這次重構做的針對性複核（非全面重掃）。

### 🟡 `toolschema.Registry` 記憶體快照落後於資料庫，多實例部署下可能讓已刪除 app 短暫通過存在性檢查（新發現）
- **位置**：`backend/internal/ws/handler.go`（`APIKeyResolver.ResolveApp`）＋ `backend/internal/console/playground.go`（`playgroundResolver.ResolveApp`）＋ `backend/internal/toolschema/registry.go`（`Registry.Get`/`OwnerOf`）
- **問題**：`auth.Store.Verify`/`session.Store.Verify` 都是即時查資料庫，但 `toolschema.Registry.Get`/`OwnerOf` 讀的是建構/`Reload` 時載入的記憶體快照，只在該實例自己呼叫 `Save`/`Create`/`Delete`/`Reload` 時才會更新。這代表：若後端跑多個實例（水平擴展），某個實例的 app 被刪除後，另一個尚未 `Reload` 的實例的 `Registry` 快照仍然「認得」這個已刪除的 app。
- **攻擊/失效情境**：app 被刪除的瞬間，若攻擊者手上還有一把該 app **尚未被撤銷**的 API key（`auth.Store` 是即時查詢，key 是否失效跟 app 是否還在 `Registry` 快照裡是兩件事），指向一個還沒 `Reload` 的實例的請求，`APIKeyResolver.ResolveApp`（或 `playgroundResolver.ResolveApp`）的 `Apps.Get`/`OwnerOf` 檢查仍會通過，讓一個「已刪除」的 app 在該實例上短暫繼續可用。窗口大小取決於該實例下次 `Reload` 的時機（若該實例完全沒有其他寫入觸發 `Reload`，理論上窗口可以持續到下次部署重啟）。
- **修法**：`Registry.Get`/`OwnerOf` 改成短 TTL 快取＋定期背景 `Reload`（而非只在寫入時才刷新），或改成 delete 操作透過某種跨實例通知機制（pub/sub、DB LISTEN/NOTIFY）主動觸發所有實例 `Reload`。過渡期至少在文件/註解明確記錄這個假設（「單一實例部署」），避免未來水平擴展時被忽略。
- **狀態**：未修復；是這次補寫 `ws`/`console` 認證測試過程中發現的邊界情況，非本次重構引入的新問題（`APIKeyResolver`/舊版 `ws.Handler.ServeHTTP` 本來就有這個特性），只是首次被記錄下來。

---

## 舊掃描：2026-08-16

> 方法：13-agent workflow（recon → 4 路並行 scan → extract → 對抗式 verify），對比 2026-07-15 版稽核後 71 個 commit 的現況（新增 admin app、quota 系統、`sessionstore`、want v0.4.0）。只列出通過對抗式驗證（confidence ≥ 8/10）的項目；被推翻的候選（WS token-in-URL 重複舊發現、quota fail-open-on-DB-error 屬刻意設計）不列入。

### 本次新確認發現

**🟠 高風險：Quota check-then-act 競態，可無限繞過月額度（confidence 9/10）**
- **位置**：`backend/internal/ws/session.go:262-291`（`handlePrompt`）＋ `backend/internal/quota/quota.go:107-133`（`Check`）、`:150-172`（`Record`）
- **問題**：`Check` 只是單純的 `COUNT(*)`，`Record` 要等 `inference.Complete` 跑完（最長可到 ~90 秒的 `completeTimeout`）才會寫入。兩者之間完全沒有鎖或交易隔離；唯一的唯一性限制是 `(app_id, event_id)`，只防止同一個 RequestID 被重複計數，擋不住不同請求同時讀到「未超額」。
- **攻擊情境**：額度用完 0/10 的使用者，在 ~90 秒推論視窗內開多條 WebSocket 連線或發多個帶不同 RequestID 的 prompt。每個併發請求各自 `Check` 時都看到「未超額」（因為還沒有任何一個 sibling 請求寫回 `Record`），全部放行進真正的 LLM 呼叫——實質上可無限繞過月額度，直接造成計費/成本外洩。
- **修法**：把 check-and-increment 對同一個 owner 做原子化——要嘛用 `SELECT ... FOR UPDATE`（或 `pg_advisory_xact_lock(owner_id)`）把 `Check`+`Record` 包進同一個交易，要嘛改成「先原子扣額度，推論失敗再退回」的模式（atomic conditional UPDATE，`used < limit` 才成功）。純 process-local 的 mutex 不夠，服務若有多個 replica 就無效，須是 DB 層強制的鎖。
- **狀態**：未修復。

### 新增子系統掃描結果

- **`backend/internal/adminauth`**：獨立於開發者帳號的身份系統（自己的表、cookie、bcrypt），無自助註冊端點，只能透過 `ADMIN_BOOTSTRAP_EMAIL/PASSWORD` 環境變數建立第一個帳號。複核無問題。
- **`backend/internal/adminconsole`**：`/admin/api/*` 除了 login/logout 全部走 `withAdmin`，fail-closed。`setUserPlan` 可任意調整使用者方案，目前無額外的操作稽核紀錄（非漏洞，僅記錄供未來考慮）。
- **`backend/internal/quota`**：除了上述 TOCTOU 問題外，其餘（append-only ledger、`ON CONFLICT` 冪等寫入）設計正確。
- **`backend/internal/sessionstore`**：`want` 用的 GORM session store，明確以 `appId` scope（`ForApp`），複核跨 app 洩漏疑慮不成立——讀寫都有 `WHERE app_id = ? AND session_id = ?`。

### 順帶一提

- 公開發布的 `Dockerfile.release` 會把 admin SPA 一併打包進去——任何人拿這個 image 自建部署都會附帶 `/admin`，存取控制純靠 `adminauth` 登入，沒有獨立的 build flag 可以排除它。不算漏洞，但建議確認是否為刻意設計。

---

## 進行中的發現（依嚴重度排序，現況持續更新）

### 🟡 明文 bearer token 無限期停留在 `cli_auth_sessions`（原 improvement-backlog 2026-07-24，併入於 2026-08-16）
- **位置**：`backend/internal/cliauth/cliauth.go`（`Approve`/`Exchange`）
- **問題**：`Approve` 把明文 user token 寫進 `cli_auth_sessions.token` 欄位，只有成功呼叫 `Exchange` 才會清空。若 CLI 端在完成 exchange 前崩潰、或使用者中途關閉分頁，這一列就會留下一個仍然有效的長期憑證，且沒有任何背景清理工作會刪除已過期（`expires_at` 已過）或已使用完的資料列——`sessions`/`admin_sessions` 也是同樣情況，只在讀取時用 `expires_at > now()` 過濾，從不清除。任何資料庫備份、read replica 或 dump 都會把這些活的明文憑證一併帶走。
- **修法**：加一個定期清理 job（開機起一個 goroutine 或排程），定期刪除 `cli_auth_sessions`/`sessions`/`admin_sessions` 裡 `expires_at` 已過或已完成 exchange 的資料列；並補上 `expires_at` 索引。

---

### 🟠 S2. 無任何 rate limit ＋ 單一序列化 orchestrator = 一把 key 就能癱瘓全平台
- **位置**：全 `backend/` 無 rate-limit middleware；`backend/internal/inference/want.go`（per-session orchestrator，但底層 provider `RequestQueue` 仍 `maxConcurrent=1`）；`backend/internal/ws/session.go`（query tool 的 `interactionTimeout` 卡住該次推論，Playground 經 `backend/internal/console/playground.go` 的 `playgroundResolver` 共用同一套 `ws.Session` 機制後，同樣受影響）
- **攻擊情境**：一個免費帳號建一個 app、定義一個 `ToolKindQuery` 工具、開 WebSocket、送出觸發該工具的 prompt，然後永遠不回答 `tool_query`。每一次這樣的呼叫佔用 orchestrator 直到逾時；攻擊者可開無上限的並發 WS 連線（無連線數上限）各自迴圈這樣做，把全平台推論吞吐量壓到零。同樣的觸發方式現在也能透過 Console 自己的 Playground 做到——開發者對自己的 app 定義一個 `ToolKindQuery` 工具、在 Playground 觸發後不回答，一樣能卡住該 session 的 orchestrator（誘因較低，因為是攻擊自己帳號，不構成跨租戶危害，但技術上是同一漏洞的另一個入口）。
- **修法**：per-app 或 pooled orchestrator（見 A1）；過渡期至少加 per-appId/IP 的並發與速率限制、限制每 key/app 的同時 WS 連線數。因為 Agent Bridge SDK 與 Playground 現在共用同一段 `ws.Session` 程式碼，修好一次即可同時涵蓋兩條路徑，不需要分別修。
- **現況（2026-08-16 複核）**：仍未修復。`want.go` 每個 session 已有獨立 orchestrator 物件（物件隔離修好了，見 A1），但套件文件明確寫著底層 `RequestQueue` 仍是 process-wide `maxConcurrent=1`——吞吐量仍全平台序列化，是 `want` 函式庫本身的限制。新增的 `quota` 套件是「每月用量上限」，不是併發/速率限制，無法擋住惡意 `tool_query` 卡住 orchestrator 的情境。

### 🟠 S3. 完全沒有設定任何安全 header
- **位置**：全 `backend/` 無 `Strict-Transport-Security`／`X-Frame-Options`／`X-Content-Type-Options`／`Content-Security-Policy`；`main.go` 的 `recoverMiddleware` 是唯一的全域 middleware，`web.go` 的靜態回應只設 `Content-Type`。
- **影響**：session-cookie 認證的 console SPA（以及新增的 admin SPA）可被 clickjacking（無 `X-Frame-Options`/`frame-ancestors`）；無 HSTS 留下 HTTP 降級窗口（即使 `COOKIE_SECURE=true`，除非 LB 另外補）；無 CSP，缺少對未來 XSS 的縱深防禦。
- **修法**：加一個全域安全 header middleware（包住 `recoverMiddleware` 內外皆可），統一加上 `X-Frame-Options: DENY`（或 `CSP frame-ancestors 'none'`）、`Strict-Transport-Security`（僅正式環境）、`X-Content-Type-Options: nosniff`、`Referrer-Policy`，且要套住 `/app`、`/admin` 的靜態/SPA fallback 路由。
- **現況（2026-08-16 複核）**：仍未修復，且範圍擴大——新增的 admin SPA 現在也暴露在同樣的 clickjacking 風險下。本次複掃已用對抗式驗證正式確認（confidence 8/10）。

### 🟠 S4. API key 以 WS URL query 參數傳輸 — 實際的日誌/歷史外洩
- **位置**：`backend/internal/ws/handler.go`（`r.URL.Query().Get("token")`）＋ `packages/bridge/src/client.ts`（`url.searchParams.set("token", ...)`）
- **影響**：這是刻意的取捨（瀏覽器無法對 WS upgrade 設 header），但「只用 wss://」只保護傳輸線路，不保護 Cloud Run/LB 的 access log（多數預設會記完整 URL）、瀏覽器歷史、Referer 外洩。任何記錄完整 request URL 的存取日誌都會持久儲存明文 API key。SDK 也未在 runtime 強制 `wss://`。
- **修法**：在 Cloud Run/LB 存取日誌層 redact `token` query 參數；SDK constructor 加 runtime 檢查，`apiKey` 有值但 `url` 非 `wss://`（localhost 例外）時大聲警告；長期考慮改用短效、單次 WS ticket（HTTPS 認證後換發、WS 一次兌換）取代長效 key。
- **現況（2026-08-16 複核）**：仍未修復，機制不變。SDK 仍未在 runtime 檢查 `apiKey` 有值但 `url` 非 `wss://` 的情況，僅在 JSDoc 註記。

### 🟡 S6. `createApp` 無每使用者數量上限
- **位置**：`backend/internal/console/console.go`（`createApp`）
- **影響**：任何登入使用者可迴圈 `POST /console/apps` 無限建 app，放大 S2 的 orchestrator 競爭。
- **修法**：server 端限制每使用者 app 數量。
- **現況（2026-08-16 複核）**：仍未修復。

---

## 已複核為「安全」的項目（無需處理）

- **SQL injection：無**。`session`/`auth`/`usertoken`/`cliauth`/`toolschema/registry` 全部用 `$N` 參數化，無字串拼接。
- **CSRF：足夠**。靠 `SameSite` + 嚴格 CORS（`main.go` 只對 `ALLOWED_ORIGIN` 內的 origin 回 credentialed CORS），state-changing 端點都是 JSON POST/PUT/DELETE，需 preflight，非白名單 origin 過不了。前提是 production 的 `ALLOWED_ORIGIN` 維持收緊（已有 fail-fast）。
- **Bearer token 不能自我增生**：`issueToken`/`approveCliAuth` 正確限定 `withCookieAuth`，有註解說明就是防這個。
- **CLI device flow（`internal/cliauth`）**：單次使用、redirect_uri 僅 loopback 且 server 端解析、10 分鐘 TTL、32-byte 隨機 id。無問題。
- **`sanitizeSessionID`**：`^[a-zA-Z0-9_-]{1,128}$`，無 path traversal。
- **codegen public 端點**：只吐 LLM schema 形狀（無 Returns/thought/owner），appId-scoped，可接受。
- **bcrypt cost = DefaultCost(10)**：可接受，可考慮調高（低優先）。
- **admin/adminauth/adminconsole 存取控制**（2026-08-16 新確認）：`withAdmin` fail-closed，獨立身份系統與獨立 cookie，無自助註冊端點。
- **`sessionstore` 跨 app 隔離**（2026-08-16 新確認）：讀寫皆以 `appId` scope，無跨租戶洩漏。

---

## 🟡 日誌內含完整明文對話紀錄（原 project-health-review 2026-07-22，併入於 2026-08-16）
- **位置**：`backend/tmp/logs/*.json`
- **問題**：有 `.gitignore` 保護（不會進 repo），但硬碟上是無限保留、無 redaction、無 rotation 的完整對話與 system prompt 明文。此記錄行為來自 `want` 依賴本身（`want/internal/provider/vllm.go`），非 onagent 自有程式碼，但任何跑這個 backend 的機器都會累積使用者資料，屬營運面資料保存風險。
- **修法**：評估是否需要 redaction/rotation/保留期限政策；若無法在 `want` 層處理，考慮在部署文件明確標註此風險並建議的 log 存放權限設定。

---

## 建議新增功能（安全相關）

1. **Rate limiting / quota**：per-app、per-user、per-IP 的速率與並發限制，含每 key 同時 WS 連線上限（直接對應 S2/S6）。
2. **短效 WS ticket**：取代長效 API key 直接進 URL（對應 S4）——HTTPS 認證後換發單次 ticket、WS 一次兌換。
3. **Quota check-and-record 原子化**（對應本次新發現）。
4. **全域安全 header middleware**（對應 S3）。
5. **對話日誌 redaction/rotation 政策**（對應上方新併入項目）。
