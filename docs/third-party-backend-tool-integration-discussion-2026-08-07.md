# 第三方後端工具串接 onagent 推論架構討論

本文件記錄一場由三位角色參與的架構設計討論，主題是第三方開發者如何將自家**後端側**工具（非前端／瀏覽器端工具）與 onagent 的推論串接。討論需求最初由第三方開發者提出，並在討論過程中經系統架構師與資深工程師擴充與釐清。以下依序呈現參與角色、完整討論過程逐字稿，以及最終結論。

## 第二輪討論前言

> 2026-08-07，第二輪。

第一輪（見下方「討論過程（第一輪，背景）」）曾經嘗試把這個需求塞進既有的前端／WebSocket 架構裡討論（`askPage`、browser-relay、`interactionTimeout`、`?token=`/`Origin` 認證模型等），但那個方向被判定為誤會——這個需求的本質是「完全走後端」，不該用前端架構去適配或繞路。因此第一輪裡系統架構師與資深工程師基於前端架構展開的分析已經移除，只保留第三方開發者最初提出的需求本身，作為第二輪的起點。

第二輪的框架是：重新從零討論一套**適用於後端對後端（server-to-server）的通訊協定、安全性與系統架構**，不預設要沿用或相容既有的前端／WebSocket 機制。

## 參與角色

- **第三方軟體開發者（Third-party developer）**：代表串接方，關注憑證安全、延遲、可靠性與實際落地可行性。
- **系統架構師（Systems architect）**：代表 onagent 架構決策收斂，這一輪聚焦於設計一套獨立於前端之外的後端整合方案。
- **資深工程師（Senior engineer）**：代表實作細節與技術風險，補充程式碼層級的具體限制與變通方案。

## 討論過程（第一輪，背景）

**第三方軟體開發者（Third-party developer）**：我這邊的情境是這樣的：我們有一個自己的後端服務，上面掛了幾個內部工具，例如查詢我們的專有庫存資料庫、呼叫內部的付款微服務做退款動作，還有一個是查客戶的訂單狀態，這些都需要 server-side 的憑證（DB connection string、內部服務的 mTLS 憑證之類的），我們的前端從來、也不應該拿到這些東西。

我想要的是讓 onagent 的 LLM 推論可以直接呼叫我後端的這些工具，而不是透過瀏覽器分頁。我們有些場景根本沒有瀏覽器頁面開著——比如排程觸發的自動化流程，或是我們自己對外提供的一個純 API 產品，完全沒有 UI。

所以我想先確認幾件事：onagent 現在有沒有支援「工具直接跑在第三方自己的後端」這種模式？有沒有類似 webhook URL 註冊在 tool 定義裡，讓 server 直接呼叫我後端的規劃？

> 第一輪後續（架構師與工程師基於既有前端／WebSocket 架構展開的分析、選項一 browser-relay 方案、20 秒 timeout 討論等）已於第二輪移除，因為那個討論方向本身建立在錯誤的前提上——詳見上方「第二輪討論前言」。

## 討論過程（第二輪）

**系統架構師（Systems architect）**：謝謝，我看完第一輪的需求了。開發者的情境很清楚：內部庫存查詢、付款微服務退款、訂單狀態查詢，這三個工具都需要 server-side 憑證，而且有些觸發場景（排程、純 API 產品）根本沒有瀏覽器在線。所以第二輪我們不談「怎麼繞過前端」，直接談「onagent 怎麼在完全沒有前端參與的情況下，安全地呼叫第三方自己的後端」。

我的初步方向是：採用 **onagent 主動發起的 outbound webhook 模式**，而不是讓第三方輪詢。輪詢模式對開發者來說要多維護一條長輪詢或訊息佇列，且天生有延遲下限；退款這類低延遲要求的動作用輪詢不划算。outbound 模式的代價是 onagent 要能在多變的第三方基礎設施前保持穩定連線行為，但這是我們該扛的複雜度，不該讓開發者扛。

認證上我傾向雙向機制：onagent 對每個 app 簽發一組 **HMAC 簽章密鑰**，每次呼叫在 header 帶上 timestamp、nonce 與 payload 簽章，第三方用共享密鑰驗證來源與防重放；反向地，第三方端點在註冊時要能選擇性掛 **mTLS 用戶端憑證**或 IP allowlist，讓 onagent 這邊也能驗證自己打的目的地沒有被 DNS/路由劫持。兩者不互斥，HMAC 是最低門檻、mTLS 給有能力的開發者加固。

schema 上，`toolschema.Tool` 需要新增一個可選的 backend dispatch 區塊：endpoint URL、認證方式（HMAC/mTLS 擇一或並用）、密鑰/憑證的引用（不能明文存 schema 裡，要指向密鑰管理系統的 reference）、以及像 `recommend_nearby` 這種查詢型工具需要的 timeout 與是否允許重試的旗標。

可靠性是這條路徑的重點，因為沒有前端 fallback：逾時要有 per-tool 可配置值、重試要區分「可重試的查詢型」與「需要 idempotency key 才能重試的動作型」，第三方服務不可用時要有明確的降級語意回饋給 LLM，而不是整個推論卡死。

開發者，先請你談優先序——這三個工具裡哪個最急、退款這類寫入操作對 idempotency 有沒有具體要求？工程師隨後補實作可行性。

**第三方軟體開發者（Third-party developer）**：架構師，outbound webhook 這個方向我認同——退款這類我先前提的低延遲場景確實撐不起輪詢的延遲下限，onagent 扛住多變第三方基礎設施的複雜度而不是丟給開發者，這個責任劃分是對的。

我這邊剛好帶了一個不是假設情境、而是正在生產環境跑的案例可以直接對照：tripace 專案的 `recommend_nearby` 工具。它讀 `GOOGLE_PLACES_API_KEY` 這個後端環境變數呼叫 Google Places API，是純查詢、無副作用，而且是 LLM 在對話中**自主決定**要不要查、查哪個地點——不是使用者點按鈕觸發。這正好可以驗證架構師說的「schema 新增 backend dispatch 區塊」夠不夠用：endpoint、認證方式、密鑰 reference、timeout、重試旗標，這些欄位剛好能完整表達 `recommend_nearby` 的需求，沒有缺項，但我想強調一點——這個 schema 設計必須清楚區分「查詢型/可重試」與「動作型/需 idempotency key」這兩類，不能讓兩者共用同一組重試語意，不然查詢型工具會被迫背上它不需要的複雜度。

關於 timeout per-tool 可配置，我這邊查了我們的程式碼想確認這件事的份量。我用的 `want` 框架裡等價的逾時設定其實是 package-level 的 `var`（不是 `const`），正式路徑上從沒被改寫過，純粹是為了測試能縮短等待時間。如果 onagent 那邊的實作結構類似，這應該只是新增一個從 schema 讀值、傳到逾時呼叫點的路徑，不是要重新設計等待邏輯——工作量可能比原先預期的輕，這點麻煩工程師確認一下 onagent 這邊的等價實作是不是同樣結構。

至於架構師問的優先序：三個工具裡最急的是 `recommend_nearby` 這一類。原因很直接——它是查詢型、無副作用，失敗直接重試就好，不需要一開始就處理 idempotency key。我建議 PoC 就先打這個範圍：驗證「後端 tool 能不能繞過瀏覽器分頁、直接在 onagent server 端執行並拿到結果」，退款這種寫入型動作可以等這條路徑先站穩再談。

認證機制上，HMAC 簽章＋timestamp＋nonce 這組我沒意見，對我來說維運成本最低，一組共享密鑰、標準防重放，不需要額外憑證管理。mTLS 我會列為選配，但想請架構師定義清楚密鑰輪替流程——如果 HMAC 密鑰外洩，補救窗口是什麼？是否支援雙密鑰並存期讓我這邊無痛切換，而不是硬性立即失效導致服務中斷。

最後一點我想提醒：因為 `recommend_nearby` 是 LLM 自主觸發、不是使用者操作，當我這邊後端暫時不可用時，降級語意要能讓 LLM 理解「這個資訊來源暫時拿不到，請用既有資訊繼續規劃」，而不是回傳一個讓 LLM 誤判成「查詢結果就是空」的訊號——這兩者對使用者體驗差很多，值得在錯誤回饋格式裡明確區分。

**系統架構師（Systems architect）**：開發者這五點我逐一拍板。

第一點，同意，這是對的糾正。schema 的 dispatch 區塊我拆成兩個 `kind`：`query` 跟 `action`。`query` 這組欄位只有 endpoint、認證引用、timeout、一個簡單的「是否可重試」布林——重試就是無腦重打，不需要額外狀態。`action` 這組除了同樣的 endpoint／認證／timeout，會多兩個欄位：`idempotencyKeyRequired` 跟重試退避策略，且重試邏輯必須帶著同一把 key 打第二次，不是單純重放請求。兩組不共用同一個重試欄位命名，避免 `query` 類工具的開發者要去理解不相關的 idempotency 概念，這點我接受你的意見全盤調整。

第二點，你查到 `want` 那邊是 package-level `var`，但 onagent 這邊等價的實作是哪個檔案、是不是同樣結構，我不該憑印象回答——這是程式碼層級的事實，交給工程師稍後核對後直接答覆你，不要我在這裡猜。

第三點，同意 PoC 就打 `recommend_nearby` 這類查詢型範圍。架構上的好處很明確：可以先完全不碰 idempotency key 這塊複雜度，把 outbound webhook 的認證協定（HMAC 簽章、timestamp、nonce）跟 dispatch 機制先端到端驗證通過，等這條路徑穩了，`action` 類工具只是在同一個骨架上多接一組欄位，不需要重新驗證底層傳輸是否可靠。

第四點，密鑰輪替我直接給承諾：支援**雙密鑰並存期**。開發者主動觸發輪替時，onagent 會核發一把新密鑰，舊密鑰不會立即失效，而是進入一段並存視窗（我建議預設 7 天，可調），這段期間新舊密鑰簽章都驗證通過，讓開發者那邊可以無痛把服務逐步切到新密鑰再撤舊的，不會有服務中斷風險。密鑰外洩的補救窗口則是反過來：開發者可以立即單方撤銷舊密鑰（不等並存期跑完），撤銷即時生效，同時系統會核發新密鑰。這兩個流程共用同一組 API，差別只在撤銷時機由開發者控制。

第五點，這確實是原方案的缺口，你點出來是對的。我的想法是錯誤語意要分兩種：一種是「工具本身回報錯誤」（例如 Google Places API 回 4xx，查詢本身有問題），另一種是「工具暫時不可用」（連線逾時、5xx、或 onagent 這邊判定第三方端點無回應）。這兩種要在回饋給 orchestrator 時帶不同的訊號，讓 LLM 收到的不是一個扁平的「空結果」，而是能分辨「這裡沒東西」跟「這裡暫時問不到，你可以用已知資訊繼續」。這部分怎麼在 orchestrator 層具體落地，我要工程師補。

工程師，這次麻煩你補三件事：一、onagent 現有 timeout 實作（`backend/internal/ws/session.go` 那個 `interactionTimeout`，或是新 dispatch 路徑該用的等價機制）到底是不是 `var`，能不能直接沿用同樣模式做成 per-tool 可配置；二、`query`／`action` 兩種 `kind` 在 `toolschema.Tool` 的 Go 型別上怎麼設計，包含欄位分組跟是否用 interface 或 tagged union 表達；三、第五點的降級語意，在 orchestrator 層要怎麼把「工具錯誤」跟「工具不可用」做成兩個不同的訊號傳給 LLM，具體實作方式是什麼。

**資深工程師（Senior engineer）**：三件事我照順序核對過了，先講第一件：`backend/internal/ws/session.go` 第 341 行，`interactionTimeout` 確實是 `var interactionTimeout = 20 * time.Second`，不是 `const`。而且第 338-340 行的註解寫得很直白：「A var, not a const, so tests exercising the timeout branch can shrink it. Production code never reassigns it。」跟開發者查到的 `want` 那邊 package-level var 是同一種結構——存在只是為了測試縮短等待，正式路徑上從沒被改寫。所以開發者的猜測是對的，工作量確實不重：不需要碰等待邏輯本身，只要在 `AskInteraction`（第 356 行起）把寫死的 `interactionTimeout` 換成從 `toolschema.Tool`（或新的 `BackendDispatch`）讀進來的值即可，是加一條讀值路徑，不是重構。但我要提醒一點：這個 var 目前是整個 Session 共用一份，不是 per-call 參數，per-tool 可配置代表要把它從「session 全域變數」改成「呼叫時傳入的參數」，這步改動比單純「新增欄位」略多一點，但仍是小改動。

第二件事，`toolschema.Tool`（`backend/internal/toolschema/schema.go` 第 11-48 行）現有欄位是 `Name`、`Description`、`Parameters`、`Returns *ParameterSchema`、`Kind ToolKind`（`"action"`/`"query"` 字串常量）。這個 `Kind` 概念架構師已經在用了（現有的 query/action 是「前端問答」語意），所以新的 dispatch kind 不該跟它撞名，我建議用獨立型別：

