# 第三方後端工具串接 onagent 推論架構討論

本文件記錄一場由三位角色參與的架構設計討論，主題是第三方開發者如何將自家**後端側**工具（非前端／瀏覽器端工具）與 onagent 的推論串接。討論需求最初由第三方開發者提出，並在討論過程中經系統架構師與資深工程師擴充與釐清。以下依序呈現參與角色、完整討論過程逐字稿，以及最終結論。

## 參與角色

- **第三方軟體開發者（Third-party developer）**：代表串接方，關注憑證安全、延遲、可靠性與實際落地可行性。
- **系統架構師（Systems architect）**：代表 onagent 架構事實與決策收斂，釐清現行系統邊界與未來規劃選項。
- **資深工程師（Senior engineer）**：代表實作細節與技術風險，補充程式碼層級的具體限制與變通方案。

## 討論過程

**第三方軟體開發者（Third-party developer）**：我這邊的情境是這樣的：我們有一個自己的後端服務，上面掛了幾個內部工具，例如查詢我們的專有庫存資料庫、呼叫內部的付款微服務做退款動作，還有一個是查客戶的訂單狀態，這些都需要 server-side 的憑證（DB connection string、內部服務的 mTLS 憑證之類的），我們的前端從來、也不應該拿到這些東西。

我想要的是讓 onagent 的 LLM 推論可以直接呼叫我後端的這些工具，而不是透過瀏覽器分頁。我們有些場景根本沒有瀏覽器頁面開著——比如排程觸發的自動化流程，或是我們自己對外提供的一個純 API 產品，完全沒有 UI。

所以我想先確認幾件事：onagent 現在有沒有支援「工具直接跑在第三方自己的後端」這種模式？我看架構好像 `tool_call`/`tool_query` 都是透過 WebSocket 送回發起 `hello` 的那個瀏覽器分頁執行（我理解這是 `forwardingTool`/`queryTool` 都走 `askPage` 那條路），如果真的是這樣，那對我來說有三個問題：第一，憑證要怎麼處理，總不會要我把資料庫連線字串塞進瀏覽器端的 handler 吧；第二，延遲問題，多繞一手瀏覽器再打我後端，一來一回的 round trip 會不會太長；第三，可靠性，如果根本沒有瀏覽器分頁開著（像我說的排程或純 API 場景），那 session 是不是就直接失敗了？有沒有類似 webhook URL 註冊在 tool 定義裡，讓 server 直接呼叫我後端的規劃？

**系統架構師（Systems architect）**：先講結論：現在的架構完全沒有「server-to-server」這條路，不是繞遠路，是根本不存在。`tool_call`/`tool_query` 一律走 `askPage`（`interaction.go:85-95`）→查 in-process 的 asker map→送回發起 `hello` 那個 session 的同一條 `*websocket.Conn`。`toolschema.Tool`（`schema.go:11-48`）只有五個欄位，沒有 URL、沒有 webhook，連 schema 都表達不出「這個 tool 該打去哪個後端」。所以你講的三個問題裡，第三個其實是最根本的：沒有瀏覽器分頁在線，`askPage` 直接回錯誤（`interaction.go:92`），沒有 fallback，session 就是失敗，這不是可靠性風險，是現在的行為就是這樣。

現實選項只有兩個。選項一，適配現有模型：你的前端（哪怕只是個極簡的無 UI 頁面或 headless browser 常駐）開 WS session，handler 收到 `tool_call` 後才去打你自家後端拿資料——這樣憑證還是留在你的後端，前端只是個 relay，不觸碰 DB connection string。但這解不了你排程/純 API 沒有瀏覽器的場景，你等於要維護一個假瀏覽器常駐行程，還要處理它斷線重連。選項二，真正的 server-to-server 是全新功能：新的 tool kind（例如 `webhook`）、schema 加 URL 欄位、新的 dispatch 分支繞過 `askPage` 直接用 `http.Client` 打你後端——這是要在 onagent 裡新增程式碼，不是配置就能打開的東西。

我要先提醒一個你們都還沒談到的：就算做了選項二，那條 HTTP 呼叫要用什麼身份驗證你的後端？onagent 服務端目前沒有替第三方保管密鑰或簽署 outbound 請求的機制，這部分等於要重新設計一套 server-to-server 的認證協定。

