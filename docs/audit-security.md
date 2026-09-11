# onagent 安全稽核報告

> 嚴重度標記：🔴 critical｜🟠 high｜🟡 medium｜⚪ low
>
> 格式慣例：每次新掃描把「最新掃描結果」整段換成新的一份，放在檔案最上方；沿用中的舊發現直接在原本的項目上更新現況（不新增重複區塊），已修復的項目移到「已解決」。

---

## 最新掃描：2026-09-11

> 方法：6 個並行 agent 分面向全專案掃描（後端核心邏輯、auth/quota/session、並發穩定性、安全、console 前端、SDK/協定一致性），每個 agent 要求「必須讀過實際程式碼、必須給出具體攻擊路徑」才能提報；主 session 再對每一項高嚴重度發現親自讀碼複核，剔除無實際利用路徑者。本節只列安全類發現。

### 🔴 `BackendDispatch.Endpoint` 未做任何目標位址驗證，任何已登入使用者可對後端內網發動 full-read SSRF（2026-09-11 新發現）

- **Sink**：`backend/internal/inference/backend_dispatch.go:107`（`http.NewRequestWithContext(ctx, POST, config.Endpoint, ...)`）、`:113`（`http.DefaultClient.Do` — 預設會跟隨 redirect）、`:119`（讀回上游 body，上限 1MiB）、`:125`（非 2xx 時把 `string(respBody)` **原文**包進 error 回傳）
- **Source**：`backend/internal/console/console.go:658` `saveTool` / `:704` `saveToolByID`，`decodeJSON` 直接解出整個 `toolschema.Tool`（含 `BackendDispatch.Endpoint`）
- **唯一驗證**：`backend/internal/toolschema/loader.go:111-113` — **只檢查 `Endpoint != ""`**（已複核確認），無 scheme allowlist、無 host/IP 過濾、無 redirect 限制
- **攻擊路徑**：(1) 攻擊者自行註冊帳號（`POST /auth/register` 無審核）並建立自己的 app；(2) `PUT /console/apps/{myApp}/tools/leak` 帶 `backendDispatch.endpoint` 指向 `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token`——因為 app 確實是他自己的，`withOwnedApp` 正常放行，`Validate()` 只看非空；(3) `toolFactoryFor`（`agent_roles.go:181`）因 `BackendDispatch != nil` 優先選 `backendDispatchTool`；(4) 攻擊者開自己 app 的 Playground 送 prompt 誘導 LLM 呼叫該工具；(5) 請求**從後端自己的網路位置**發出，回應 body 經 `EmitToolResult`／`TextBlock` 進入 LLM context 再回到攻擊者畫面，即使非 2xx 也會由 `:125` 的 error 字串原文回傳。
- **影響**：`docs/deployment.md` 確認正式環境跑在 Google Cloud Run，`169.254.169.254` metadata server 可達 → 可取得 service account 的 OAuth access token 與專案 metadata，橫向移動到該 SA 有權限的所有 GCP 資源（Artifact Registry、Secret Manager、Cloud SQL…）；亦可掃描/讀取任何內網服務。
- **與既有 PoC 註解的區別**：`toolschema/schema.go:70-73` 只承認「no request signing/auth — 不要指向你自己不信任的 endpoint」，那是對**開發者自己**的告誡，前提是 endpoint 由可信的 app 擁有者設定；完全未涵蓋「任意註冊使用者把它指向 onagent 自己的內網」這個平台自身被攻擊的面向，因此屬於超出既有 doc comment 範圍的可利用漏洞。
- **修法**：(1) `Validate()` 強制 `Endpoint` 為 `https://` 且解析後必須是 public unicast IP（拒絕 loopback／link-local `169.254.0.0/16`／RFC1918／CGNAT／`::1`／ULA／`0.0.0.0/8`）；(2) `dispatchBackend` 改用專屬 `http.Client`，`CheckRedirect` 拒絕跨 host redirect，並於 `DialContext` 的 `Control` hook 再驗一次目標 IP（防 DNS rebinding／TOCTOU）；(3) `:125` 不要回傳上游 body 原文，只回 status code。

### 🔴 空 `requestId` 完全繞過計費，quota 可無限制突破（2026-09-11 新發現）