```go
type BackendDispatch struct {
    Kind BackendDispatchKind `yaml:"kind" json:"kind"` // "query" | "action"
    Endpoint string `yaml:"endpoint" json:"endpoint"`
    Auth     AuthRef `yaml:"auth" json:"auth"` // HMAC 密鑰 reference / mTLS cert reference
    TimeoutMS int `yaml:"timeoutMs,omitempty" json:"timeoutMs,omitempty"`

    Query  *QueryDispatch  `yaml:"query,omitempty" json:"query,omitempty"`
    Action *ActionDispatch `yaml:"action,omitempty" json:"action,omitempty"`
}
type QueryDispatch struct { Retryable bool `yaml:"retryable" json:"retryable"` }
type ActionDispatch struct {
    IdempotencyKeyRequired bool `yaml:"idempotencyKeyRequired" json:"idempotencyKeyRequired"`
    RetryBackoff string `yaml:"retryBackoff,omitempty" json:"retryBackoff,omitempty"`
}
```
不用 interface（型別集合固定、YAML 反序列化用 interface 麻煩），也不用純字串 `Kind` + 一堆可選欄位（那樣 `query` 工具的結構裡會混進不相關的 `idempotencyKeyRequired` 欄位，違背架構師剛拍板的「兩組不共用欄位」原則）。`Query`/`Action` 兩個指標欄位、依 `Kind` 只填一個，是這個 repo 已經在用的模式（`Returns *ParameterSchema` 也是可選指標欄位）。

第三件事，現有 `protocol.ToolResultPayload`（`backend/internal/protocol/message.go` 第 89-94 行）是 `OK bool` + `Error string` 的扁平結構，目前完全沒有區分「工具回報錯誤」跟「工具不可用」——兩者現在都會落到 `OK:false`。但同檔案 `ErrorPayload` 已經有先例（第 102-117 行）：`Code string` 搭配 `CodeQuotaExceeded` 這種機器可判斷的常量，人類訊息另外放 `Message`。我建議 `ToolResultPayload` 比照辦理，加一個 `FailureKind`：

```go
type ToolResultPayload struct {
    ToolName    string          `json:"toolName"`
    OK          bool            `json:"ok"`
    Result      json.RawMessage `json:"result,omitempty"`
    Error       string          `json:"error,omitempty"`
    FailureKind string          `json:"failureKind,omitempty"` // "tool_error" | "tool_unavailable"
}
```
`tool_error`（第三方回 4xx／業務邏輯拒絕）跟 `tool_unavailable`（逾時、5xx、連線失敗）由 dispatch 執行層依 HTTP 回應分類設定。到了 `agent_roles.go` 的 `forwardingTool`/`queryTool.Call`，目前這兩個都是把 error 字串塞進 `fmt.Errorf` 直接回給 want，want 只看得到一個扁平字串。要讓 LLM 真正分辨兩種語意，`EmitToolResult` 那段要跟著改——`tool_unavailable` 時塞一句明確引導語（例如「此資訊來源暫時無法取得，請根據既有資訊繼續」）進 result content block，而不是讓 want 把它當一般錯誤處理。這塊我可以在 PoC 階段直接動手實作，不需要架構師再定義。

有兩件事我沒辦法自己下判斷，要請開發者出來說明：一是 `idempotencyKeyRequired` 這把 key 具體要用什麼格式傳遞——UUID？開發者自訂字串？有沒有長度上限？這會影響 `ActionDispatch` 要不要額外加驗證欄位，我不該自己編一個格式定案；二是密鑰要透過什麼管道交給 onagent 儲存——是 console 上一次性顯示、事後不能重新查看，還是可以隨時到 console 重新檢視／輪替？這直接決定密鑰管理 UI 的行為，跟開發者實際的維運習慣有關，工程師不該替他假設。mTLS 那個選配機制開發者目前傾向不用（他自己說列為選配），這點我照他原話處理，沒有另外幫他決定。

**第三方軟體開發者（Third-party developer）**：工程師問的兩件事我直接回答，但在那之前我要先把場景往前推一步——因為這兩個答案其實取決於一個我還沒講清楚的東西：`recommend_nearby` 不是我這邊的終點，只是第一顆棋子。

我們（tripace）現在的產品方向是要做**行程自動推薦與安排**：使用者給一個大概的偏好（想去哪個城市、喜歡什麼類型的地點、玩幾天），LLM 要自己排查候選地點、依照地點類型分類（景點/餐廳/住宿）、再依交通時程把它們排進每天的時間軸——不是使用者手動拖曳，是 LLM 主動規劃整趟行程。這意味著 `recommend_nearby` 之後一定會有下一顆棋子跟進：查詢兩點之間交通時間的工具（我們內部已經有 `compute-route`，走 Google Routes API，但目前是前端主動呼叫的 HTTP API，不是 LLM 能自主決定要不要查的後端工具），還有更後面「把這幾個候選點依時間窗排進哪一天」這種需要多輪推理、可能要來回呼叫好幾次查詢工具才能收斂的規劃邏輯。

這對工程師的兩個問題有直接影響：

第一，`idempotencyKeyRequired` 的格式。我原本以為這只跟 `action` 類（有副作用的寫入操作，例如未來如果真的把「排入行程」這個動作也走 server-to-server）有關，但重新想過場景後，我認為**格式本身該由 onagent 定義、不是開發者自訂字串**——理由是：自動規劃這種場景很可能是同一輪對話裡，LLM 對同一個 `query` 類工具連續呼叫好幾次（例如查 A 點附近餐廳、查 B 點附近餐廳、再查 A 到 B 的交通時間），如果 key 格式是開發者自己決定，很容易在高頻連續呼叫下不小心產生碰撞或忘記帶。我建議 onagent 這邊用跟你們協定層一致的格式直接生成（例如 UUID v4，或沿用你們簽章機制裡本來就有的 nonce），開發者這端只需要照規格收、不需要自己設計產生邏輯——這樣才不會每個第三方各自發明一套，你們平台端做重試判斷時也不用相容一堆格式。

第二，密鑰交付管道。我明確要**可隨時到 console 重新檢視／輪替**，不要「一次性顯示、事後看不到」那種模式。原因不是我自己維運嫌麻煩，是因為在「LLM 自主規劃整趟行程」這種場景下，如果密鑰只顯示一次、我不小心弄丟，補救的唯一辦法是走你們前面提的雙密鑰並存輪替流程——但這代表要中斷一段時間才能重新設定完成，而規劃行程這種功能一旦上線就是產品核心互動，不是可以接受「先停用幾天等我重新設密鑰」的東西。一次性顯示模式在低頻/低重要性的工具上我能接受，但既然我們現在講的是會撐起整個核心推薦功能的密鑰，我要它跟一般雲端平台的 API key 管理頁面一樣，能隨時查看目前有效的是哪把（不需要看到明文，看到「這把 key 建立於某日、最後使用於某日」這種中繼資訊就夠，但至少要能確認我現在用的到底是不是我以為的那把）。

還有一件事我想在這裡提前點出來，即使還沒到要拍板的階段：如果之後真的要做「查交通時程」這個工具，它跟 `recommend_nearby` 有一個關鍵差異——`recommend_nearby` 一次查詢只依賴一個地點，但排時程需要**同一輪規劃裡查多個點對之間的距離**（N 個候選點，可能要查到 N² 對距離才能讓 LLM 判斷怎麼排最順），如果每一對距離都是一次獨立的 outbound webhook 呼叫，在候選點稍多的情況下，光是這個工具本身觸發的呼叫次數就會疊加，逾時／重試策略要考慮的不只是單次呼叫的可靠性，還有「這一整批查詢裡有一兩次失敗，LLM 該怎麼繼續往下規劃」這種批次語意——這比 `tool_unavailable` 單次降級語意更複雜一層，但我認為現在不需要為了這個把 schema 設計複雜化，只是想先讓架構師跟工程師知道這條路後面會遇到什麼，如果現在的 `BackendDispatch`／`QueryDispatch` 設計方向對這種「同一輪內密集重複呼叫同一個 query 工具」的模式沒有明顯衝突，那我沒有意見，先照目前拍板的走。

**系統架構師（Systems architect）**：開發者這段我逐項回應，先講兩個工程師點名的問題。

idempotency key 格式，拍板採用你建議的方向：格式由 onagent 統一生成，不開放開發者自訂字串。落地方式是在 `ActionDispatch` 的執行路徑上，onagent 在 dispatch 當下自動生成 UUID v4，放進 request payload 一個固定欄位（例如 `idempotencyKey`），開發者端原樣收下、原樣帶著做重試比對即可。這代表 `ActionDispatch` 的 schema 不需要再加額外驗證欄位——格式是系統定義死的常量規則，不是使用者輸入，沒有什麼好驗證的，`idempotencyKeyRequired` 這個布林維持原樣就夠，只是它現在的語意更明確：「是否需要 onagent 自動生成並附帶這把 key」。

密鑰交付管道，拍板採用「可隨時到 console 重新檢視／輪替、只顯示中繼資訊不顯示明文」的模式，這跟第一輪拍板的雙密鑰並存期是同一套機制的兩面：console 的密鑰管理頁要能列出每把密鑰的建立時間、最後使用時間、目前生效狀態，並存期間新舊兩把都會各自顯示這些中繼資訊，讓你能明確判斷「現在線上用的是不是我以為的那把」，再決定何時撤舊。一次性顯示模式我保留給未來低頻/低重要性工具用，不是不做，是不該套用在你這個場景上。

密鑰按工具細分、staging/production 隔離——這兩點我要分開表態。staging/production 隔離，我現在就想確認，理由是這很可能不是一個新機制，而是密鑰本來就該掛在「app」這個既有概念下，onagent 裡 app 本身有沒有環境區分是既有事實問題，不是新設計，值得這次直接問清楚，成本很低。按工具細分權限我不打算現在拍板——這是一個權限模型設計問題，過早引入會在 dispatch 機制都還沒端到端跑通前就背上複雜度，我傾向等 PoC 穩定後再談，不是否決，是排序。

N² 批次查詢的複雜度，我認同這是真實會發生的問題，也同意你的判斷：現在不需要為此改動 `BackendDispatch`/`QueryDispatch` 的 schema。這是「呼叫方一輪內怎麼呼叫多次」的編排問題，屬於 orchestrator/LLM 呼叫層，跟「單次 dispatch 協定怎麼設計」是兩個層次，可以分開處理，不該混在一起提前設計。但這件事不會憑空消失，我要求正式記錄成後續獨立規劃項目，等 `compute-route` 真的要上路時再開一輪討論批次語意。

工程師，這次麻煩你確認三件事：一、console 密鑰管理頁現有的 UI/API 有沒有可以直接沿用的既有機制（中繼資訊顯示、輪替流程）；二、app 的 staging/production 環境概念現在在 onagent 裡實際怎麼實作，密鑰能不能直接掛上去；三、UUID v4 生成該放在 dispatch pipeline 的哪一層，會不會跟你已經在做的 `EmitToolResult`/`ActionDispatch` 執行路徑有衝突。

**資深工程師（Senior engineer）**：三件事查完了，第一件跟第三件都有落差要先指出來，不是我要唱反調，是查到的程式碼事實跟我們前面拍板的內容對不上，必須講清楚。

第一件，密鑰管理。現有 app API key 機制是 `backend/internal/auth/auth.go` 的 `Store.Issue(appID)`／`Store.Revoke(appID)`，串接在 `internal/console/console.go:467-484` 的 `issueKey`/`revokeKey` handler。`issueKeyResponse.ApiKey`（`console.go:462-465`）註解寫死「plaintext — shown exactly once, never retrievable again」——一次性顯示、事後不可查看，跟架構師剛拍板的「可隨時重新檢視」相反，不能沿用。但這還不是最大的落差：**輪替機制實際上不存在**。`App.tsx` 那顆「Rotate key」按鈕，綁定的還是同一個 `issueKey()` 函式，後端 `auth.go` 註解直接寫「issuing a new one revokes the old key immediately」——也就是現在的「輪替」就是重新發一把、舊的立刻失效，沒有任何雙密鑰並存的機制、沒有 grace period。架構師前面承諾的「雙密鑰並存期預設 7 天」目前完全沒有對應的既有基礎，是要從零蓋一套新機制，不是擴充既有的。DB 這邊 `apps` 表（`schema.sql:73-80`）也只有 `created_at`，沒有 `last_used_at`——中繼資訊要新增才有。真正接近的形狀是 `usertoken.Token`（`usertoken.go:37-42`：`ID`/`Name`/`CreatedAt`/`LastUsedAt`，靠 `List` 撈中繼資料），我建議照這個形狀另開一個 store（例如 `backend/internal/dispatchkey/`），但這是新建，不是沿用。