**資深工程師（Senior engineer）**：兩位講的架構事實都對，我補三個技術細節，順便把選項一的具體實作講死。

**選項一（browser-relay）怎麼落地**：你（開發者）寫一支常駐頁面，`hello` 帶自己的 API key 拿到 `ack{sessionId, toolNames}`，收到 `tool_call{requestId, toolName:"query_order_status", args}` 後，`handleToolCall`（`client.ts:277-307`）裡註冊的 handler 用 `fetch()` 打你自家後端（這一段是 handler 內部邏輯，onagent SDK 不管你怎麼實作），回來包成 `tool_result{requestId, toolName, ok, result}` 送回去。要注意：這支頁面**必須是真的瀏覽器環境**（即便無 UI），因為 WS handshake 走 `?token=` query param、`Origin` 綁定 app（`handler.go:109-126`），你要用 headless Chromium（Playwright/Puppeteer）常駐，不是隨便一個 HTTP client 能冒充。而且退款這種操作，DB credential/mTLS cert 完全不進這支頁面的 JS context，只是它打去你後端時你後端自己再做那層驗證——這點解決了憑證問題，但架構師沒提到：`interactionTimeout` 是 **20 秒**（`session.go` 內常數），你付款微服務如果有重試或鎖等待，20 秒打不完就整個 `tool_call` 直接超時失敗，這個要先確認你們 P99 延遲。

**選項二**架構師提的認證協定問題我同意，但還有更根本的：onagent 是 SaaS，你的內部服務多半在 VPC 裡沒有公開 inbound endpoint，server-to-server 意味著要嘛你開防火牆洞給 onagent 出口 IP，要嘛整個方向反過來做成 onagent 主動輪詢或你們自己架一個公開可達的 gateway——這不是加個 `webhook` tool kind 欄位就結束的事。

**第三方軟體開發者（Third-party developer）**：先講延遲那個數字，20 秒 timeout 我聽到有點緊張。付款微服務如果卡在鎖等待或下游重試，20 秒真的可能不夠，而且更麻煩的是——就算我把 timeout 抓寬一點在我自己後端做，onagent 這邊那 20 秒是寫死的常數還是可以配置？如果是寫死，那我等於被迫把所有 tool 設計成「一定要在 20 秒內回」，查訂單狀態還好，退款這種可能要等內部風控流程的，直接被這個限制卡死。

其次，關於選項一的 headless browser 常駐方案，老實說架構上我覺得很不安。先不論要多維護一個 Playwright/Puppeteer 行程本身就是額外的 SPOF 跟維運負擔，`Origin` 綁定加 `?token=` query param 這套認證模型是設計給「使用者瀏覽器 + 使用者裝置」的信任模型，現在拿來給我一個伺服器對伺服器的常駐連線用，感覺是在用不對的工具做不對的事——這條連線本質上就是機器對機器，卻要偽裝成瀏覽器分頁，斷線重連、扣款重複執行（沒有 idempotency key 保護的話）這些問題都要我自己在 relay 層處理。

具體需求我先列一個：如果之後真的要做選項二，`tool_result` 裡至少要能帶 idempotency key 或讓我方自訂 requestId 語意，不然網路重試在退款場景會很危險。另外我想確認，選項一這條路現在有沒有人實際跑過、驗證過 headless browser 常駐配 onagent 的可行性，還是純理論推導？

**系統架構師（Systems architect）**：各位提的問題我都同意，先做收斂。

**已定案的部分**：第一，「onagent 現在沒有 server-to-server dispatch」這件事不用再爭論了，`askPage`（`interaction.go:85-95`）、`toolschema.Tool` 五個欄位（`schema.go:11-48`）都是死的程式碼事實。第二，20 秒 `interactionTimeout` 是 `session.go` 裡的常數，現在確實寫死、不可配置——工程師沒講錯，這對退款這種可能卡風控流程的 tool 是硬限制，選項一無法繞過，這點該記進風險清單，不是靠 relay 層能解的，因為 timeout 是 onagent server 端等 `tool_result` 的邏輯，不是你能延長的。