- **位置**：`backend/internal/inference/want.go:288`（`if s.quota != nil && req.RequestID != ""`）；值來源 `backend/internal/ws/session.go:321`（`RequestID: env.RequestID`），型別定義 `internal/protocol/message.go:59`（`json:"requestId,omitempty"`）
- **問題**：`quota.Record` 是 `usage_events` 的**唯一**寫入者，而它被 `req.RequestID != ""` 這個條件擋住。`RequestID` 100% 由客戶端透過公開 WebSocket 提供，`handlePrompt` 全程**沒有任何非空驗證**（已複核：該函式只驗 payload JSON 與 `app != nil`）。`quota.Check`（`quota.go:141`）以 `SUM(total_tokens)` 計算 `used`，沒有列就永遠是 0，`used < limit` 恆真。
- **攻擊路徑**：以合法 API key 建立 WS 連線後，送 `{"type":"prompt","payload":{"text":"..."}}` 但**省略 `requestId` 欄位**（`omitempty` 使其為空字串）。推論正常執行並回傳結果，但 `want.go:288` 判定為 false，不寫任何 usage 列。無限重複即可在零記錄用量下消耗無上限的真實 LLM 花費；兩個 enforcement point（`ws/handler.go:182` 握手、`ws/session.go:307` 每 prompt）都只會看到 `Used: 0`。
- **附帶影響**：admin `/admin/api/users` 與開發者 `/console/quota` 兩個監控介面也都顯示 0，這個繞過在所有監控面向上**完全隱形**。
- **修法**：`handlePrompt` 對空 `RequestID` 的 prompt 直接回覆 coded 協定錯誤；或 `WantService.Complete` 在 `req.RequestID == ""` 時自行產生 server-side fallback id 並無條件記錄。`event_id` 已被明文記載為「僅供稽核、不再是 dedup key」（`quota.go:196-205`），所以當初「空 id 就跳過」的理由已隨 `ON CONFLICT` 設計一併移除，用 server 端產生的 id 記錄嚴格優於不記錄。

### 🟠 `cliauth.Exchange` 漏掉 `expires_at` 檢查，已核准未領取的明文 token 可無限期重放兌換（2026-09-11 新發現）

- **位置**：`backend/internal/cliauth/cliauth.go:121-138`（`Exchange`）
- **問題**：本套件三個查詢裡唯一漏掉過期檢查的一個——`NameFor`（`:85`）與 `Approve`（`:105`）都有 `expires_at > ?`，`Exchange`（`:125`）的 `Where` 卻只有 `id = ? AND approved = ? AND token IS NOT NULL`。而 `cli_auth_sessions.token` 存的是 `usertoken.Issue` 回傳的**明文 bearer token**（非 hash），`user_tokens` 表本身**無 expiry 欄位**、`usertoken.Verify` 也不檢查任何到期時間，且全 repo 沒有任何清理 job 會刪除過期列。
- **攻擊路徑**：使用者跑 `onagent login --web` 並在瀏覽器點核准（此時 token 已鑄出並寫入 DB），但 CLI 在 `Exchange` 前掛掉／使用者關掉分頁／網路中斷 → token 留在 DB。10 分鐘 TTL 過後 session 名義上已過期，但 `POST /console/cli-auth/{id}/exchange`（**未認證端點**，`console.go:210`）仍然成功回傳該明文 token。任何取得該 id 的人（DB backup、read replica、log、瀏覽器歷史中 redirect URL 上的 `?code=<id>`）可在任意時間後兌換出受害者的完整帳號 bearer token。
- **與既有記錄的區別**：既有稽核記的是「明文 token 無限期滯留」這個**資料滯留**風險（DB dump 面向）；這裡指出的是 `Exchange` **查詢條件本身漏了過期檢查**，讓一個對外開放的未認證 HTTP 端點可被無限期重放——TTL 的安全保證在此路徑上形同虛設。
- **修法**：`Exchange` 的 `Where` 補上 `AND expires_at > ?` 與 `NameFor`/`Approve` 一致；並補上定期清理 job（或至少在兌換後清空 `token` 欄位）。

### 🟡 `interaction.go` 的安全假設與實作不符，Playground 的 query tool 實際可達（2026-09-11 新發現）