第二件，環境概念。如實回報：`toolschema.App`（`schema.go:72-84`）只有 `AppID`、`Tools`、`Thought`，`apps` 表同樣沒有 environment 欄位，全域搜尋 `staging`/`production`/`environment` 命中的全是部署層級的泛用詞彙（`ADMIN_BOOTSTRAP_*`、CORS allowlist 之類），跟 app 的環境隔離無關——**完全不存在**。要不要新增 `Environment` 欄位讓一個 `AppID` 分裂成多筆記錄，還是讓開發者自己註冊兩個獨立 `AppID`（`myapp-staging`/`myapp-prod`，密鑰本來就是 per-`AppID`，不用碰 schema），我傾向後者，但這是產品/架構決策，交給架構師定案。

第三件，這件事查完後我要正式提出修正，不是小事：**UUID v4 這個方向可能跟現有慣例衝突**。整個專案（backend／apps/console／apps/admin，含 want SDK 依賴）**完全沒有導入任何 UUID library**，唯一的隨機 ID 生成是 `ws/id.go` 的 `randomID()`——`crypto/rand` 產生 16 bytes 再 hex encode，不是 UUID v4 格式。更關鍵的是，現有的 idempotency 慣例（quota 那邊的 `usage_events.event_id`，`schema.sql:158`）用的是 `env.RequestID`，而這個 `RequestID` 是**前端 SDK 生成、後端只做唯一性比對**——跟架構師剛拍板的「onagent 後端在 dispatch 時生成」方向正好相反。目前唯一「後端生成、跨 round-trip 追蹤一次呼叫」的識別碼，是 `ws.Session.AskInteraction`（`session.go:357`）裡的 `requestID := randomID()`，語意上最接近，但它現在是 32 字元 hex，不是 UUID v4，而且是給 WS 協定內部的 request/response 配對用，不是設計來給第三方後端當 idempotency key 用的。這個落差要架構師重新裁定：是要在這個既有生成點直接換成 UUID v4（等於順手把 `randomID()` 全站格式改掉，影響 session id 生成也用同一個函式），還是新 dispatch 路徑另外獨立生成一個 UUID v4、不動 `randomID()`，兩者都可行，但不是我能自己選的範圍。

**系統架構師（Systems architect）**：先處理工程師這兩個落差，都不小，直接裁定。

密鑰輪替：確認是從零蓋新機制，方向照工程師建議的 `dispatchkey` store。最小必要設計：一個 app 同時可有 0-2 把有效密鑰，每把有 `id`、`createdAt`、`lastUsedAt`、`expiresAt`（並存期用這個欄位表達，非輪替時為 null）。簽章驗證時兩把都嘗試，任一把驗證通過即放行，`lastUsedAt` 更新在實際驗證成功的那把上。撤銷是把某把密鑰的 `expiresAt` 立即改成過去時間，不是刪列，中繼資訊照樣留著給 console 顯示歷史。這是新表、新 store，不碰 `internal/auth`。

idempotency key：堅持後端生成，不改弦更張。理由是這裡的「呼叫端」是 onagent 自己的 dispatch pipeline，不是使用者前端——quota 那個 `RequestID` 前端生成的慣例，前提是「前端」就是發起請求、決定要不要重試的那一方；但在第三方後端工具這個場景，決定重試的是 onagent 的 orchestrator（LLM 自主決策要不要重打），第三方後端反而是被動接收方，跟 quota 案例的角色配置是反過來的，套用同一慣例是誤用類比，不是真的衝突。裁定：**新 dispatch 路徑獨立生成 UUID v4，不動 `randomID()`**。`AskInteraction` 那個 32 字元 hex 是 WS 協定內部配對用的既有機制，語意跟用途都不同，沒有理由為了這次需求牽動 session id 生成，範圍要收斂。

現在把協定本身講清楚，這是這一輪第一次完整講。

**Request**：`POST {endpoint}`，body 是 JSON：
```
{
  "toolName": string,
  "args": object,
  "idempotencyKey": string,   // 僅 action 且 idempotencyKeyRequired=true 時存在
  "dispatchedAt": RFC3339 string
}
```
Headers：`Content-Type: application/json`、`X-Onagent-Timestamp`（unix seconds）、`X-Onagent-Nonce`（16 bytes hex，防重放）、`X-Onagent-Signature`（HMAC-SHA256 hex）、`X-Onagent-Key-Id`（指出用哪把密鑰簽的，供第三方對應到並存期的新舊密鑰、也方便 onagent 這邊記錄 `lastUsedAt`）。

**簽章**：`signature = HMAC_SHA256(secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + body)`，body 是原始 raw bytes、簽章前不做任何格式化。第三方驗證時先查 timestamp 是否在容許誤差內（建議 ±5 分鐘），拒絕過舊請求防重放，再用自己存的密鑰重算比對——因為 headers 帶了 `Key-Id`，第三方不需要兩把都試，直接查表對應。

**Response**：成功回 `200`，body `{"ok": true, "result": <any>}`。`tool_error`（業務邏輯拒絕，例如查無資料、參數不合法）回 `4xx`，body `{"ok": false, "failureKind": "tool_error", "message": string}`。`tool_unavailable`（第三方自己判斷暫時撐不住，例如下游服務掛了）第三方主動回 `503`，body 同構但 `failureKind: "tool_unavailable"`；如果第三方完全沒回應、逾時、或回傳非預期格式，onagent dispatch 層自己判定為 `tool_unavailable`，不需要第三方配合。這條對應到工程師提的 `ToolResultPayload.FailureKind`，dispatch 執行層負責把 HTTP 層的結果收斂成這兩種之一。

**逾時與重試**：`query` 逾時或收到 `tool_unavailable` 直接重打一次，不帶任何額外狀態，逾時值用 schema 的 `timeoutMs`。`action` 逾時或 `tool_unavailable` 時，重試帶著**同一把** `idempotencyKey` 再打一次，退避策略用 `retryBackoff` 欄位；`tool_error` 一律不重試，因為那是業務邏輯拒絕，重打也不會變。

這份草案具體到可以直接照著寫 dispatch 執行層了。開發者、工程師，這份協定有沒有跟你們各自場景衝突或想補的地方，直接說。

剛才那份草案我少講一塊，來回通訊模式本身要選一個方法，這裡補上。

我剛才整份協定描述的其實只有一種模式：onagent 發 request、在 timeout 內同步等 response，逾時就是 `tool_unavailable`。這對 `recommend_nearby` 這種查詢型工具沒問題——秒級回應，同步等待不會拖住什麼。但開發者上一輪已經預告了行程規劃的下一步，而更早第一輪的背景裡也提過退款這類動作要卡風控流程，處理時間可能是幾分鐘甚至更久。這種情況如果照我剛才那份協定硬做，onagent 這邊發完 request 就得把整條工具呼叫鏈路、甚至底層 HTTP client 一路掛著等到風控跑完，這不是 timeout 調大就能解決的問題，是通訊模式本身選錯了。

我傾向的做法是依 schema 宣告決定同步或非同步，不是全站二選一。同步模式維持剛才那份協定不變，是預設值。非同步模式給明確宣告需要的工具用：onagent 發 request 後，第三方立刻回一個受理確認（例如 `202 Accepted` 加一個第三方自己的追蹤 ID），實際處理完再由第三方主動呼叫 onagent 開放的 callback endpoint 把結果送回來，onagent 用 idempotencyKey 或另一個關聯 ID 把這次非同步回傳對回原本卡在等待中的那次呼叫。schema 上我會在 `ActionDispatch` 加一個 `Mode: "sync" | "async"` 欄位表達這個選擇。callback 認證方向要反過來——不是 onagent 對第三方簽章，是第三方呼叫進來，onagent 要驗證來電請求真的是對應的第三方，可以沿用同一套 HMAC 機制，只是簽章方變成第三方、驗證方變成 onagent。等待期間 LLM/orchestrator 也不能死等，我認為需要一個語意不同於 `tool_unavailable` 的中間態——「已受理、處理中」而不是「不可用」，可能要開第三種 `FailureKind` 或獨立狀態值，讓 LLM 知道可以先繼續對話，不用卡在這一輪。

但我要老實講判斷：非同步模式增加的複雜度不小——callback endpoint、關聯 ID 比對、反向認證，這些沒有一項是輕量的。現階段 PoC 範圍是 `recommend_nearby` 這種查詢型工具，用不到非同步，我不建議現在實作。我要的只是先把 `Mode` 欄位加上去、現在只允許 `"sync"` 一種值，未來要開 `"async"` 是加值域，不需要動 `ActionDispatch` 的結構本身。

開發者，這個「先預留欄位、PoC 不實作」的排序，從退款這類真實需求的角度看是否能接受？工程師這輪不用發言，但 callback endpoint 等於 onagent 要在 `backend/cmd/server` 開一條新的 inbound 路由給第三方呼叫，這塊下一輪可能要請你先看一下大概屬於什麼量級的改動。

**第三方軟體開發者（Third-party developer）**：架構師，排序我接受，理由跟先前確認的一致：我這邊當前範圍就是 `recommend_nearby`，退款不在這次 PoC 裡，先把 `Mode` 欄位卡位、值域現在只開 `"sync"`，等真的走到需要非同步的工具（退款，或我們自己行程規劃裡處理時間較長的環節）再開 `"async"`，這樣 schema 不用重新設計，我可以接受這個排序。

協定草案我看過一遍，有兩個具體疑慮，不是照單全收。

第一，簽章公式 `method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + body`——這個組合順序跟拼法是 onagent 自創的，還是有參考業界既有慣例（像 AWS SigV4 那種 canonical request 組法，或 Stripe webhook 的 `timestamp.body` 簽章）？如果是自創格式，我會希望至少拿到一份參考實作或最小可用的驗證範例（哪怕是一段 pseudo-code 或一支測試用的 Go/Python script），不然這條驗證邏輯我這邊要完全從規格文字重刻一次，換行符號、欄位順序、body 是否含 trailing newline 這種細節很容易兩邊對不上，錯了還不一定會立刻報錯，可能是簽章「剛好」在某些 payload 下通過、某些下失敗，這種 bug 很難查。

第二，`±5 分鐘` 的時間誤差窗口，對我來說是合理的，一般 NTP 同步的伺服器時鐘綽綽有餘，這點我沒意見。

第三，`503` 對應 `tool_unavailable` 這個規則，我自己服務本身撐不住的情況很容易判斷、我可以做到。但有個邊界情況想先請架構師和工程師一起確認判斷原則：如果不是我自己的服務掛，而是我依賴的下游——比如 `recommend_nearby` 呼叫的 Google Places API 本身逾時或回 5xx——這種「我這邊沒事，但我打的下游掛了」該算 `tool_error` 還是 `tool_unavailable`？直覺上比較接近 `tool_unavailable`（因為對 LLM 來說結果一樣是「這輪查不到」），但如果沒有明確原則，不同第三方開發者可能會分類不一致，onagent 這邊在做重試判斷時可能會收到不一致的訊號。

這輪我這邊先講到這，工程師這輪不用針對我發言，發言權交回去。

**系統架構師（Systems architect）**：開發者，這兩點都問到要害，我逐一回應，不打模糊仗。

第一，簽章格式。誠實講：這不是照抄業界哪一家的既有規格，但也不是憑空捏造。核心思路——timestamp + nonce + body 組合起來防重放、用共享密鑰做 HMAC——是 Stripe webhook 簽章那套模式的簡化版，我們把它跟 canonical string 的分行組法（method/path/timestamp/nonce/body 逐行串接）合併成一份，這部分的分行拼接概念上接近 AWS SigV4 canonical request 的做法，但沒有照它完整的 query string 正規化、header 排序那套複雜度，我們刻意簡化了。所以答案是：概念上有業界依據，但拼法是我們自己定的組合，不是任何一家的原版。

正因為是自訂組合，你的擔心是對的——光靠文字描述換行符號跟 trailing newline，兩邊很容易對不上還不報錯。我現在拍板一個具體承諾：正式規格文件會附一支可直接執行的參考驗證 script（Go 跟 Python 各一份，涵蓋簽章產生端跟驗證端），裡面用固定的 fixture（寫死的 method/path/timestamp/nonce/body）跑出預期簽章值，你可以直接拿你的實作去對這組 fixture，比對不上就是你這邊的組法有落差，不用等到 PoC 對接才發現問題。再往前一步，我傾向連驗證邏輯都封裝成一個極小的 verify library（單一函式，輸入 headers+body+secret，回傳 true/false），不只是文件裡的範例——這樣可以把「重刻一次簽章邏輯」的風險從每個第三方身上拿掉，工程師這輪之後我會請他評估用 Go 寫這支最小 SDK 的量級。

第二，`tool_error` 跟 `tool_unavailable` 的邊界，我現在拍板一個明確原則：判斷標準不是「失敗發生在你自己的服務還是你的下游」，而是「這個失敗重試（幾秒到幾分鐘後）有沒有機會成功」。下游逾時、5xx，本質上是暫時性、有機會隨時間恢復，該算 `tool_unavailable`；下游明確回 4xx 說參數不合法或查無結果，重試不會改變結果，該算 `tool_error`，不管這個下游是不是你自己維護的。這樣所有第三方套的是同一把尺，onagent 重試邏輯收到的訊號才會一致，不會因為不同開發者對「責任歸屬」認定不同而分裂。