**還沒有共識、需要拍板的**：選項二（真 webhook/server-to-server）要不要做，這是產品優先級問題，不是我能在這裡決定的。但如果要排進 roadmap，我認為至少要包含四件事，缺一不可：(1) schema 新增 `kind: "webhook"` + URL 欄位；(2) outbound 認證機制，例如 onagent 簽署 HMAC 讓你驗證來源，而不是你反過來驗 onagent；(3) timeout 要做成 per-tool 可配置，而不是沿用 20 秒常數；(4) 開發者提的 idempotency key——`tool_result` 現在用 `requestId` 相關聯，這個 requestId 本來就是 onagent 產生的，可以直接讓它兼任 idempotency key 用，不用額外設計新欄位。網路邊界問題（VPC/防火牆）我認為責任在開發者那邊架 public gateway，onagent 不會做 outbound 到私網。選項一有沒有人真的驗證過 headless browser 常駐——這是實作驗證問題，不是架構問題，我建議工程師那邊拉個 PoC，不要純理論推導就採用。

**資深工程師（Senior engineer）**：我補三點，把架構師的「已定案」再往下釘。

第一，idempotency key 那個決議我要反對重用 requestId。看 `session.go:283-291`，requestId 現在是拿來做 quota usage 記錄去重的，語意是「這次 tool_call 事件」，重點是它由 **onagent server 產生**、每次 dispatch 都是新的一個。如果你（開發者）這邊做重試或斷線重連，onagent 可能會用新的 requestId 重送同一個邏輯操作——這對退款來說就是災難，因為從你後端角度看，兩個不同 requestId 但語意上是同一筆退款。idempotency key 必須是**呼叫端（LLM/orchestrator 決定要退款這個動作時）產生並放進 tool 的 args 裡**，由你的後端據此去重，不能借用協定層的 requestId，兩者生命週期不一樣。

第二，選項一的 20 秒限制其實有個變通但很醜的做法：handler 收到 `tool_call` 先立刻回一個「處理中」的假結果讓 turn 不超時，實際退款結果透過另一支你自己開的 API 讓使用者事後查詢——但這樣就不是 LLM 一次對話拿到結果了，體驗上要跟產品那邊對齊，不是純技術問題。

第三，PoC 我可以拉，但要先跟開發者要一組測試用的 app key 跟一個非正式環境的內部服務端點，不然只能拿 mock 後端測 headless browser 存活率，測不出你們真實的付款延遲分佈。

**第三方軟體開發者（Third-party developer）**：20 秒的部分先確認清楚了，我認了——這是 server 端邏輯，不是我能靠 relay 層繞過的，那就先把它列進限制清單。查訂單狀態這種讀取型工具沒問題，20 秒綽綽有餘；但退款這種要等風控的，工程師講的「先回處理中假結果、後續用我自己的 API 讓使用者查」這個 workaround，我可以接受當技術方案，但這已經不是純技術決策了，等於是把「LLM 一次對話拿到最終結果」這個體驗砍掉一部分，這個要我們產品那邊點頭才能拍板，我先帶回去談。

idempotency key 那個我完全同意工程師的反駁，我原本的想法確實不夠精確——的確不該用 requestId，應該是 orchestrator 決定要退款時就把 idempotency key 塞進 args，由我後端去重，這樣即使 onagent 那邊重送、requestId 換了，我這邊看 args 裡的 key 還是能認出是同一筆。這點我覺得已經講清楚了，算共識。

PoC 的部分，測試 app key 跟非正式環境端點我這邊可以出，但我要先提醒：非正式環境的付款微服務延遲分佈跟正式環境不會一樣，尤其風控那段常常正式環境才會真的觸發限流，所以 PoC 驗證的是「headless browser 存活率」跟「協定走得通」，延遲數字只能當參考下限，不能當作 SLA 依據，這點要先講清楚避免之後被誤用。

還有一件事沒人回答：選項一這條路徑，onagent SaaS 那邊對「一個 app 常駐一條 WS 連線、24 小時不斷跑」這種用法，quota 或計費模型算不算你們預期內的正常用量？會不會被誤判成異常流量。

## 結論