- **位置**：`backend/internal/inference/interaction.go:65-79`（`AgentIDToSessionID` doc comment）vs `backend/internal/inference/want.go:206`（`orch.AgentID = "WS-" + key`）、`backend/internal/ws/session.go:118`（`RegisterAsker(s.id, s)` 無條件執行）
- **問題**：註解明確寫「Playground 的 `PG-<userID>-<appID>` session 從不註冊 asker，所以 query tool 從 Playground 呼叫會正確地失敗」。但 `want.go:206` **無條件**加 `"WS-"` 前綴，Playground session 的 AgentID 是 `WS-PG-42-myapp`，剝掉 `WS-` 正好得到 `PG-42-myapp`——就是 `RegisterAsker` 使用的 key。**askPage 在 Playground 完全可以成功。**
- **影響**：本身不構成直接越權（`askers` 的 key 內嵌呼叫者自己的 userID，碰不到別人的 session），但這是一個**被文件標示為「已關閉」、實際上開著的攻擊面**：既有稽核 S2 記載的「用 `ToolKindQuery` 不回答來卡住 orchestrator」在 Playground 這條路徑上，文件說不成立、實際成立。任何依據這段註解做的安全判斷都是錯的。
- **修法**：擇一並讓文件與程式碼一致——要嘛修正註解並據此重新評估 S2 的適用範圍，要嘛讓 `askPage` 對 `PG-` 前綴明確拒絕。

### 本次複核為安全、無須處理

- **SQL injection：無**。全 repo 只有 `registry.go:386`、`:455` 兩處 `Raw`，皆為 `?` 參數化常數字串；其餘走 GORM builder，無任何 `fmt.Sprintf` 拼接 SQL。
- **Path traversal：無**。`sessionKeyFor`（`want.go:349`）限制 `^[a-zA-Z0-9_-]{1,128}$`；`ValidAppID` 排除 `/`、`..`、前導點；`web.go` 的 SPA fallback 走 `fs.FS`（自帶 `..` 防護）。
- **Command injection：無**。唯一的 `exec.Command`（`cmd/onagent/main.go:433-437`）第一參數為常數，URL 作為獨立 argv 元素，未經 shell。
- **端點 ownership 對照**：逐一比對 `console.Register`（`console.go:137-211`）每條路由——所有 `{appId}` 路由皆在 `withOwnedApp` 後；`/console/quota`、`/console/tokens*` 無 `{appId}` 但各自以 `user.ID` scope。`adminconsole.Register` 除 login/logout 外全數 `withAdmin`。未發現任何一條路由漏掉鄰居都有的檢查。
- **Playground Public app 跨租戶隔離：正確**。`ownedOrPublicApp` 放行非擁有者，但 sessionID 為 `PG-<自己的userID>-<appID>`，`sessionstore` 又以 `(app_id, session_id)` 雙重 scope，訪客讀不到擁有者的對話；quota 亦已正確 bill `user.ID`。
- **Timing-unsafe 比較：無**。`auth.Verify`/`usertoken.Verify` 先 SHA256 再送 DB 索引等值查詢；密碼走 `bcrypt.CompareHashAndPassword`（本身 constant-time）。
- **Google OAuth**：state cookie CSRF 防護（`googleauth.go:169`）、`idtoken.Validate` 驗簽 + audience（`:207`）、`email_verified` 檢查（`:219`）三項齊備。

---

## 舊掃描：2026-09-05

> 方法：針對本次請求範圍（`backend/internal/auth/`、`backend/internal/session/`、`backend/internal/ws/`、`backend/cmd/server/main.go`）做的機密資料處理與傳輸安全定向複核——API key/token 產生與比對方式、cookie 屬性、CORS/Origin 檢查、WebSocket 升級流程。單一 agent 人工逐檔複核，非多 agent 對抗式驗證。

### 複核結論：未發現本次範圍內的新漏洞

逐項複核結果如下，均與既有記錄一致或確認安全，**沒有新增發現**：