工程師，這輪先不用回應開發者，但下一輪要請你查一下 callback endpoint 在現有 `backend/cmd/server` 架構下大概是什麼改動量級。

**資深工程師（Senior engineer）**：架構師交辦的這件事我查完了，結論是：這不是要發明新機制，量級比聽起來輕，但有兩個地方會動到既有結構，不是純新增。

先講路由掛載本身。`backend/cmd/server/main.go` 用的是標準庫 `http.NewServeMux()`（第 241 行），走 Go 1.22+ 的 `METHOD /path` pattern 語法，例如 `mux.Handle("/ws", wsHandler)`（242 行）、`mux.HandleFunc("/healthz", ...)`（245 行）。這個模式本身就直接能套：`callback` 只要在同一個 `mux` 上加一行 `mux.Handle("POST /callback/{appId}", callbackHandler)`，跟既有的 `/apps/{appId}/tools.json`（243 行）用同一套 path-value 語法，沒有障礙。中介層模式也有現成先例可仿：`main.go` 391-405 行的 `publicCORS`、371-389 行的 `corsMiddleware`，都是「函式包函式」的標準 `func(http.Handler) http.Handler` 寫法，簽章驗證中介層可以照這個形狀寫一個新的，不需要引入新框架。

`console.go` 那邊的 `issueKey`/`revokeKey`（92-93、467-484 行）證明的是「認證方式可以掛在 handler 前面」這個既有慣例——但那套是 session cookie／bearer token 認證（`withAuth`，127 行起），跟 callback 要的「反向 HMAC」語意不同，不能直接複用邏輯，只能借用「認證包一層再接 handler」這個結構。真正貼近的對照反而是 `ws/handler.go` 88-155 行：`ServeHTTP` 裡認證邏輯直接寫在 handler 進入點、先驗證再放行的模式，這個位置感是可以照抄的。

真正的複雜度在「等待關聯」這塊，但這裡是好消息：`ws/session.go` 的 `pendingCalls map[string]chan protocol.ToolResultPayload`（46 行）＋ `AskInteraction`（356-392 行）就是現成的「map+channel 配對」模式——用 `randomID()` 生成 `requestID`（357 行）、註冊進 map（361 行）、`select` 同時等 channel 跟 timeout（378-391 行）。Callback 版本可以整套原封搬：新開一個 `map[idempotencyKey]chan CallbackResult`（可能要挑一個能撐住多 goroutine 併發的地方存放，不會是 Session 專屬的，因為 dispatch 呼叫不是 WS 連線發起的），dispatch 那個等待中的 goroutine 塞 channel 進 map、`select` 等結果或 timeout，callback handler 收到請求驗完簽章後往對應 channel 塞值即可，邏輯結構跟 `AskInteraction` 幾乎一比一。

量級估算：一個新檔案（例如 `backend/internal/dispatchcallback/`）放這個 map+channel store 跟 handler，大概 100-150 行；`main.go` 加兩三行掛路由；簽章驗證中介層獨立一個檔案，50 行上下，可仿 HMAC 驗證邏輯之前架構師已經定義過的正向版本反過來寫。真正的風險不是程式碼量，是這個 map 要不要跨 process 存活（多副本部署時 callback 打到另一台機器，pendingCalls 在那台是空的），這點 `ws.Session` 目前不用擔心是因為 WS 連線本來就固定釘在一台機器上，但 callback 是第三方獨立發起的 HTTP 請求，不保證回到同一個 process——這是唯一需要架構師先決定部署拓樸再往下設計的地方，不是程式碼層級能自己解的。

**系統架構師（Systems architect）**：工程師這個提醒我接下來，而且要先講清楚一件事：這不是「callback 機制做不做得出來」的問題，是「onagent 現在實際的部署方式，這套 map+channel 配對能不能正確運作」的問題——如果 onagent 目前是單一 process 部署，沒有水平擴展、沒有多副本，這個風險現在根本不存在，只是未來擴展時預埋的地雷；如果已經是多副本在跑，這件事現在就要解，不能拖到 async 模式真正上線那天才發現整批 callback 有一部分永遠等不到結果、全部吃 timeout。老實說，onagent 目前的部署拓樸——是單一 process、還是已經有負載平衡打多副本——這件事我沒有把握憑印象斷言，這是 infra 層級的事實，不在程式碼裡，我需要工程師或負責部署的人明確核對一次，不能在這裡用猜的定案。

但拓樸怎樣，方向可以先講。方案 A：把 pending-callback 狀態從 in-memory map 搬到共用儲存——現有 Postgres 是最現成的選項，callback handler 收到結果就寫進去，等待中的 goroutine 改成短輪詢，或用 Postgres LISTEN/NOTIFY 被喚醒，不管打到哪個 process 都查得到。方案 B：如果現在確實是單 process，就先接受限制、繼續用 in-memory map，但要明確記錄成技術債——「未來一旦水平擴展，這裡必須重新設計，不是自動相容」。

我的判斷是方案 B。理由很直接：這個機制目前只服務 async 模式，而 async 模式我們上一輪已經拍板——PoC 範圍不做，`Mode` 欄位現在只開 `"sync"` 一種值。也就是說，這個部署拓樸風險綁定的功能本來就還沒被使用，現在去解一個沒人在跑的路徑的擴展問題，是提前為假想場景過度工程化。如果之後真的要開 `"async"`，那個時間點必然也是我們要重新確認部署拓樸的時間點，屆時再一併決定要不要導入方案 A，不會太晚。唯一要現在做的，是把這個限制明確寫進技術債清單，不能悄悄漏掉。

這一輪走到這裡，通訊協定、簽章格式、密鑰輪替、環境隔離、同步/非同步模式分工，已經涵蓋得相當完整。開發者、工程師，看看目前為止的方案還有沒有沒討論到的重大缺口——如果沒有，我建議這輪先收斂，把目前拍板的內容整理進「結論」章節。

**第三方軟體開發者（Third-party developer）**：排序我接受，理由跟架構師講的一樣：`recommend_nearby` 用不到非同步，先把 `Mode` 欄位卡位、值域現在只開 `"sync"`，等我們真的走到需要非同步的工具（不管是我這邊的行程規劃排程邏輯，還是最早提的退款）再開 `"async"`，這個順序是對的，我不需要現在就拿到完整的 callback 機制。

在你問我這句「同步等待」怎麼實作之前，我想先確認我對整個協定的理解對不對，因為這直接決定我這邊要蓋的東西是不是真的像我原本以為的那麼簡單。你這份草案我重新梳理一次：**不是我送出推論請求給 onagent 之後、onagent 就回打工具呼叫**——時序上是使用者對 onagent 發起一次推論請求（例如透過 `AgentBridge` 或未來 tripace 自己後端呼叫 onagent 的推論 API），onagent 這邊的 LLM 在推論過程中**自主決定**要不要呼叫某個 `BackendDispatch` 工具，決定要呼叫，才會由 onagent 的 dispatch pipeline 主動對我登記的 `endpoint` 發一個 `POST`。我這邊完全不知道、也不需要知道使用者那次推論請求本身長什麼樣，我看到的第一個訊號就是這支 `POST`。這個理解如果沒錯，那答案是：**對，我這邊確實可以留一支無狀態的 API，被動等待就好**，不需要為了「等 onagent 回應」自己維護任何長連線或輪詢——這點跟第一輪討論的 browser-relay／WS 常駐模式完全不同，我很確定我沒有搞混。

但我要把「無狀態」這三個字定義精確一點，不然容易在實作時模糊帶過：

第一，**單次請求本身是無狀態的**——`POST {endpoint}` 帶著 `toolName`/`args`/簽章 header，我的 handler 驗完簽章、執行、回 `200`/`4xx`/`503`，整個處理過程不需要記得「上一次」發生過什麼，這個部分我完全同意可以做成一支標準的、可水平擴展的 stateless HTTP handler，跟我現有的 REST API 沒有本質差異。

第二，但**`action` 類工具的 idempotency 比對，代表我這端至少要有一個地方記錄「這把 key 我是不是處理過」**——這不是 handler 本身有狀態，是它背後要接一個去重儲存（哪怕只是一張表或一個 KV，存 `idempotencyKey` → 處理結果），嚴格說整個服務不是完全無狀態，只是狀態被隔離在資料層，跟 handler 本身無關。這件事對 `recommend_nearby` 這種 `query` 類工具不成立（`Retryable: true`、無腦重打，我這邊甚至可以刻意設計成真正的無狀態純函式），但如果之後真的要做「排入行程」這種 `action` 類工具，這一層去重儲存我要先預期進去，不是等真的要做才臨時加。

第三，`X-Onagent-Key-Id` 這個 header 我要正面回應——這個設計對我很有幫助，代表我不需要自己維護「現在是不是在密鑰並存期」這種狀態去反覆試兩把密鑰，直接查表對應就好，這個部分等於是你們把「該用哪把密鑰驗」這個狀態判斷留在你們那邊，我這邊只要有一張 `keyId → secret` 的對照表即可，這也是無狀態可以維持的原因之一——謝謝工程師在密鑰輪替設計時把這點考慮進去。

第四，一個具體的落地確認：`X-Onagent-Timestamp` ±5 分鐘容許誤差，我這邊的伺服器時鐘要對到什麼程度？我猜是一般 NTP 同步就夠、不需要到毫秒級校時，但既然這個誤差窗口會直接影響「我剛啟動、時鐘還沒校準就收到第一個請求」這種邊界情況要不要被拒絕，我想先確認清楚，這樣我在自己的部署檢查清單裡才知道要不要加一個時鐘校準的啟動前置檢查。

**第三方軟體開發者（Third-party developer）**：我想提一個跟前面幾輪都不同層次的問題，先講清楚範圍：我知道 `want`／onagent 內部目前都還有 process-wide 的併發瓶頸（我自己這邊 `wanttools/sink.go` 的 `recordMu` 也是同一種全域鎖序列化整個訊息處理流程），這件事雙方都在往多租戶隔離的方向推進，我不是要在這裡重提那個——那是雙方各自內部的既有已知項目，不是這次協定設計要解的問題。

我想確認的是**協定本身**：現在草案裡 `POST` 的 body 是 `toolName`/`args`/`idempotencyKey`/`dispatchedAt`，headers 是 `Timestamp`/`Nonce`/`Signature`/`Key-Id`。我把這份 payload 完整看過一遍，發現一件事——**`Key-Id` 只能告訴我這支請求來自哪個 app（也就是「這是 tripace」），但沒有任何欄位告訴我這是 tripace 底下哪一個使用者、哪一段對話觸發的**。`args` 是 LLM 自己填的工具參數（`place`/`category`/`radius_meters` 這類），不是系統管線注入的識別碼，我不能也不該要求 LLM 每次呼叫都自己記得、自己填一個不透明的使用者/session ID 進去——這不是它該負責決定的東西，而且只要有一次 LLM 忘記填或填錯，我這端就完全失去這通呼叫的歸屬依據。

這件事對我有三個實際影響，不是理論擔憂：第一，我自己的 `GOOGLE_PLACES_API_KEY` 有用量配額，如果某個使用者的行程規劃觸發異常大量呼叫（例如自動安排功能真的上線後，一輪規劃連續觸發好幾次 `recommend_nearby`／未來的交通時程查詢），我需要能在自己這端做 per-user 限流，不然一個使用者就可能把我全部 tripace 使用者共用的配額吃光；第二，日後如果要做個人化推薦（我們已經在討論的方向——依使用者喜好排查地點），工具執行當下要能知道「這是哪個使用者」才能查到對應的偏好設定；第三，光是要除錯／記錄「這次 `recommend_nearby` 呼叫是哪個使用者的哪一輪對話觸發的」，現在的 payload 完全沒有線索，我只能靠 `args` 裡剛好帶的地點名稱去猜，這不是可靠的關聯依據。

我想指出一個好消息：這個問題在 `want` 自己的架構裡已經有現成的解法，不是新問題，而且我們自己的系統已經實際用過這個解法一次。`want` 的 `ToolContext` 有 `GetSessionEnvs()`，由 orchestrator 在呼叫前用 `SetSessionEnvs` 注入，跟 LLM 決定的 `args` 是完全分開的兩條路徑——我們自己 `wanttools/sink.go` 的 `TripFrom(ctx)`（讀 `ctx.GetSessionEnvs()["tripID"]`）就是這樣讓 `recommend_nearby` 知道要查哪個行程用的資料，而不是叫 LLM 自己把 `tripID` 當成一個工具參數填。更直接的先例是我們自己另一套機制 `internal/clienttools`（`tool.go`/`interaction.go`）——那邊原本用 `ctx.GetAgentID()` 當 session 識別碼，後來改成 `ctx.GetSessionEnvs()["sessionID"]`，就是為了同一類「需要一個系統層級、非 LLM 決定的識別碼跟著工具呼叫走」的需求。這代表我們自己已經在類似情境下踩過這個坑、修過一次，onagent 這邊的 `BackendDispatch` 協定要是現在不設計好，很可能是同一個問題换個地方重演。