### 1. 已達成共識的架構

第三方後端工具目前**沒有**也**不能**直接被 onagent 推論呼叫。現行唯一路徑是 browser-relay（選項一）：第三方需自行維護一支常駐頁面，以真實瀏覽器（headless Chromium，如 Playwright/Puppeteer）開啟 WS 連線，`tool_call` 送到這支頁面後，由頁面內的 handler 對開發者自家後端發 `fetch()` 取得結果，DB connection string、mTLS 憑證全程留在開發者後端，不進入瀏覽器 JS context。這解決了憑證外洩疑慮，但代價是：開發者要自行處理這支「假瀏覽器」行程的斷線重連與 SPOF 問題，且完全無法覆蓋排程觸發或純 API（無瀏覽器）場景——這類場景在現行架構下**沒有解法**。

選項二（真正的 server-to-server webhook dispatch）確認**目前完全不存在**，是否要做屬產品優先級決策，未拍板，僅列出若要做則必須包含的四個要件（見下）。

### 2. 已達成共識的協定／整合機制

- 訊息流：`hello{appId}` → `ack{sessionId, toolNames}` → `tool_call`/`tool_query` → `tool_result`，全程走同一條 `*websocket.Conn`，由 `askPage`（`interaction.go:85-95`）查 in-process asker map 送達；無瀏覽器分頁在線時直接回錯誤（`interaction.go:92`），無 fallback。
- `interactionTimeout` 為 **20 秒**，寫死在 `session.go` 常數中，**不可配置**，且此為 onagent server 端等待 `tool_result` 的邏輯，relay 層無法繞過。讀取型工具（查訂單狀態）足夠，但退款這類需等待風控流程的工具會被硬性卡住。
- 可接受的 workaround：handler 收到 `tool_call` 先回「處理中」假結果避免超時，實際結果透過開發者自建的另一支查詢 API 讓使用者事後查詢——但此舉犧牲「LLM 一次對話拿到最終結果」的體驗，需開發者產品端另行拍板，非純技術決策。
- 若選項二排入 roadmap，需具備四要件：(1) `toolschema.Tool` 新增 `kind: "webhook"` + URL 欄位；(2) outbound 認證機制，由 onagent 簽署 HMAC 供第三方驗證來源；(3) timeout 改為 per-tool 可配置，不沿用 20 秒常數；(4) idempotency key 由呼叫端（orchestrator 決定執行動作時）產生並放入 tool 的 `args`，由開發者後端據此去重。

### 3. 已達成共識的安全要求

- **idempotency key 不可重用 `requestId`**：`requestId` 由 onagent server 產生，語意是「這次 tool_call 事件」，重試/斷線重連時會換新值，兩者生命週期不同（`session.go:283-291` 的 quota 去重用途亦印證此點）。退款等具副作用操作必須由呼叫端在 `args` 中攜帶獨立的 idempotency key，由第三方後端據此去重，不能依賴協定層欄位。
- 網路邊界（VPC/防火牆）責任在開發者一方自建 public gateway，onagent 不會主動 outbound 到私網。
- 選項一的 `?token=` + `Origin` 綁定認證模型（`handler.go:109-126`）是為使用者瀏覽器信任模型設計，拿來給機器對機器的常駐連線使用，被明確標注為「用不對的工具做不對的事」，但目前無替代方案，列為已知風險而非阻斷項。

### 4. 明確列為未解決的事項

- 選項二是否排入 roadmap：產品優先級問題，未決。
- 選項一的 headless browser 常駐方案**尚未經過實測驗證**，僅為理論推導；工程師承諾拉 PoC，但只能驗證「存活率」與「協定走得通」，無法用非正式環境的延遲數據作為 SLA 依據（正式環境風控觸發的限流行為不同）。
- PoC 所需的測試 app key 與非正式環境端點，開發者承諾提供，但尚未執行。
- **完全未被回答**：一個 app 24 小時常駐單一 WS 連線的用法，在 onagent SaaS 的 quota/計費模型下是否算正常預期用量，或會被誤判為異常流量——留待後續回應。
- 「先回假結果、後續另開 API 查詢最終結果」的體驗妥協方案，尚待開發者產品端內部拍板。