- **API key/token 產生**：`auth.randomKey`（32 bytes）、`session.randomID`（32 bytes）、`ws.randomID`（16 bytes）均用 `crypto/rand`，熵足夠，非弱隨機性。
- **API key/token 儲存**：`auth.Store`（apps.api_key_hash）、`usertoken.Store`（user_tokens.token_hash）皆只存 SHA256 hash，明文不落地；`session.Store`/密碼走 bcrypt（`DefaultCost`）。無明文儲存問題。
- **API key/token 比對方式**：`auth.Verify`/`usertoken.Verify` 都是「先 SHA256 hash 再送資料庫做索引等值查詢」，不是對明文做逐字元比較，時序攻擊面已由 hash 轉嫁到雜湊值等值比對（不透過使用者可控的 Go 迴圈），可接受，非漏洞（`auth.go:99` 的既有註解已說明此設計取捨）。
- **Cookie 設定**（`session.go` `CreateSession`/`Logout`）：`HttpOnly: true` 固定開啟；`Secure` 隨 `COOKIE_SECURE`／`APP_ENV=production` 走 fail-fast（`main.go:161-167`）；`SameSite` 依 `Secure` 動態選 `None`（要求 Secure）或 `Lax`（`sameSite` 函式），符合瀏覽器對 `SameSite=None` 必須搭配 `Secure` 的要求，機制正確。
- **CORS/Origin 檢查**：`corsMiddleware`（`main.go:457-475`）只在 origin 落在傳入的 allowlist 時才回填 `Access-Control-Allow-Origin`（且只回填成該實際 origin，從不回 `*`），三組 allowlist（`/console`+`/auth`、`/admin`、APP_ORIGINS）分別呼叫互不共用，符合既有 `TestCORSMiddleware_TrustsOnlyItsOwnAllowlist`/`TestMountCredentialedRoutes_WiresEachPrefixToTheSameAllowlist` 測試斷言。未發現遺漏路由或繞過路徑。
- **WebSocket 升級**：`ws.Handler.CheckOrigin`（`handler.go:170-188`）在 `Resolver != nil` 時無條件回 true，但兩個目前存在的 `AppResolver` 實作（`APIKeyResolver`、`playgroundResolver`）都各自在 `ResolveApp` 內做了 Origin 檢查，符合 Handler 文件註解「Resolver 必須自己做 Origin 檢查」的約定；且 `ResolveApp` 在 `Upgrade()` 之前執行、失敗直接 `http.Error` 回應，不會先升級再拒絕。`APIKeyResolver.ResolveApp`（`handler.go:119-127`）採用「app 未設定 allowedOrigin 就整個 fail-closed」而非「無限制放行」，也是正確方向。

### 對已知問題的當前狀態複核（非新發現，僅確認現況不變）

以下四項在本次範圍內複核後，狀態與 2026-08-16 記錄的一致，仍未修復；具體內容見下方「進行中的發現」，不在此重複：S2（無 rate limit）、S3（無安全 header）、S4（API key 走 WS URL query 參數）、quota check-then-act 競態。

### 🟡 `toolschema.Registry` 記憶體快照落後於資料庫，多實例部署下可能讓已刪除 app 短暫通過存在性檢查
- **位置**：`backend/internal/ws/handler.go`（`APIKeyResolver.ResolveApp`）＋ `backend/internal/console/playground.go`（`playgroundResolver.ResolveApp`）＋ `backend/internal/toolschema/registry.go`（`Registry.Get`/`OwnerOf`）
- **問題**：`auth.Store.Verify`/`session.Store.Verify` 都是即時查資料庫，但 `toolschema.Registry.Get`/`OwnerOf` 讀的是建構/`Reload` 時載入的記憶體快照，只在該實例自己呼叫 `Save`/`Create`/`Delete`/`Reload` 時才會更新。這代表：若後端跑多個實例（水平擴展），某個實例的 app 被刪除後，另一個尚未 `Reload` 的實例的 `Registry` 快照仍然「認得」這個已刪除的 app。
- **攻擊/失效情境**：app 被刪除的瞬間，若攻擊者手上還有一把該 app **尚未被撤銷**的 API key（`auth.Store` 是即時查詢，key 是否失效跟 app 是否還在 `Registry` 快照裡是兩件事），指向一個還沒 `Reload` 的實例的請求，`APIKeyResolver.ResolveApp`（或 `playgroundResolver.ResolveApp`）的 `Apps.Get`/`OwnerOf` 檢查仍會通過，讓一個「已刪除」的 app 在該實例上短暫繼續可用。窗口大小取決於該實例下次 `Reload` 的時機（若該實例完全沒有其他寫入觸發 `Reload`，理論上窗口可以持續到下次部署重啟）。
- **修法**：`Registry.Get`/`OwnerOf` 改成短 TTL 快取＋定期背景 `Reload`（而非只在寫入時才刷新），或改成 delete 操作透過某種跨實例通知機制（pub/sub、DB LISTEN/NOTIFY）主動觸發所有實例 `Reload`。過渡期至少在文件/註解明確記錄這個假設（「單一實例部署」），避免未來水平擴展時被忽略。
- **狀態**：未修復；是這次補寫 `ws`/`console` 認證測試過程中發現的邊界情況，非本次重構引入的新問題（`APIKeyResolver`/舊版 `ws.Handler.ServeHTTP` 本來就有這個特性），只是首次被記錄下來。