我的具體請求：能不能在 `Request` body 裡（或用一個新 header，我沒有特別偏好哪種形式）加一個 onagent 自己生成、跟 `idempotencyKey` 不同生命週期的識別碼——`idempotencyKey` 是單次 action 的重試去重用，這個我要的是**跨整個使用者對話／規劃 session 穩定不變**的識別碼，同一輪多次呼叫（例如 N² 距離查詢）要能看出彼此屬於同一個使用者的同一次規劃。這個識別碼對我來說完全是不透明字串，我不需要知道 onagent 內部怎麼定義「session」，只需要它在同一個使用者的同一段對話裡保持一致、不同使用者之間絕對不重複，讓我這邊能拿它當 key 做 per-user 限流／關聯日誌／未來讀取使用者偏好資料，就夠了。

架構師，這是我覺得現在協定草案唯一還沒覆蓋、但會直接卡住「多人同時使用」這個場景的缺口——不是 onagent 內部的併發能力問題，是協定有沒有把「這通呼叫屬於誰」這個資訊帶給第三方的問題。

**系統架構師（Systems architect）**：開發者，這個缺口我認同，而且要講清楚——這不是一個「順便補一下比較完整」的小修正，是協定目前確實有一個結構性的洞，不能輕描淡寫帶過去。你舉的三個影響（per-user 限流、個人化推薦、除錯歸屬）都是真實會卡住「多人同時使用」這個場景的問題，不是理論擔憂。

而且你舉的類比非常精準，我直接照你的說法承認：onagent 呼叫你這邊的 `BackendDispatch` 工具，跟 `want` 呼叫後端工具、需要把 session context 帶給它，本質上是同一類問題。`want` 自己都已經用 `GetSessionEnvs()`／`SetSessionEnvs` 把「系統層級識別碼」跟「LLM 決定的 args」拆成兩條路徑，理由跟你講的一模一樣——不能要求 LLM 自己記得填一個它不該負責決定的不透明 ID。onagent 沒有理由在自己對外的協定裡不做同一件事，尤其你們自己 `internal/clienttools` 從 `GetAgentID()` 改成 `ctx.GetSessionEnvs()["sessionID"]` 這個先例，等於已經替我們把這條路踩過一次坑、也驗證過修法方向是對的。這不是要不要做的問題，是要補進這一輪的必要缺口。

方向上我傾向這樣處理：在 Request 裡加一個新欄位，先假定用 header（例如 `X-Onagent-Session-Id`），由 onagent 的 dispatch pipeline 在發出 `POST` 當下，從它內部已經知道的「這是哪個使用者、哪一段對話」的識別碼衍生出一個不透明字串放進去，跟 `idempotencyKey` 完全分開的生命週期——這個要跨整輪對話穩定不變。關鍵設計原則是「不透明」：你只需要拿它當 key 做限流、關聯日誌、查偏好設定，不需要知道也不應該依賴它的內部格式，這樣未來 onagent 內部怎麼調整 session 模型，都不會破壞這個欄位對你的語意承諾。

工程師，下一輪要請你查兩件事：第一，onagent 內部現在實際用來識別「這是哪個使用者、哪一段對話」的東西是什麼——是已經有一個乾淨的 session id，還是要靠 user id 加 app id 組合、甚至現在根本沒有一個可以直接拿出來用的統一識別碼；第二，如果有，這個內部識別碼能不能直接衍生成給第三方的不透明字串，還是需要額外一層轉換（例如雜湊過）避免直接洩漏內部 ID 的格式或可猜測性。這兩件事我沒有把握用印象斷言，需要你查證後回來定案。

開發者，「排除併發瓶頸不是這次要談的範圍」這個界定很清楚，不需要在這裡回應，收斂到位。這個 session 識別碼的缺口確認、工程師下一輪查完之後，這輪應該就可以真正進結論了。

**資深工程師（Senior engineer）**：我查了三個地方，直接講結論——架構師這個方案，語意上有落差，先講清楚才不會後面卡住。

第一，`backend/internal/ws/session.go` 第 65 行，`id: randomID()`，這是 `NewSession` 每次被呼叫時產生的，而 `NewSession` 是每條 WebSocket 連線建立時才會跑一次。註解自己寫得很白：「one Session per browser tab」。這代表 `s.id` 綁定的是「一次瀏覽器分頁的一條 WS 連線」，不是使用者。同一個人重新整理頁面、開新分頁，會拿到全新的 `randomID()`，跟前一次連線完全無關聯。

第二，`backend/internal/inference/want.go` 裡的 `SessionID`（`sessionKeyFor`、`getOrCreate`）現在的值，就是直接吃 `ws.Session.s.id` 傳進去的（見 `session.go` 的 `s.infer.Complete(ctx, inference.Request{..., SessionID: s.id})`）。所以這一層的 `sessionID` 語意跟上面完全一樣，就是「一次 WS 連線」，套一層 orchestrator 隔離而已，沒有引入任何新的、更貼近「使用者」的識別碼。連檔案本身的註解都寫「no per-user session concept」（`sessionKeyFor` 的 doc comment，講的是空字串 fallback 那個情境，但等於承認這系統目前壓根沒有 per-user 這個概念）。

第三，我搜過整個 backend，「使用者」這個型別只有兩種：console 那邊登入管理 app 的開發者帳號（跟這次議題無關），還有 `authAppID`——這只到 app 層級，驗證「這是哪個 app 的合法連線」，不含任何終端使用者身份。第三方 app 前端實際使用行程規劃功能的那個「人」，onagent 完全沒有追蹤，連個 opaque identifier 都没有，只知道「這是某個 app 的某條 WS 連線」。

所以老實講：架構師提的「衍生成不透明字串」這個技術做法（雜湊 `session.id` 之類的）沒問題，可以做，但衍生出來的東西本質上是 session-level，不是 per-user。如果開發者要拿 `X-Onagent-Session-Id` 做 per-user 限流，會失準——同一使用者兩個分頁、或重整一次頁面，就是兩個不同的 session id，限流會被繞過或誤傷。

我的建議：這一輪先做 session-level 的識別碼，明確定位成「同一輪對話/同一條連線內的呼叫可關聯」，不要在 header 命名或文件裡暗示它是 per-user。真正的終端使用者身份是另一個題目——onagent 目前完全沒有這個概念，要做的話得由第三方 app 自己在 hello 階段告知使用者 ID，或者我們設計新的身份層，這次不建議捲進來。

**系統架構師（Systems architect）**：工程師，先講清楚：你查到的三件事我全部接受，這是紮實的事實查證，不是可以爭辯的東西——`session.id` 是分頁層級、`want.go` 的 `SessionID` 沿用同一語意、onagent 完全沒有終端使用者這個型別，這三點我一字不改地照收。但你最後那個結論——「這一輪先做 session-level，per-user 這次不建議捲進來」——我要在這裡明確推翻，不是延續。

這場會議的性質從一開始就是「規劃並實現一個新能力」，遇到現有系統做不到的地方，正確反應是設計出讓它做得到的方法，不是因為現在沒有就退而求其次、拿一個語意不符的替代品交差。開發者要的是 per-user 限流、個人化推薦、除錯歸屬，這三件事的共同前提是「同一使用者的呼叫可被穩定識別」，而 session-level 識別碼在定義上就做不到這件事——同一使用者兩個分頁就繞過限流、重整頁面就斷了歸屬鏈。把一個已知會失準的東西包裝成不透明字串交給開發者，讓他誤以為問題解決了，這不是負責任的架構決策，是把風險藏起來而已。

所以這次要做的是：設計一個 per-user 身份機制。方向如下——第三方 app 前端在 `hello` 階段，除了現有的 `appId`，額外攜帶一個**由第三方自己定義的終端使用者識別碼**，例如 `userId`。這個 ID 由第三方自己的使用者系統產生，onagent 不需要理解它的格式，只要求同一 app 內唯一即可——這其實正是 tripace 案例本身在示範的事：tripace 自己就有使用者系統，識別碼由第三方提供最自然，onagent 沒必要也不該自己發明一套使用者身份系統。

onagent 這邊把這個第三方提供的 `userId`（結合 `appId` 做命名空間隔離，避免不同 app 的 `userId` 撞名）存進 session context，讓它跟著這條連線的所有工具呼叫走。這樣即使同一使用者開多個分頁、重整頁面，只要第三方前端在 `hello` 時都帶同一個 `userId`，onagent 就能把這些不同的 WS 連線關聯到同一個使用者。這個 `userId`（加 `appId` 命名空間後）就是拿來衍生對外欄位的來源——header 名稱我建議改成更精確的 `X-Onagent-User-Ref`，不再叫 `Session-Id`，因為語意已經不同，命名要誠實反映內容。

安全性上要跟開發者說清楚一件事：這個 `userId` 是第三方自己宣稱的，onagent 不驗證它的真實性——因為 onagent 本來就不管第三方前端怎麼認證自己的使用者，這條信任邊界跟現有的 `appId` 認證模型是一致的。但這不影響它拿來做限流、關聯用途的價值，只是開發者要理解它的保證等級是「第三方自己宣稱且自己負責」，不是 onagent 背書的身份驗證結果。

對現有架構的影響：`hello` 協定要加一個可選欄位、`ws.Session` 要多存一個欄位。per-session 的 `Orchestrator`/`sessionID` 那條路徑我認為不需要變——那是另一層的技術隔離機制，跟這次要新增的「使用者身份標記」是兩件事，可以並存不衝突，工程師下一輪確認這個判斷對不對。

工程師，下一輪請你查證這個新欄位具體要加在 `hello` 協定跟 `ws.Session` 程式碼的哪些精確位置，以及命名空間組合（`appId:userId`）的實作方式。開發者，這個方向能不能滿足你提的三個訴求——per-user 限流、個人化推薦、除錯歸屬？如果可以，這輪就照這個方向定案。

**資深工程師（Senior engineer）**：查完了，先講結論：架構師的判斷基本正確，這確實是小改動，但有一個位置沒有一比一對應到，要指出來。

第一，`hello` 協定欄位。`backend/internal/protocol/message.go` 第 64-69 行的 `HelloPayload`，目前只有 `AppID`（65 行，`json:"appId"`）、`SDKVersion`（66 行）、`PageURL`（67 行）、`InitialData`（68 行）四個欄位。新增一個 `UserID string \`json:"userId,omitempty"\`` 加在 69 行前，語法上跟 `SDKVersion`／`PageURL` 同款式，omitempty 讓舊版 SDK 不帶這欄位也不出錯，符合「可選欄位」的要求。這步確實如架構師預期，沒有結構障礙。

第二，`ws.Session` 讀取跟存放的位置。目前 `appId` 的路徑是：`handler.go` 先用 auth token 解出 `authAppID`（88-127 行），傳進 `NewSession`（session.go 60 行）存進 `s.authAppID`（40 行）；`handleHello`（187-223 行）解出 `p.AppID` 後，若 `s.authAppID != ""` 就整個覆蓋掉客戶端宣稱的值（199-202 行），只有 `authAppID` 為空（auth 關閉）時才信任 client 的 `p.AppID`。這裡要提醒一點：`userId` 沒有對應的「伺服器驗證」來源——架構師的方向本來就講明是「第三方自己宣稱，onagent 不驗證」，所以 `userId` 不用比照 `appId` 這套「server-verified 覆蓋 client-claimed」的邏輯，直接在 `handleHello` 裡讀 `p.UserID` 存進新欄位即可，不需要在 `Handler`／`NewSession` 簽名加參數，比 `appId` 那條路徑還單純。新欄位建議加在 `Session` struct（30-54 行）裡，跟 `app *toolschema.App`（45 行）同一組，例如 `userRef string`，在 `handleHello` 裡跟 `s.app = app`（211 行）同一段 `s.mu.Lock()` 保護區塊寫入。

第三，驗證 `sessionID` 這條路徑不受影響。`s.id`（62 行 `randomID()`）目前只流向兩處：`inference.RegisterAsker(s.id, ...)`（81 行，query tool 回呼用）跟 `inference.Request{..., SessionID: s.id}`（275 行，want.go 200 行 `sessionKeyFor` 拿去對應 orchestrator）。這兩處都不吃 `appId`／`userId`，加一個新欄位完全不用碰這段邏輯，架構師「兩者可並存」的判斷查證屬實。

第四，命名空間串接的疑慮成立。`appId + ":" + userId` 直接字串串接確實有邊界案例——如果第三方的 `userId` 剛好含冒號（不無可能，有些系統拿 email 或複合鍵當使用者 ID），跟另一個 `appId` 較短、`userId` 開頭吃掉冒號後半剛好撞上別的組合，理論上會碰撞。加上架構師先前已經定調「不透明」設計原則，建議直接對 `appId + "\x00" + userId`（或任何分隔符）取 SHA-256 雜湊、輸出固定長度十六進位字串當 `X-Onagent-User-Ref`，一次解決碰撞跟不透明兩個要求，不需要額外處理轉義。

補充一點文件目前沒提但值得注意：`AckPayload`（71-75 行）已經有一個 `SessionID` 欄位，跟這次新設計的 `X-Onagent-User-Ref` 是完全不同語意（一個是連線層級、回傳給 client 用；一個是使用者層級、對外給第三方 backend 用），命名沒有衝突但容易讓人搞混，建議規格文件裡明確寫一句消歧義說明。

**第三方軟體開發者（Third-party developer）**：架構師，先給明確答案：這個方向滿足我提的三個訴求，而且我要指出一點——你說「識別碼由第三方提供最自然」，這正好就是 tripace 的實際情況，不是巧合。tripace 本來就有自己的使用者系統，使用者登入後就有 `userID`，`hello` 階段多帶這一個欄位對我完全不是負擔，我這端本來就有這個值躺在那裡。per-user 限流、個人化推薦、除錯歸屬這三件事的共同前提就是「同一使用者的呼叫能穩定識別」，`X-Onagent-User-Ref` 跨分頁、跨重整都能關聯到同一人，三個訴求都直接滿足，沒有疑慮殘留。

「onagent 不驗證 `userId` 真實性」這條信任邊界我可以接受，而且我認為這個責任劃分是對的：我自己的前端本來就已經做過使用者登入驗證，onagent 沒有理由重複做一次。我原本想過「惡意第三方前端偽造別人 `userId` 冒用」這個疑慮，但想清楚了——onagent 從來就沒有機制驗證「這條 WS 連線背後真的是它宣稱的那個 app」之外的任何身份層級，這條信任鏈本來就該由我自己對我的終端使用者負責，onagent 只是被動傳遞，這不是它該解決的問題。

SHA-256 雜湊＋固定長度輸出完全沒問題，我要的本來就是不透明穩定字串，不需要人類可讀。除錯歸屬上我確認過：雖然雜湊字串反推不出是誰，但同一使用者每次產出的雜湊值固定不變，我在自己的日誌系統裡照樣可以用它當 key 搜尋「這個使用者的所有呼叫」，這對我來說夠用。

消歧義提醒有幫助，`AckPayload.SessionID`（連線層級）跟 `X-Onagent-User-Ref`（使用者層級）我會在自己的 SDK 整合文件裡清楚寫明不要混淆。

最後一個延伸考量：tripace 使用者系統如果之後允許帳號合併或跨裝置用同一 `userID` 登入，這對 `X-Onagent-User-Ref` 有沒有影響？我自己想過——這個 `userId` 完全是我方定義並傳遞的，只要 tripace 內部維持這個 `userID` 本身的一致性，onagent 端自然會拿到一致的雜湊結果，這不是新問題，只是延續同一個設計決策的自然結果，沒有額外風險需要現在處理。

**第三方軟體開發者（Third-party developer）**：架構師，我想倒回去補一個缺口，這個缺口我自己也有責任——剛才 217 行那句「使用者對 onagent 發起一次推論請求」，我當時輕描淡寫帶過去了，沒有真的展開問「這第一次請求到底怎麼發起」，這次我要補回來，不是甩鍋。

問題是這樣：我重讀了 `backend-tool-dispatch-design-2026-08-08.md` 全文，整份方案，包括第 6 節的 `X-Onagent-User-Ref`，都只描述「onagent 主動打我後端」這一段——也就是這個方案的「回程」。完全沒有任何地方講清楚「onagent 怎麼收到觸發這輪 LLM 推論的第一個請求」——也就是「去程」。但我最初第一輪就提過「排程觸發的自動化流程」跟「純 API 產品，完全沒有 UI」這兩種場景，如果去程仍然預設要靠瀏覽器發起 `hello`，那 BackendDispatch 這整套方案對這兩種場景其實還是沒解決問題，只是把「工具呼叫」搬到後端，「怎麼開始這輪對話」這個更基本的前提還卡在瀏覽器模型上。

我看到兩種可能的觸發方式，但都有疑慮，先攤開來說：

方式一，沿用現有 `AgentBridge`／WS `hello` 模型。這對排程觸發、無 UI 的場景不成立，除非要求我維護一支常駐的假瀏覽器去發 `hello`——但這正是第一輪已經被判定「用不對的工具做不對的事」而否決掉的 browser-relay 模式，我不想繞回去走這條已經被斃掉的路。

方式二，onagent 開一個全新的、給第三方**後端直接呼叫**的 HTTP 推論 API，例如 `POST /v1/apps/{appId}/complete`，帶 `prompt`／`userId`／認證，完全不經過 WS／瀏覽器。這樣 `userId` 就能直接當這支 API 的欄位傳入，不用依賴一個對我這種場景根本不存在的 `hello` 階段。我認為方式二才是真正對上我最初需求的方向，但我想先確認：onagent 現在是不是已經有類似的內部 API，哪怕只是給 console／playground 用的雛形，還是完全要從零新建？

如果是方式二，這對已經拍板的 `X-Onagent-User-Ref` 設計有連帶影響：`userId` 的傳遞位置要從「`hello` payload」改成「這支新推論 API 的 request body 或 header」，這是對拍板方案的修正，不是推翻，但需要說清楚、寫進文件。

架構師，這是不是這次討論意外漏掉的核心缺口——onagent 現在到底有沒有一個「非 WS、給第三方後端直接呼叫」的推論觸發 API？這件事沒釐清，PoC 範圍再乾淨，我這邊排程觸發那個場景還是接不上。

**資深工程師（Senior engineer）**：架構師，我照開發者提出的問題查了程式碼，結論很明確：onagent 目前**完全沒有**任何一條非 WS、走 POST 就能觸發 LLM 推論的 HTTP 入口，連雛形都沒有。

先看路由表。`backend/cmd/server/main.go` 241-260 行是全部的 `mux.Handle`/`mux.HandleFunc` 註冊：`/ws`（`wsHandler`，WS upgrade）、`/apps/{appId}/tools.json`、`/apps/{appId}/tools.ts`（純 codegen，不碰推論）、`/healthz`，再加上 `mountCredentialedRoutes` 掛的 `/console/*`、`/auth/*`、`/admin/api/*`。這裡面沒有任何一條是"POST 進來直接觸發 Complete"的路徑。

再看 `inference.Service.Complete` 的呼叫者，全專案只有兩處（排除 `_test.go`）：`backend/internal/ws/session.go:271`（`s.infer.Complete`，就是開發者提到的 `handlePrompt`）和 `backend/internal/console/playground.go:221`（`h.Inference.Complete`）。第二個聽起來像是缺口的候選，但我查了 `playground.go`——它註冊在 `console.go:94`：`mux.HandleFunc("GET /console/apps/{appId}/playground", h.withOwnedApp(h.playgroundWS))`。方法名雖是 `GET`，但 `playgroundWS`（playground.go:105-120）一進來就 `upgrader.Upgrade(w, r, nil)`（116行）把連線升級成 WebSocket，走的是它自己那套簡化版 envelope 協定（playground.go:18-42 的套件註解寫得很白：「這是刻意獨立於 internal/ws 的一套協定」）。所以連 playground 都是 WS，只是認證方式換成 console 的 session cookie，不是 API key。

也就是說，`inference.Request.SessionID` 這個欄位（inference.go:43-48）目前唯二的兩個來源，一個是 `ws.Session.id`（真實 WS 連線），一個是 playground 自己拼出來的 `PG-<userID>-<appID>`（playground.go:126）——兩者都預設「背後有一條活著的 WS 連線」在管生命週期（`CloseSession` 都是 `defer` 在連線關閉時呼叫）。方式二等於要新增一個系統裡目前不存在的東西。

如果真要做，我認為架構師必須先拍板一個問題：新 API 觸發推論後，`SessionID` 從哪來？沒有 WS 連線就沒有 `ws.Session.id` 這種天然、隨連線生滅的識別碼。認證本身不難，`auth.Store.Verify(apiKey string)`（auth 套件 81 行）現有邏輯可以直接複用來驗 `Authorization: Bearer <apiKey>`，不需要碰 WS handshake 那段。但 session 這塊要嘛「每次呼叫都是全新一次性 session」（等於放棄多輪對話記憶），要嘛「第三方在 request body 自己傳 conversationId，onagent 對應到 orchestrator map 的 key」——後者還要另外解決這個 map 何時清、誰來呼叫等價於 `CloseSession` 的動作，因為沒有連線斷開這個天然觸發點了。這件事沒有 WS 可以借用，得從零想。

**系統架構師（Systems architect）**：開發者，先講一句重話：這不是我們這輪意外多發現的一個小補丁，是一個真正的遺漏，而且如果不修，整套已經拍板的 `BackendDispatch` 方案——密鑰輪替、簽章協定、`X-Onagent-User-Ref`——對你最初提的「排程觸發」「純 API 產品、無 UI」這兩個核心場景其實是空的，因為去程根本進不來。這件事的優先級要提到跟回程一樣高，不是「順便補一句」就能帶過。工程師查證得很清楚：全專案沒有任何非 WS 的推論入口，連 playground 都是包著 WS upgrade 的殼，`inference.Service.Complete` 兩個呼叫者全部靠 WS 連線生命週期管 `SessionID` 和 `CloseSession`。方式一等於繞回已經被否決的 browser-relay，這條路不用再討論。

裁定：走方式二。新增一支獨立於 WS 之外、給第三方後端直接呼叫的 HTTP 推論 API，`POST /v1/apps/{appId}/complete`，body 帶 `prompt`、`userId`、可選的 `conversationId`；認證用 `Authorization: Bearer <apiKey>`，複用現有 `auth.Store.Verify`，不用重新設計一套。`userId` 這欄跟我們剛拍板的 `X-Onagent-User-Ref` 是同一條設計思路的延伸——只是傳遞位置從「`hello` payload」搬到「這支新 API 的 request body」，語意、雜湊衍生、命名空間串接的規則完全沿用，不需要另立一套。

`SessionID` 從哪來，工程師列的兩個方向我選第二個：第三方在 request 帶 `conversationId`，onagent 對應到 orchestrator map 的 key。理由很直接——一次性 session 對排程通知這類單發場景夠用，但對開發者你自己最在意的「LLM 自主規劃整趟行程」不夠：規劃一趟行程如果需要你後端連續呼叫這支 `/complete` 好幾次才能收斂，每次都開全新 session 就會讓每次呼叫都失去前一次的規劃上下文，這跟 N² 距離查詢那種「同一輪內」多次工具呼叫不是同一個問題——那個在單一 session 內本來就沒事，但「跨多次 `/complete` 呼叫」需要的是 session 本身能延續，一次性 session 從根上就不滿足這個需求。

代價是要解決 map 何時清除。我的方向：引入閒置逾時機制，例如 30 分鐘沒有新請求就自動觸發等價於 `CloseSession` 的清理，不依賴連線斷開事件。這個做法比「等連線斷開」更通用，順帶一提它可能也適用於 WS 那邊某些異常斷線沒正常觸發 defer 的邊界情況，但這只是順便一提，不在這裡展開，避免範圍蔓延。

這次刻意不展開：這支 API 跟 `/console`、`/auth` 既有路由群組的關係、rate limit 怎麼設計、要不要支援串流回應，這些細節留給下一輪。工程師下一輪查證三件事：一、這支新 API 具體要掛在 `main.go` 哪個路由群組，是仿 `mountCredentialedRoutes` 的模式獨立一組還是併進去；二、認證中介層能不能直接複用 `mountCredentialedRoutes` 現有結構；三、閒置逾時清除 session 這個機制如果採用，大概要怎麼實作——需要一個背景 goroutine 定期掃描，還是有更輕量的 timer 機制可以用。

**資深工程師（Senior engineer）**：架構師交辦的三件事我下一輪會回，但在查之前，我想先插一段——這兩輪我們一直卡在 `SessionID`／session 生命週期怎麼設計、還有更早非同步 callback 那組認證反轉／多副本 process 對不上的問題，這兩個都是「LLM 呼叫外部工具」這個問題領域裡很根本的難題，我覺得有必要去看業界最新、同樣在解這個問題的權威規格怎麼處理，而不是只在我們自己的既有結構裡打轉。我去讀了 Anthropic Model Context Protocol（MCP）2026-07-28 版規格更新，裡面兩處設計跟我們卡住的地方直接對上，想攤出來讓大家重新檢視。