---

## 舊掃描：2026-08-16

> 方法：13-agent workflow（recon → 4 路並行 scan → extract → 對抗式 verify），對比 2026-07-15 版稽核後 71 個 commit 的現況（新增 admin app、quota 系統、`sessionstore`、want v0.4.0）。只列出通過對抗式驗證（confidence ≥ 8/10）的項目；被推翻的候選（WS token-in-URL 重複舊發現、quota fail-open-on-DB-error 屬刻意設計）不列入。

### 本次新確認發現

Quota check-then-act 競態（confidence 9/10）於本次掃描首次確認，內容已併入下方「進行中的發現」（見「Quota check-then-act 競態，可無限繞過月額度」項目），不在此重複。

### 新增子系統掃描結果

- **`backend/internal/adminauth`**：獨立於開發者帳號的身份系統（自己的表、cookie、bcrypt），無自助註冊端點，只能透過 `ADMIN_BOOTSTRAP_EMAIL/PASSWORD` 環境變數建立第一個帳號。複核無問題。
- **`backend/internal/adminconsole`**：`/admin/api/*` 除了 login/logout 全部走 `withAdmin`，fail-closed。`setUserPlan` 可任意調整使用者方案，目前無額外的操作稽核紀錄（非漏洞，僅記錄供未來考慮）。
- **`backend/internal/quota`**：除了上方 TOCTOU 問題外，其餘（append-only ledger、`ON CONFLICT` 冪等寫入）設計正確。
- **`backend/internal/sessionstore`**：`want` 用的 GORM session store，明確以 `appId` scope（`ForApp`），複核跨 app 洩漏疑慮不成立——讀寫都有 `WHERE app_id = ? AND session_id = ?`。

### 順帶一提

- 公開發布的 `Dockerfile.release` 會把 admin SPA 一併打包進去——任何人拿這個 image 自建部署都會附帶 `/admin`，存取控制純靠 `adminauth` 登入，沒有獨立的 build flag 可以排除它。不算漏洞，但建議確認是否為刻意設計。

---

## 進行中的發現（依嚴重度排序，現況持續更新）

### 🟠 Quota check-then-act 競態，可無限繞過月額度
- **位置**：`backend/internal/ws/session.go:262-291`（`handlePrompt`）＋ `backend/internal/quota/quota.go:107-133`（`Check`）、`:150-172`（`Record`）
- **問題**：`Check` 只是單純的 `COUNT(*)`，`Record` 要等 `inference.Complete` 跑完（最長可到 ~90 秒的 `completeTimeout`）才會寫入。兩者之間完全沒有鎖或交易隔離；唯一的唯一性限制是 `(app_id, event_id)`，只防止同一個 RequestID 被重複計數，擋不住不同請求同時讀到「未超額」。
- **攻擊情境**：額度用完 0/10 的使用者，在 ~90 秒推論視窗內開多條 WebSocket 連線或發多個帶不同 RequestID 的 prompt。每個併發請求各自 `Check` 時都看到「未超額」（因為還沒有任何一個 sibling 請求寫回 `Record`），全部放行進真正的 LLM 呼叫——實質上可無限繞過月額度，直接造成計費/成本外洩。
- **修法**：把 check-and-increment 對同一個 owner 做原子化——要嘛用 `SELECT ... FOR UPDATE`（或 `pg_advisory_xact_lock(owner_id)`）把 `Check`+`Record` 包進同一個交易，要嘛改成「先原子扣額度，推論失敗再退回」的模式（atomic conditional UPDATE，`used < limit` 才成功）。純 process-local 的 mutex 不夠，服務若有多個 replica 就無效，須是 DB 層強制的鎖。
- **現況（2026-08-16 複核）**：未修復（新確認發現，confidence 9/10）。
- **現況（2026-09-05 複核）**：仍未修復。複核 `ws/session.go` 的 `handlePrompt` 確認 `Check`/`Record` 之間的窗口機制不變，這次未擴大掃描範圍到 `quota` 套件本身有無新的鎖機制。

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
- **現況（2026-09-05 複核）**：仍未修復，`backend/` 全域無 rate-limit middleware，機制不變。