第一個發現：MCP 這次把 protocol-level session 整個拿掉了，連 `Mcp-Session-Id` header 都移除，做成 stateless protocol core。官方給的理由原文是「any request can now land on any server instance behind a plain round-robin load balancer without needing shared storage」。如果 server 真的需要跨多次呼叫延續狀態，他們的建議是：「If your server needs to carry state across calls, mint an explicit handle from a tool and have the model pass it back as an argument... the model can see the handle and thread it between tools.」——不是藏在 transport 層，而是明著做成一個 model 自己會傳遞的參數。

對照架構師剛拍板的方案：第三方傳 `conversationId`，onagent 內部維護一個 orchestrator map、搭配 30 分鐘閒置逾時清理。這本質上就是 MCP 說的「藏在 transport 層的 session state」，只是我們的版本是「第三方傳 ID、onagent 內部映射到內部物件」。MCP 更進一步的建議是：乾脆不要在 onagent 內部維護這個有生命週期、需要被動清理的 map，而是每次呼叫都無狀態，把需要延續的狀態（例如規劃到哪一步、已知候選點列表）直接編碼進一個回傳給第三方的 handle/token，第三方下次呼叫把它當參數傳回來，onagent 解碼還原狀態。這樣可以完全避開「session 何時清除」這整個問題——沒有 server-side 保管的狀態，就沒有東西需要被清除，30 分鐘逾時這個機制本身也不需要存在。但代價要老實講：state 要能安全編碼進一個可以來回傳遞的 token，可能需要加密／簽章防第三方竄改；如果狀態量大（例如完整行程規劃上下文），編碼進 token 未必輕量。這是一個需要重新評估的取捨，不是「MCP 這樣做我們就該跟」。

第二個發現：MCP 處理長時間執行操作用的是 Tasks 框架，以 poll-based（`tasks/get`）為主，搭配可選的訂閱式事件流（`subscriptions/listen`），不是走 callback/webhook 反向打回呼叫端。這裡要先想清楚方向，因為我們的情境跟 MCP 標準情境角色相反：MCP 是 client 呼叫 MCP server 的工具，server 處理慢，client 對 server 做 `tasks/get` 輪詢；我們是 onagent 呼叫第三方的工具，第三方處理慢，對應的輪詢方向應該是「onagent 對第三方輪詢」，不是我們原本設計的「第三方 callback 回 onagent」。如果改成這個方向：dispatch 後先拿第三方回的一個 task ID，onagent 之後定期發 `GET {endpoint}/tasks/{taskId}` 問狀態——這樣可以完全避開我們最頭痛的兩個問題，「callback 認證方向反轉」跟「callback 打到錯的 process」，因為輪詢發起方跟原本 dispatch 呼叫發起方是同一個（onagent），不需要開新的 inbound 路由給第三方呼叫進來，也不需要解決多副本部署下 pending-callback map 對不上 process 的問題——輪詢可以由發起 dispatch 的同一個 process 自己排程，或者輪詢本身也做成 stateless、每次都是獨立的 GET 請求。

整體看法：這兩個發現都不是要推翻已經拍板的方向，但都指向同一個簡化可能性——盡量讓 onagent 少維護「需要生命週期管理」的狀態，不管是 session map 還是 pending-callback map，能做成 stateless／輪詢的地方就不要做成 stateful／callback。但這是不是要重新拍板，涉及架構師的判斷，我只是把研究發現跟具體取捨攤開來，不會自己下結論說一定要改。

架構師、開發者，這兩個方向要不要納入評估，或者原本的設計（`conversationId` + 閒置逾時、callback 反向認證）已經有足夠好的理由維持不變，想聽聽你們的看法。

**系統架構師（Systems architect）**：工程師這次帶回來的兩個發現我都認真看了，先講態度：參考業界最新規格、但不是規格新就照單全收，這個方法論本身我完全支持，也謝謝你花時間去讀。但兩個發現的裁定結果不一樣，我要分開講清楚，不能因為都出自同一份規格就一併採納或一併駁回。

先講發現一。MCP 建議用「明確 handle 讓 model 自己傳遞」取代藏在 transport 層的 session state，這個思路本身沒問題，但關鍵是要先問：MCP 的 handle 對應到什麼量級的狀態？它對應的是「client 呼叫 server 上某個具體 tool、需要延續一次操作」——一個 handle 通常只承載一個資源或一次操作的延續資訊，量級很小，適合編碼進一個能在 request/response 之間來回傳遞的 token。但我們的 `conversationId` 對應到的是完全不同量級的東西：整個多輪對話、LLM 已經看過的所有歷史訊息、之前呼叫過的所有 `BackendDispatch` 工具結果——這是一個完整推論 session 的全部上下文，不是一次工具呼叫的 handle。把這種量級的狀態編碼進一個第三方要原樣帶著跑的 token，不只是「需要加密簽章防竄改」這種工程細節問題，是狀態量本身就不適合放進一個 HTTP 往返之間傳遞的欄位。這才是決定「該不該套用 MCP 這套」的關鍵判斷點，不是「MCP 這樣做比較新所以比較好」——規格新舊從來不是我們的判斷依據，場景是否對應才是。

裁定：維持 `conversationId` + orchestrator map + 閒置逾時，不改。但發現一不是白做的研究——我接受一個具體修正：既然我們自己也承認這是「藏在 transport 層的狀態」，那閒置逾時機制本身應該更保守、更明確，我傾向把 30 分鐘這個數字重新檢視、或要求第三方在逾時前有一個明確的「延續」信號，而不是被動指望它一直有新請求進來。另外，如果未來 onagent 真的要做更輕量的單次工具呼叫模式（不需要完整對話歷史的），handle 模式值得考慮——但那是另一個使用情境，不該現在硬套進「完整推論 session」這件事上。

發現二，這個我要認真評估，因為工程師點出的兩個痛點是真的——callback 認證方向反轉、多副本部署下 pending-callback map 對不上 process，這兩個我們上一輪討論時就承認是懸而未決的問題，不是這次才發現的新麻煩。輪詢方向反過來確實同時解掉這兩個：輪詢發起方跟 dispatch 發起方是同一個 onagent，不需要開新的 inbound 路由讓第三方打進來，也就不存在「認證方向要反過來」這回事；輪詢也不需要一個跨 process 共享的「等待中」狀態表——每一次 `GET {endpoint}/tasks/{taskId}` 都是獨立、無狀態的查詢，打到哪個 onagent 副本都能各自發起，不需要跟原本 dispatch 的那個 process 是同一個。

裁定：採納，作為 async 模式的正式設計方向，取代原本的 callback 方案。具體修改：`ActionDispatch.Mode: "async"` 啟用時，第三方收到 dispatch 後回 `202 Accepted`，body 帶一個第三方自訂的 `taskId`；onagent 不再開放 callback endpoint 讓第三方呼叫進來，而是自己排程定期發 `GET {endpoint}/tasks/{taskId}`，輪詢間隔可以參考 `retryBackoff` 的節奏，直到拿到終態或整體逾時。對第三方開發者來說這也更輕：不用開一個新的 inbound endpoint 給 onagent 呼叫、不用自己維護反向認證，只需要多開一支查詢用的 GET，跟他們原本要做的正向 REST API 沒有本質差異。

但我要提醒一句，這是對「萬一要做 async」這個答案的修正，不是推翻已經拍板的排序——`Mode: "async"` 現在仍然只是預留欄位，PoC 不實作，值域現在還是只開 `"sync"`。這次改動的只是「以後真的要開 async 時該用什麼機制」，不影響目前的優先序。

開發者，我想聽你對輪詢模式方向的具體意見——對你來說，維護一支查詢用的 GET endpoint，跟原本要維護一支 inbound callback endpoint（還要處理反向認證），哪個實作起來更輕鬆？如果輪詢明顯更簡單，這會進一步強化我這個裁定的信心。

最後跟工程師說一句：這次的研究做得很好，去查業界權威規格、但沒有直接把結論套進來，而是拆解「它的場景假設是什麼、跟我們的場景哪裡一樣哪裡不一樣」再回來給我們判斷材料——這正是我期待的方式，繼續保持。

**第三方開發者（Third-party developer）**：先回架構師問的輪詢 vs callback 問題——輪詢明顯更輕鬆，這點我可以肯定地說。維護一支 `GET /tasks/{taskId}` 對我來說就是照抄我們原本 `recommend_nearby` 那套既有查詢端點的認證與路由模式，跟平常寫任何一支 REST API 沒有差別；callback 方案要我們額外處理「反過來驗證 onagent 打進來的簽章」這件事，等於我們的後端要同時扮演「呼叫方」跟「被呼叫方」兩種角色、各自一套認證邏輯，維護心智負擔明顯更高。輪詢方向這個裁定我完全支持。

我這輪重讀了 `backend-tool-dispatch-design-2026-08-08.md` 全文，對照 tripace 這邊打算拿 `recommend_nearby` 當 PoC 落地目標的實際情況，發現三個目前方案沒講清楚、但會直接卡到落地的問題，攤出來給大家看：

第一個，關於 `X-Onagent-User-Ref` 的來源。第 6 節寫的是「`hello` 協定新增可選欄位 `userId`」，衍生出 `X-Onagent-User-Ref` 後「存進 `ws.Session` 新欄位，跟隨該連線的所有工具呼叫」——這整段描述的前提是有一個活著的 WS 連線。但 `BackendDispatch` 是 onagent server 直接發 outbound HTTP 到我們後端，不經過瀏覽器 `hello` 流程，而第 3 節的 Headers 清單裡 `BackendDispatch` 的請求一樣列了 `X-Onagent-User-Ref`。這代表這個 header 實際上有兩條完全不同的來源路徑：一條是既有 WS session 帶出來的 `userRef`（`hello` payload 來的 `userId`），另一條是透過新的 `POST /v1/apps/{appId}/complete` 觸發時，`userId` 只能來自 `complete` API 的 request body。以我們的情境對應：未來「AI 主動排行程」很可能是背景/排程觸發，不一定有活著的瀏覽器分頁，走的會是後者。兩條路徑共用同一個 header 名稱、但輸入來源不同，這點目前文件沒有明講，我建議至少在第 6 節或第 3 節補一句話消歧義，不然實作時兩邊很容易各自猜一套。

第二個，是我們這邊落地時要注意的參數細節，不是協定設計問題，先講清楚不需要 onagent 改動什麼。`recommend_nearby` 目前是純 in-process 呼叫（`server/internal/wanttools/recommend_nearby.go` 直接呼叫 `geo.Search`，沒有網路往返），换成 `BackendDispatch` 後會多一段簽章 HTTP 往返，且要配置全新的 per-tool `timeoutMs`。第 3 節提到這個逾時「需求上等同於現有 `interactionTimeout`」，但那是給等瀏覽器回應設計的 20 秒基準，對一個本來幾十毫秒內完成的查詢來說明顯過長；但如果我們貪快配太短，Google Places API 自己的尾端延遲（尤其 `SearchNearby` 遇到 Google 端限流）可能被誤判成 `tool_unavailable` 而觸發不必要的重試。這純粹是我們這邊接入時要自己抓的參數，先在這裡提醒一下，供之後接 PoC 的人少踩一次坑。

第三個，我沒把握，想直接問架構師：第 8 節「N² 批次查詢」被列為延後項目、屬於 orchestrator/LLM 呼叫層的編排問題，這個分工我同意。但如果之後 `compute-route` 這類多點距離查詢真的要走 `BackendDispatch`，會有兩種做法——orchestrator 對每個點對各發一次 dispatch（N² 次簽章 HTTP 往返，延遲疊加），或者工具本身設計成一次呼叫接受陣列參數（一次 dispatch，我們後端內部自己跑迴圈）。這個選擇會回頭影響第 2 節的 schema 本身：現在 `QueryDispatch`/`ActionDispatch` 是單筆查詢的重試語意，沒有「陣列輸入、部分失敗如何回報」的欄位設計空間。想確認的是：schema 現在這樣定案，之後若要加「批次查詢」語意，是相容擴充（加新欄位、舊 schema 不受影響），還是會是破壞性改動？如果是後者，是不是該趁 PoC 階段還沒定型前先預留欄位空間，而不是真的等 `compute-route` 要開發時才發現要動 schema 本身。

**系統架構師（Systems architect）**：三點都收到，逐一回。

第一點，同意是真的漏洞，不是可以延後的細節——一個 header 兩種語意來源，實作者兩邊各自猜，猜錯的後果是 `X-Onagent-User-Ref` 算出來的雜湊在兩條路徑下不一致，直接破壞「同一使用者的呼叫要收斂到同一個識別碼」這個設計初衷本身。裁定：在 `backend-tool-dispatch-design-2026-08-08.md` 第 6 節補一段消歧義文字，明講 `X-Onagent-User-Ref` 的 `userId` 輸入依觸發路徑二選一——WS 路徑吃 `hello.userId`，`POST .../complete` 路徑吃 request body 的 `userId`，兩者互斥、由觸發當下實際使用的路徑決定，不存在「兩個都給、以誰為準」的情況。

第二點，感謝提醒，這確實是「規格允許、但配置錯誤會很傷」的那種細節，記錄進第 8 節「已記錄但延後」清單裡的「PoC 落地時的已知參數陷阱」小節（若目前沒有這個小節就新開一個），但不影響本輪 schema 或協定設計，維持現狀。

第三點，工程師這輪你來查一下 `QueryDispatch`/`ActionDispatch` 現在的欄位結構，評估「加一個可選的批次輸入欄位（例如 `Batch *BatchDispatch`，跟 `Query`/`Action` 平行）」是否可以做成純新增、不影響任何現有欄位語意的相容擴充。如果評估下來確實可以，那我傾向現在就不用預留——相容擴充意味著晚一點加也不會動到已經拍板的部分，沒有必要為了「以後可能要加」提前設計一個現在用不到的欄位，那反而是過度設計。但如果評估下來會動到 `Query`/`Action` 本身的重試語意（例如批次的部分失敗必須共用同一套 `retryBackoff` 判斷邏輯），那就是真的破壞性風險，需要現在就重新考慮 schema 形狀。麻煩下一輪帶著具體結論回來，不要用猜的。

**資深工程師（Senior engineer）**：架構師、開發者，輪詢方向的裁定我這輪沒有要翻案，但有一個維度我要老實承認：上一輪我自己只顧著查 MCP 規格裡「輪詢解掉認證反轉、解掉多副本 pending-callback map 對不上 process」這兩點，完全沒有算過第三個維度——輪詢模式對 onagent 自己這一側意味著什麼負擔。這不是要推翻架構師的裁定，是這三個維度（認證複雜度、多副本相容性、onagent 自身容量）本來就該放在同一張表上一起看，我上一輪的分析漏了第三格。

具體講資源模型差在哪。callback 模式下，onagent 是被動方：每個進行中的非同步任務，onagent 這邊只是開一個等待用的 channel、掛一個 goroutine 等，跟 `AskInteraction` 那套 `pendingCalls map` 是同一種形狀——等待本身幾乎不占用主動資源，真正的 CPU/網路動作發生在第三方主動打進來的那一刻。輪詢模式反過來：onagent 是主動方，每個還在跑的任務都需要 onagent 這邊有排程機制定期真的發一支 `GET {endpoint}/tasks/{taskId}` 出去、等回應、處理逾時重試。如果 onagent 同時服務 N 個第三方、每個第三方同時有 M 個進行中的長任務，等於要同時維持 N×M 條輪詢排程，而且是持續性的主動負載，會隨待處理任務數線性增長，不是掛著等的輕量消耗。

這正好牽動我們已知的舊問題：`want` 那邊 orchestrator 是全 backend 共用一份、序列化所有使用者的每一輪對話，onagent 自己也還沒解決同等級的併發瓶頸。如果服務規模夠大——很多第三方、很多並行的長任務——輪詢排程的總量可能變成一個真正的容量瓶頸，甚至反過來排擠到其他請求的處理能力，這跟 onagent 作為服務大量租戶的 SaaS 平台這個定位是有摩擦的。callback 模式雖然有認證方向反轉、多副本 map 對不上 process 這兩個問題，但至少在「resource footprint 隨等待任務數增長」這件事上更輕量，因為等待是被動的。

折衷方向我提兩個給架構師參考，不是我要拍板：一是輪詢間隔用 exponential backoff、越等越少查，降低平均負載，但無法消除隨任務數線性增長這個根本問題；二是兩種模式都留著，`ActionDispatch` 的 `Mode: async` 底下再分 `polling`/`callback` 兩種子模式，讓第三方依自己能力選——維護得起 inbound endpoint 的選 callback（對 onagent 更省），做不到的選 polling（對第三方更省事，onagent 多扛輪詢負擔）。但這個折衷要誠實講代價：系統多一層複雜度分支，不是免費的。

架構師，這次的裁定可能需要重新放進「認證複雜度 vs 多副本相容性 vs onagent 自身容量負擔」三個維度一起權衡的框架，而不是只看前兩個維度就定案，這個容量維度想請你重新評估。

**系統架構師（Systems architect）**：工程師，這一格我確實漏算了，不是雞蛋裡挑骨頭。上一輪拍板改輪詢只看了「認證方向反轉」跟「多副本 map 對不上 process」，只算了一次性做出方案的代價，沒算跑起來後隨規模持續要付的代價。callback 被動輕量、跟 `pendingCalls` 同形狀；輪詢主動、隨 N×M 線性增長，這個資源模型是對的，疊上稍早才承認的 `want` orchestrator 全 backend 共用一份、序列化所有使用者對話這個既有瓶頸，確實是原本裁定漏算的風險。

重新看，真正該優先的判斷依據是「代價的可控性」。認證反轉、多副本對不上，麻煩但都是一次性架構成本，設計對了不會隨規模惡化。輪詢的負擔是持續性、隨規模線性增長，沒有一次性解法能根除，backoff 只能減緩不能消除。onagent 要服務大量租戶，架構決策該優先避免「隨用戶數增長而增長」的成本結構，寧可多付一次固定複雜度，也不留線性增長的坑給未來——這個優先序要排在另外兩個維度之前。

但我也要檢討自己：多副本問題目前只是「已知風險、技術債」，我當時明講 onagent 是不是單一 process 沒把握斷言，需要查證部署拓樸。如果現在確實單一 process，`pendingCalls` 對不上 process 根本不會發生，只是未來的地雷——我卻讓一個尚未發生的問題，把單一 process 下運作良好、資源模型更健康的方案完全否決，比重放得過重了。

裁定：恢復 callback 為 async 模式主要方案，取代上一輪輪詢。多副本相容性照原計畫記入技術債，等真的要水平擴展再解。認證反轉是一次性成本、量級不算大，值得為避開線性增長的長期負擔而承擔。工程師提的 `polling`/`callback` 讓第三方自選這次不採用——只解決代價分配，沒解決輪詢是否該存在，還多一層分支複雜度，現在不划算。

這是目前第一次推翻自己上一輪裁定，但架構討論本來就會反覆修正，新維度被認真攤開，裁定就該跟著動，不是立場不穩。謝謝工程師主動把這個維度帶回桌上。開發者，這次翻案會讓你維護的東西從一支查詢 GET 變回 inbound callback endpoint 加反向簽章，如果對落地負擔有實質影響，這輪想聽你的意見；沒有的話，先以此裁定為準，後續有新資訊再議。

## 結論

第一輪基於前端架構的結論已隨第一輪內容一併移除，不再適用。第二輪拍板的完整方案已移至獨立文件：[backend-tool-dispatch-design-2026-08-08.md](backend-tool-dispatch-design-2026-08-08.md)。以下是第三輪拍板的內容，尚未併入該文件（見文末待辦）。

### 1. 去程：新增獨立於 WS 之外的推論觸發 API

第二輪方案完全沒有涵蓋「第三方要怎麼觸發第一次 LLM 推論」——只描述了 onagent 主動打第三方後端的回程。查證確認 onagent 目前**完全沒有**任何非 WS 的推論觸發入口（`inference.Service.Complete` 僅有的兩個呼叫者 `ws.Session.handlePrompt` 與 `console/playground.go` 都依賴 WS 連線）。這對開發者最初提出的「排程觸發」「純 API 產品、無 UI」場景而言，即使 `BackendDispatch` 回程做完，去程仍卡在瀏覽器模型上，等於核心需求沒有真正被滿足。

**裁定**：新增 `POST /v1/apps/{appId}/complete`，body 帶 `prompt`、`userId`、可選 `conversationId`；認證複用既有 `auth.Store.Verify`（`Authorization: Bearer <apiKey>`），不需要 WS handshake。`userId` 與第二輪拍板的 `X-Onagent-User-Ref` 是同一條設計思路的延伸，只是傳遞位置從 `hello` payload 改成這支新 API 的 request body，語意、雜湊衍生、命名空間規則完全沿用。

**Session 生命週期**：採用「第三方傳 `conversationId`，onagent 對應到 orchestrator map 的 key」，而非一次性 session——理由是「LLM 自主規劃整趟行程」這類場景需要第三方連續呼叫這支 API 多次才能收斂，一次性 session 會讓每次呼叫都失去先前規劃上下文。代價（map 何時清除）以閒置逾時機制解決，例如 30 分鐘無新請求自動清理，不依賴連線斷開事件。

**`X-Onagent-User-Ref` 來源消歧義**：這個 header 現在有兩條互斥的輸入路徑——WS 觸發時吃 `hello.userId`，`POST .../complete` 觸發時吃該 API request body 的 `userId`，兩者不會同時存在，也不存在「以誰為準」的問題，需在方案文件第 6 節／第 3 節明確補述，避免實作時兩邊各自猜測導致同一使用者在不同觸發路徑下算出不一致的雜湊值。

### 2. 非同步模式的最終決議：維持 callback，不採用輪詢

第三輪內部另有一段完整的反覆過程，記錄如下，因為它解釋了為什麼最終方案選 callback 而非表面上「更簡單」的輪詢：

1. 工程師研究 Anthropic MCP 2026-07-28 規格，帶回兩個參考：(a) MCP 用「呼叫端自己攜帶的 explicit handle」取代 transport 層 session；(b) MCP 用 poll-based `tasks/get` 取代 callback 處理長任務。
2. 架構師評估後：**否決** (a)——MCP 的 handle 對應單次工具呼叫的小量狀態，onagent 的 `conversationId` 對應完整多輪推論上下文，量級不同，不適合套用；**採納** (b)——改用「onagent 主動輪詢第三方 `GET {endpoint}/tasks/{taskId}`」取代原本 callback 方案，因為這同時解決了 callback 認證方向反轉、以及多副本部署下 pending-callback map 對不上 process 這兩個懸而未決的問題。開發者也確認輪詢對他而言實作負擔明顯更低。
3. 工程師隨後指出一個先前兩輪都沒算過的維度：callback 模式下 onagent 是被動方（等待任務只是輕量 channel/goroutine，形狀同 `pendingCalls`），輪詢模式下 onagent 是主動方，需持續對每個進行中任務發送真實 HTTP 請求，若服務 N 個第三方、每個 M 個並行長任務，等於同時維持 N×M 條輪詢排程——這是隨規模線性增長的持續性負載，牽動已知的 `want` orchestrator 全域序列化瓶頸，與 onagent 作為服務大量租戶的 SaaS 平台定位有摩擦。
4. **架構師最終推翻上一步的輪詢裁定，恢復 callback 為 async 模式的正式方案**。判斷依據：認證反轉、多副本相容性是「一次性架構成本」，設計對了不會隨規模惡化；輪詢的資源負擔是「持續性、隨規模線性增長的成本」，沒有一次性解法能根除。對 SaaS 平台而言應優先避免後者。同時架構師自我檢討：多副本問題目前僅是未證實的技術債（onagent 是否為多副本部署尚待查證），讓一個尚未發生的問題否決了資源模型更健康的方案，先前的權衡比重有誤。

**最終定案**：`ActionDispatch.Mode: "async"` 沿用第二輪設計的 callback 機制（第三方回 `202 Accepted` + `taskId`，稍後主動呼叫 onagent 開放的 callback endpoint，callback 認證方向反轉）不變；多副本部署風險維持記入技術債，等真正要水平擴展時再解。工程師提出的「schema 讓第三方自選 polling/callback 子模式」這次不採納，理由是只解決代價分配、沒解決輪詢是否該存在的根本問題，且徒增系統複雜度分支。`Mode: "async"` 本身仍是預留欄位，PoC 階段不實作，不影響當前優先序。

### 3. 待確認／延後事項

- `recommend_nearby` PoC 落地時的已知參數陷阱（`timeoutMs` 配置：現有查詢是純 in-process 呼叫，改走 `BackendDispatch` 後需另抓一個遠比 20 秒基準小、但仍需容納 Google Places API 尾端延遲的數值，避免誤判為 `tool_unavailable`）——記入方案文件第 8 節「已記錄但延後」清單。
- `QueryDispatch`/`ActionDispatch` 是否能相容擴充出批次查詢語意（供未來 `compute-route` 等多點距離查詢使用）——工程師下一輪需查證現有欄位結構，評估新增 `Batch *BatchDispatch` 是否為純新增、不影響現有欄位語意；若會動到 `Query`/`Action` 本身的重試/退避邏輯則需重新考慮 schema 形狀，待此查證完成前不預留欄位。
- 待辦：本輪（第三輪）內容目前只記錄在本文件逐字稿與此結論中，尚未回寫 [backend-tool-dispatch-design-2026-08-08.md](backend-tool-dispatch-design-2026-08-08.md)（新增第 1 節去程 API、第 6 節消歧義補述、第 7 節非同步機制的最終定案說明、第 8 節的參數陷阱備註）。

## 相關案例

[tripace-backend-tool-requirement-2026-08-07.md](tripace-backend-tool-requirement-2026-08-07.md) 記錄了一個非假設性的真實案例（tripace 專案的 `recommend_nearby` 工具），佐證這類後端工具串接不是單純的理論需求。