### 🟠 S3. 完全沒有設定任何安全 header
- **位置**：全 `backend/` 無 `Strict-Transport-Security`／`X-Frame-Options`／`X-Content-Type-Options`／`Content-Security-Policy`；`main.go` 的 `recoverMiddleware` 是唯一的全域 middleware，`web.go` 的靜態回應只設 `Content-Type`。
- **影響**：session-cookie 認證的 console SPA（以及新增的 admin SPA）可被 clickjacking（無 `X-Frame-Options`/`frame-ancestors`）；無 HSTS 留下 HTTP 降級窗口（即使 `COOKIE_SECURE=true`，除非 LB 另外補）；無 CSP，缺少對未來 XSS 的縱深防禦。
- **修法**：加一個全域安全 header middleware（包住 `recoverMiddleware` 內外皆可），統一加上 `X-Frame-Options: DENY`（或 `CSP frame-ancestors 'none'`）、`Strict-Transport-Security`（僅正式環境）、`X-Content-Type-Options: nosniff`、`Referrer-Policy`，且要套住 `/app`、`/admin` 的靜態/SPA fallback 路由。
- **現況（2026-08-16 複核）**：仍未修復，且範圍擴大——新增的 admin SPA 現在也暴露在同樣的 clickjacking 風險下。本次複掃已用對抗式驗證正式確認（confidence 8/10）。
- **現況（2026-09-05 複核）**：仍未修復。複核 `main.go`（唯一全域 middleware 是 `recoverMiddleware`）與 `web.go`（靜態回應只設 `Content-Type`），確認無任何路由（含 `/app`、`/admin` 的 SPA fallback）帶有 `X-Frame-Options`/`CSP`/`HSTS`/`X-Content-Type-Options`。

### 🟠 S4. API key 以 WS URL query 參數傳輸 — 實際的日誌/歷史外洩
- **位置**：`backend/internal/ws/handler.go`（`r.URL.Query().Get("token")`）＋ `packages/bridge/src/client.ts`（`url.searchParams.set("token", ...)`）
- **影響**：這是刻意的取捨（瀏覽器無法對 WS upgrade 設 header），但「只用 wss://」只保護傳輸線路，不保護 Cloud Run/LB 的 access log（多數預設會記完整 URL）、瀏覽器歷史、Referer 外洩。任何記錄完整 request URL 的存取日誌都會持久儲存明文 API key。SDK 也未在 runtime 強制 `wss://`。
- **修法**：在 Cloud Run/LB 存取日誌層 redact `token` query 參數；SDK constructor 加 runtime 檢查，`apiKey` 有值但 `url` 非 `wss://`（localhost 例外）時大聲警告；長期考慮改用短效、單次 WS ticket（HTTPS 認證後換發、WS 一次兌換）取代長效 key。
- **現況（2026-08-16 複核）**：仍未修復，機制不變。SDK 仍未在 runtime 檢查 `apiKey` 有值但 `url` 非 `wss://` 的情況，僅在 JSDoc 註記。
- **現況（2026-09-05 複核）**：仍未修復。複核 `ws/handler.go:107`（`r.URL.Query().Get("token")`）確認機制不變；`APIKeyResolver.ResolveApp` 對缺 token 只回通用「invalid or missing token」訊息（未區分「app 不存在」vs「key 錯誤」），這點本身正確（不洩漏 app 是否存在），但不影響 token 走 URL query 這個核心風險。

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
