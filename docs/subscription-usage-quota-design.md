# 訂閱制月配額系統設計提案

> **文件性質**：這是一份**設計提案**，不是現況說明。onagent 目前完全沒有計費 / 訂閱 / 配額機制——`users`、`apps`、`sessions` 等資料表都只處理帳號與 App 身份，沒有任何欄位涉及用量或方案。本文根據現有的資料模型與程式碼路徑，提出一套可以自然接上去的配額系統設計，並在文末給出明確的起步建議。
>
> 撰寫時檢查過 `docs/` 目錄下是否有先前的定價研究文件（搜尋 pricing / gemini / subscription 等關鍵字），**沒有找到**任何既有文件，因此本文不假裝延續某份不存在的定價策略，文中出現的方案額度數字僅作為示意，實際數字待另行制定定價策略時再填入。

## 目錄

1. [現況：onagent 現有的資料模型與請求路徑](#1-現況onagent-現有的資料模型與請求路徑)
2. [核心難題：高併發下如何準確計數用量](#2-核心難題高併發下如何準確計數用量)
3. [月配額重置的實際運作方式](#3-月配額重置的實際運作方式)
4. [超過配額時該怎麼辦](#4-超過配額時該怎麼辦)
5. [執行點該放在架構的哪一層](#5-執行點該放在架構的哪一層)
6. [具體最小 Schema 提案](#6-具體最小-schema-提案)
7. [最終建議](#7-最終建議)

---

## 1. 現況：onagent 現有的資料模型與請求路徑

在設計配額系統之前，先釐清這套配額要「掛」在系統的哪個既有概念上。讀過 `backend/internal/db/schema.sql`、`internal/auth`、`internal/session`、`internal/ws`、`internal/protocol`、`internal/console` 後，現況是：

- **帳號層（billing 關係應該掛在這裡）**：`users` 表是唯一的「人」的概念——email + bcrypt 密碼雜湊。`sessions`（瀏覽器 cookie session）與 `user_tokens`（CLI/長期 bearer token）都是 `users` 的附屬認證方式，兩者最終都解析回同一個 `session.User{ID, Email}`（見 `console.go` 的 `withAuth`）。**目前沒有任何欄位描述這個使用者訂閱了什麼方案。**
- **App 層（實際發生用量的地方）**：`apps` 表以 `app_id`（開發者自訂字串）為主鍵，`owner_id BIGINT REFERENCES users(id)` 綁定擁有者，`api_key_hash` 是連線用的雜湊金鑰，`allowed_origin` 是 WebSocket 握手時比對的來源網域。一個 user 可以擁有多個 app（`apps_owner_id_idx`），這是多租戶的實際邊界——`console.go` 的 `withOwnedApp` 在每個 app-scoped 操作前都會檢查 `Apps.OwnerOf(appID) == user.ID`。
- **認證發生的時間點**：`auth.Store.Verify(apiKey)` 只在 WebSocket **握手**時被呼叫一次（`internal/ws/handler.go` 的 `ServeHTTP`），不是每則訊息都查一次資料庫——這是刻意的設計（見 `auth.go` 註解：「key checks are infrequent (once per WebSocket handshake, not once per message)」）。握手成功後，`appID` 會被寫入 `ws.Session.authAppID`，整個連線生命週期內都信任這個值。
- **實際觸發 LLM 呼叫的路徑**：`ws.Session.handlePrompt`（`internal/ws/session.go`）收到 `protocol.TypePrompt` 訊息後，呼叫 `s.infer.Complete(ctx, inference.Request{Prompt, Context, Tools, AppID: app.AppID, SessionID: s.id})`。`inference.Request` 已經天然帶有 `AppID`——這正是用量歸屬最自然的鍵值，不需要新增任何欄位傳遞它。
- **錯誤回報的既有格式**：`protocol.TypeError` + `ErrorPayload{Message string, Code string}`，透過 `Session.sendError(requestID, message)` 送出，`RequestID` 讓前端知道是哪一次 `prompt` 觸發的錯誤。`Code` 欄位目前完全沒被使用（一直是空字串）——這是一個現成、尚未佔用的欄位，非常適合用來放配額相關的錯誤代碼（例如 `"quota_exceeded"`），不需要更動 protocol 結構本身。

這五點決定了本文後續所有設計選擇的邊界條件：配額是「使用者的訂閱」，用量是「app 產生的事件」，執行點只能在握手或 `handlePrompt` 這兩個既有的程式碼路徑裡插入，回報錯誤有現成但未使用的 `Code` 欄位可以借用。

---

## 2. 核心難題：高併發下如何準確計數用量

這是整份設計中最容易做錯的地方：多個請求（WebSocket `prompt` 訊息、或未來的 per-tool-call 事件）可能在同一使用者身上高併發到達，計數邏輯如果沒設計好，會產生 race condition，導致漏算或算兩次。有三種主流做法：

### 做法一：資料庫層級的原子遞增（`UPDATE ... SET count = count + 1`）

單一一句 `UPDATE usage SET count = count + 1 WHERE user_id = $1` 在 Postgres 底下是**原子的、不需要額外加鎖**。原因在於 Postgres 的 MVCC：這句 UPDATE 本身會取得該筆 row 的鎖，若兩個 transaction 同時搶同一筆 row，後到的會等前面那個 commit 完，然後**重新評估自己的 WHERE 條件、讀到剛 commit 的新值**才套用自己的 `+1`——所以不會發生「兩邊都讀到舊值、其中一次遞增被覆蓋」的情況。這也是為什麼這種單一敘述式的寫法不需要額外的 `SELECT ... FOR UPDATE`：`FOR UPDATE` 是用在「先讀值、應用層做邏輯判斷、再寫回去」這種跨兩個回合的 read-modify-write，單一 UPDATE 敘述句從一開始就不會有這個問題。

**但這個做法在高併發下有明確的失效模式**：熱點行鎖競爭（hot-row contention）。有實測資料顯示（[Timanovsky, "Ultra fast asynchronous counters in Postgres"](https://medium.com/@timanovsky/ultra-fast-asynchronous-counters-in-postgres-44c5477303c3)），對同一筆 row 做 naive 的 `UPDATE` 計數器，從 1 個 client 的 ~340 TPS / 2.9ms 延遲，惡化到 400 個併發 client 搶同一筆 row 時只剩 ~105 TPS、**延遲飆到 3,805ms**——因為每個寫入者都要排隊等鎖，加上 Postgres MVCC 每次更新都是「複製一份新版本」（copy-on-write），造成 row bloat 與 VACUUM 壓力。**但要注意這個數字的前提是「數百個併發寫入者搶同一筆 row」**，不是「數百個使用者各自更新自己的 row」——對 onagent 目前這種早期規模（幾十到低百位數的並發使用者），除非單一使用者本身在同一秒內狂發數百則訊息，否則不會碰到這個瓶頸。

### 做法二：事件流水帳表（event log），用量 = `COUNT(*)`

不維護一個會被改寫的計數器，而是每次用量事件（例如一次 `prompt`、未來的一次 tool call）都 `INSERT` 成流水帳裡獨立的一筆 row，「目前用量」永遠是查詢時當場算出來的 `COUNT(*)` 或 `SUM()`。

這正是 **Stripe 自己在 usage-based billing 上採用的做法**。Stripe 的 Meter Events API（`billing/meter_events`）要求每筆事件帶 `event_name`、`payload[stripe_customer_id]`、`payload[value]`，並且**強烈建議帶 idempotency key**：「Use idempotency keys to prevent reporting usage for each event more than one time... every meter event corresponds to an identifier that you can specify in your request. If you don't specify an identifier, we auto-generate one for you.」（[Stripe: Report usage with the API](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api)）值得注意的是，Stripe 較舊版的「Usage Records」（可變的累計數字）已經被這套不可變事件流取代——這本身就是業界對這個問題「最終選哪條路」的訊號。

這個做法的取捨：insert 因為每筆都是新 row，完全不會有鎖競爭問題——同樣的 benchmark 顯示「先 insert 再彙總」的設計在 400 併發寫入者下可以撐到 **25,000 inserts/sec**，是做法一的約 66 倍吞吐量。額外好處是天然可稽核（每筆事件都留痕，能重算、能回溯）、天然支援未來的用量計費明細，以及透過 unique event id（`ON CONFLICT DO NOTHING`）就能拿到防止重複計數的 idempotency，不需要額外設計。代價是儲存量會隨時間無上限成長（長期需要 partition/歸檔），且「目前用量」從 O(1) 的欄位查詢變成一句帶時間區間過濾的 `COUNT`/`SUM`——只要在 `(app_id, created_at)` 或 `(user_id, created_at)` 上建索引，這在 onagent 現階段的資料量下完全不是問題。

### 做法三：Redis / 記憶體計數器 + 定期 flush 落地

用 Redis 的 `INCR`（原子操作）當作熱路徑計數器，定期或達到閾值時同步回 Postgres。這種做法在「需要極高吞吐量、要降低資料庫寫入壓力」時才有意義。風險是：Redis 若在 flush 前當機、且 AOF/RDB 沒有即時落盤，會**直接遺失最近幾秒的用量資料**——對於「用量」這種攸關計費正確性的數字，這是不能輕忽的風險；此外還多了一個要維運、監控的 stateful 服務，以及 Redis（執行期真相）與 Postgres（帳務真相來源）之間永遠存在的一段 eventual-consistency 視窗，配額執行的判斷依據可能暫時落後實際用量。真正切中 LLM 計費場景的一個實務模式是：「即時配額檢查用 Redis，帳務正確性的來源用 Postgres 事件流水帳，兩者分工而非二選一」——也就是說 Redis 不是取代事件流水帳，而是疊加在它上面的一層加速快取。

### 三者比較與 onagent 現階段的選擇

| | 一致性 | 成本 | 維運複雜度 | 適合的規模 |
|---|---|---|---|---|
| 原子遞增 UPDATE | 強一致，單一 row 為單位 | 低（無新元件） | 低 | 中低併發，避免同一 row 被大量併發寫入 |
| 事件流水帳 + COUNT | 強一致（讀取當下即為真值）| 中（儲存隨時間成長）| 低（不需新元件，只需要索引）| 各種規模都適用，是 Stripe 自己的選擇 |
| Redis + 定期 flush | 最終一致，有資料遺失風險 | 高（多一個服務、多一份維運）| 高 | 高吞吐量、已有 Redis 維運能力的團隊 |

**對 onagent 目前的早期規模而言，事件流水帳（做法二）是最務實的預設選擇**：不會遇到做法一的熱點鎖問題（那需要數百個併發寫入者打同一筆 row，onagent 現在的流量遠遠不到），同時不需要引入做法三的額外元件與資料遺失風險，卻能免費拿到冪等性、稽核軌跡，以及未來若要做用量計費明細時的資料基礎——這也正是 Stripe 自己選擇的架構。做法三（Redis 熱路徑）值得在文末的「未來考慮」中留一筆，但不是現階段該優先投入的方向。

### 業界的類似作法可作為佐證

- **Anthropic** 用 [token bucket 演算法](https://en.wikipedia.org/wiki/Token_bucket) 做速率限制：「capacity is continuously replenished up to your maximum limit」，分別追蹤 RPM、輸入 token/分鐘、輸出 token/分鐘，且輸入 token 用量是在請求送出前先「預估」再檢查，超過任何一項限制回傳 429 並帶 `retry-after` header（[Anthropic Rate Limits 文件](https://platform.claude.com/docs/en/api/rate-limits)）。
- **OpenAI** 同樣在請求進入前先用「估計的 max tokens（prompt + max_tokens）」做檢查，而不是等實際完成後才算，並將限制「量化」成更細的時間粒度（例如 60,000/分鐘的限制實際上以約 1,000/秒執行）以平滑流量尖峰。
- **Twilio**（Segment Tracking API）採用「每個服務節點各自有自己的吞吐量預算」而非單一集中式計數器，正是為了在高規模下避免單一熱點鎖/計數器成為瓶頸。

三者共通的原則：**在真正花費運算成本（呼叫 LLM）之前先做便宜的檢查**，並且把用量拆成多個獨立維度分別追蹤，而不是單一個全域數字。

---

## 3. 月配額重置的實際運作方式

### 三種週期定義方式

- **日曆月**（每月 1 號重置，例如 UTC 00:00:00）：最簡單，但新註冊使用者的第一期會是「不完整的一個月」。Vercel 採用這個做法：「usage limits reset on the first of each calendar month」，不管使用者何時開通帳號（[Vercel Limits 文件](https://vercel.com/docs/limits)）。
- **滾動 30 天視窗**（永遠是「現在往回推 30 天」）：常見於防濫用型的速率限制，但不太適合「每月 N 次」這種訂閱配額的心智模型，因為使用者很難預期自己的配額什麼時候恢復。
- **綁定訂閱起始日**（哪天訂閱就哪天重置，例如 15 號訂閱就每月 15 號重置）：**這是付費訂閱制產品的主流做法**。Stripe 的 Subscription 物件有 `billing_cycle_anchor` 欄位：「the reference point that aligns future billing period dates... sets the day of month for month and year intervals」，預設值就是訂閱建立（或試用期結束）的當下（[Stripe API: Subscription object](https://docs.stripe.com/api/subscriptions/object)）。Stripe 甚至明確處理了月底邊界情況：「A monthly subscription with a billing cycle anchor date of January 31 bills the last day of the month closest to the anchor date, so February 28 (or 29), then March 31, April 30...」（[Stripe: Billing cycle](https://docs.stripe.com/billing/subscriptions/billing-cycle)）。

一個值得參考的真實案例是 **GitHub Copilot**：官方文件寫「每月 1 號 00:00:00 UTC 重置」，但社群討論（[github.com/orgs/community/discussions/171831](https://github.com/orgs/community/discussions/171831)、[/178384](https://github.com/orgs/community/discussions/178384)）反映實際行為其實是跟著訂閱的 billing-cycle-anchor 走，導致使用者對「重置到底是哪天」感到困惑。這個案例的教訓很直接：**文件宣稱的重置規則要跟實際實作一致，否則會製造真實的客服負擔**。

至於速率限制（不是月配額）本身，Anthropic 的說法很明確：「The API uses the token bucket algorithm... rather than being reset at fixed intervals」——也就是說速率限制根本不是「重置」型，而是連續補充型；「每月」這個週期只出現在他們的**支出上限（spend cap）**設定上，且那是單純的日曆月，不綁訂閱日。這說明「重置」這個概念本身，在不同用途下（配額 vs. 花費上限 vs. 速率限制）業界並不是用同一套邏輯處理，設計時要分清楚自己要解決的是哪一種。

### 重置的實際機制：排程 job 归零，還是「讀取當下永遠算即時值」

這裡有兩種實作路線：

- **方案 A：排程 job 定期歸零**——例如每天跑一次 cron，檢查哪些使用者的週期已經到期，對到期的執行 `UPDATE usage_counter SET count = 0, period_start = now()`。
- **方案 B：從不真的「重置」任何東西**——用量本身存成事件流水帳（見第 2 節），「目前用量」永遠是查詢當下即時計算的 `SELECT COUNT(*) FROM usage_events WHERE user_id = $1 AND created_at >= current_period_start`。週期邊界只是一個查詢時套用的時間篩選條件，從頭到尾沒有一個「重置」的動作發生過。

**方案 A 有一個結構性的 race condition 風險**：如果歸零 job 執行的同時，剛好有一個使用量事件想遞增計數器，兩者的執行順序若沒有被交易保護好，可能發生「遞增先發生、緊接著被歸零蓋掉」，導致這筆用量憑空消失；反過來也可能發生「歸零已經跑完、但緊接著的請求誤判自己還在舊週期」的短暫視窗混亂。這類 fixed-window 計數器在 race 邊界丟失遞增，是業界已知的常見 bug 類型。

方案 B **從架構上完全不會有這類問題**——因為它從來沒有「歸零」這個會被競爭的寫入動作，每一筆用量事件都是獨立的 INSERT，永遠不會被覆寫；「目前用量」永遠是唯讀查詢，沒有共享的可變狀態需要保護。這正好呼應了 Stripe 目前真正的做法：他們較新的 Billing Meters API 完全沒有「重置」這個操作，查詢彙總用量時呼叫 `GET /v1/billing/meters/:id/event_summaries`，由呼叫端明確帶入 `start_time`/`end_time`（[Stripe: Meter Event Summary](https://docs.stripe.com/api/billing/meter-event-summary)）——週期邊界從頭到尾只是一個查詢參數，不是一個系統事件。

對維運複雜度而言，方案 B 也明顯更簡單：不需要 cron 基礎設施、不用擔心「部署時剛好錯過那次排程」、不需要為「歸零 job 失敗了但沒人發現」設計額外的告警。方案 A 唯一的優勢是查詢效能——已經歸零的計數器讀取是 O(1)，而方案 B 的 `COUNT`/`SUM` 隨事件表增長是 O(n)——但這可以單純用索引（`(user_id, created_at)`）解決，資料量真的大到需要優化時，也可以另外疊加一層定期物化的快取數字（那是效能優化，不是正確性要求，兩者不衝突）。

### 用不完的配額怎麼處理

絕大多數 SaaS 產品是**當月未用完直接歸零、不遞延到下個月**——GitHub Copilot 官方文件直接寫明「unused requests for the previous month do not carry over」。配額遞延（類似行動網路的「上網用量結轉」）在 SaaS/API 產品中很少見，就算有通常也是額外付費選項，不是預設行為，第一版設計不需要考慮。

---

## 4. 超過配額時該怎麼辦

超過配額後，系統可以有三種反應方式，各自適合不同情境：

- **硬性中斷（hard cutoff）**：直接拒絕新的請求，回傳明確的錯誤，直到下個週期或使用者升級方案。這是免費 / 試用方案最常見的做法。
- **軟性超額（soft overage）**：仍然放行請求，但標記這筆用量，事後依用量另外計費。這正是 **Stripe 自己的 metered billing、AWS、以及 Twilio 的隨用隨付模式**實際採用的方式——付費帳號超過方案內含額度後不會被擋，而是超出部分照量計費。
- **降級服務**：請求仍然被處理，但品質或速度降低（例如切換到更便宜/較弱的模型、提高延遲、降低併發上限）。

**真實 API 平台的實際行為**：OpenAI 與 Anthropic 對於「速率限制」（不是月配額，是短時間內的請求頻率）採取的幾乎都是硬性中斷——超過限制回傳 HTTP 429，並在 header 中附上重試提示，例如 Anthropic 回應中的 `anthropic-ratelimit-requests-remaining` 系列 header 加上 `retry-after`。這種設計讓呼叫端在超限之前就能從 header 看到「還剩多少額度」，用來自行節流，而不是每次都要撞牆才知道超了。Twilio、AWS 這類基礎設施型服務則更常見軟性超額——因為它們的付費客戶本來就是用量計費，「擋住付費客戶的流量」對雙方都沒有好處，硬性中斷通常只保留給未綁定付款方式的免費 / 試用帳號。

**這對 onagent 意味著什麼**：onagent 的核心成本是 LLM 推論費用，這筆錢是每次呼叫都真實發生的，不像頻寬那樣邊際成本趨近於零。因此順著這個邏輯——**免費 / 基本方案適合硬性中斷**（避免在還沒有付款機制兜底的情況下持續產生推論成本），**付費方案適合軟性超額或至少提供「一次性加購」的路徑**，而不是讓一個已經在付費的開發者的 App 在使用者最活躍的時候忽然斷線。降級服務（例如超額後自動切換到較便宜的模型）是一個可以留到後續迭代的選項，第一版不需要實作。

### 該如何透過既有的協定回報

onagent 目前沒有 REST API 處理 prompt（一切都經由 WebSocket），所以「HTTP 429」這個慣例沒有直接對應的位置，但**它的設計精神完全可以套用到 WebSocket 錯誤訊息上**：

- **握手階段被拒**（見第 5 節「連線建立時檢查」）：這裡確實有 HTTP 語意可用，`ws.Handler.ServeHTTP` 目前對未通過驗證的請求是回 `http.StatusUnauthorized` / `http.StatusForbidden`（見 `handler.go`）。超過配額可以在這裡回傳 **`429 Too Many Requests`**，語意上完全吻合，且已經有 `http.Error(w, ...)` 這個既有的回應模式可以直接沿用，不需要新協定。
- **連線建立後、單則訊息被拒**：這裡沒有 HTTP status code 可用（連線已經是 WebSocket），但 `protocol.TypeError` 訊息本身的 `ErrorPayload{Message, Code}` 剛好就是為這種情況設計的形狀。`Code` 欄位目前完全沒被使用過——這裡可以直接定義一個新的值，例如 `Code: "quota_exceeded"`，`Message` 給人看的說明文字，並且沿用 `RequestID` 讓前端知道是哪一次 `prompt` 被拒。前端 SDK 可以依 `Code` 做程式化判斷（跳出升級方案的 UI），不需要用字串比對 `Message`。連線本身**不需要關閉**——配額用完不代表這個瀏覽器分頁的其他操作（例如已經在畫面上的內容）失去意義，維持連線讓使用者升級方案後可以無縫接續使用，比強制斷線重連的體驗更好。

---

## 5. 執行點該放在架構的哪一層

onagent 的 WebSocket 連線是長生命週期的——一次握手後，同一個連線上可能發送非常多次 `prompt` 訊息，每次都觸發一次真正的 LLM 呼叫。配額檢查放在哪個時間點，有三個候選位置，各有取捨：

### 位置一：只在 WebSocket 握手時檢查

在 `ws.Handler.ServeHTTP` 裡，`h.Auth.Verify(token)` 成功後，新增一次配額檢查——如果這個 app 所屬的使用者已經超額，直接拒絕升級連線（回 429，見第 4 節）。

- **優點**：檢查只發生一次，完全不影響已建立連線之後的延遲，實作也最簡單——就是在既有的握手驗證流程裡多加一個 DB 查詢。
- **缺點**：一旦連線建立，即使中途超額，這個連線會繼續正常運作到它自然斷線為止。如果一個瀏覽器分頁長時間開著、不斷發送 prompt，配額可能被大幅度超支，直到使用者重新整理頁面、觸發新的握手才會被攔下。

### 位置二：每一則訊息都檢查（`handlePrompt` 進入點）

在 `ws.Session.handlePrompt` 呼叫 `s.infer.Complete(...)` **之前**，先查一次目前用量是否已達上限。

- **優點**：最準確——配額執行的時間點跟真正產生成本的時間點（呼叫 LLM）幾乎重合，不會有位置一那種「連線活著就一直超支」的問題。
- **缺點**：每一次 prompt 都多一次資料庫往返，加在最熱的路徑上。不過要注意這個代價的相對大小：`s.infer.Complete` 本身是一次 LLM 推論呼叫，延遲通常是數百毫秒到數秒等級；相較之下，一次索引良好的 Postgres `COUNT` 查詢是個位數毫秒等級的操作。**這個額外開銷相對於它要保護的那次呼叫，比例上非常小**，不是需要過度擔心的效能問題。

### 位置三：每一次 tool call 都檢查

比位置二更細——同一個 prompt 的回應中，LLM 可能觸發多個 tool call，若在每個 tool call 執行前都各自查一次配額。

- 這個粒度目前對 onagent 沒有意義：tool call 是否消耗「配額」取決於計費單位定義是什麼（如果配額是以「prompt 次數」計，tool call 本身不該重複扣款；如果未來配額改成以「LLM 呼叫次數」或「token 用量」計，且一次 prompt 會觸發連鎖的多次推論，這個粒度才有必要）。第一版不需要做到這裡，先預留這個位置給未來的計費單位變動即可。

### 業界怎麼處理這個折衷

三個提供者的實作方向一致：**在真正花費運算成本之前先做便宜的檢查**，而且不是在連線建立時一次性檢查完就結束——Anthropic 與 OpenAI 都是在每次請求進來時、實際呼叫模型前，先用「預估的 token 用量」跟目前額度比對，通過才放行；這其實就是位置二的模式，只是他們的「連線」是每次都重新建立的 HTTP 請求，天然沒有位置一 vs. 位置二的差別。onagent 因為採用長連線的 WebSocket，才真正需要在「握手」與「每則訊息」之間做選擇。

**建議：位置一 + 位置二同時做，而不是二選一**。握手時檢查是「快速擋掉早就超額的連線，不浪費升級 WebSocket 的成本」，`handlePrompt` 時檢查才是真正防止「連線活著、配額一直被超支」的正確性保證。兩者職責不同，不互斥，程式碼改動也都很小——都是在既有函式裡插入一次查詢與一個提早 return。

---

## 6. 具體最小 Schema 提案

沿用 `schema.sql` 現有的風格：`CREATE TABLE IF NOT EXISTS`、`BIGSERIAL PRIMARY KEY`、`REFERENCES ... ON DELETE CASCADE`、註解解釋「為什麼」而不只是「是什麼」、對既有表的欄位新增一律用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 保持冪等。

設計決策：**訂閱方案掛在 `users`**（付費關係天然是「一個開發者付一份錢」，不是「一個 App 付一份錢」，這也符合一個使用者可以擁有多個 `apps` 的現況），**用量事件掛在 `app_id`**（因為 `inference.Request.AppID` 是實際呼叫路徑上已經有的鍵值，不需要額外查表就能寫入），查詢「這個使用者目前用了多少」時再透過 `apps.owner_id` 把同一使用者名下所有 app 的用量加總。

```sql
-- Subscription tier + billing-cycle anchor per user. One row per user,
-- created lazily (defaults to the free tier) rather than at signup time —
-- see the design doc's recommendation for why period boundaries are
-- derived from started_at rather than reset by a scheduled job.
CREATE TABLE IF NOT EXISTS subscriptions (
    user_id      BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    tier         TEXT NOT NULL DEFAULT 'free', -- 'free' | 'pro' | ... ; kept as free text, not an enum, so new tiers don't need a migration
    monthly_quota INTEGER NOT NULL,             -- prompts included per billing period for this tier; denormalized onto the row (not looked up from a tier table) so changing one user's quota (e.g. a manual grant) never requires a tier table join
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(), -- the billing-cycle anchor: "day of month" this user's period boundary is computed from, mirroring Stripe's billing_cycle_anchor
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only usage ledger: one row per billable event (currently, one
-- WebSocket `prompt` that reached inference.Service.Complete). Current
-- usage for a period is always COMPUTED from this table
-- (COUNT(*) WHERE app_id IN (...) AND created_at >= period_start), never
-- maintained as a running counter — see the design doc section 3 for why
-- this avoids the reset-boundary race condition a mutable counter would
-- need to guard against.
CREATE TABLE IF NOT EXISTS usage_events (
    id         BIGSERIAL PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE, -- attribution matches inference.Request.AppID, the field already threaded through ws.Session.handlePrompt
    event_id   TEXT NOT NULL,     -- caller-supplied idempotency key (e.g. the WebSocket RequestID); prevents double-counting on retry, mirroring Stripe's meter event identifier
    kind       TEXT NOT NULL DEFAULT 'prompt', -- 'prompt' today; room for 'tool_call' or token-based units later without a schema change
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: the same event_id must never be counted twice, even if a
-- client retries a request whose response it never saw (e.g. a dropped
-- WebSocket write). Scoped per-app rather than globally unique, matching
-- how RequestID is only unique within one session/app's own traffic.
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_app_id_event_id_idx
    ON usage_events (app_id, event_id);

-- The query this whole design exists to make fast: "how much has this
-- app used since some timestamp" — the WHERE clause enforcement actually
-- runs (ws.Handler.ServeHTTP at handshake, Session.handlePrompt per
-- message) always filters on exactly these two columns together.
CREATE INDEX IF NOT EXISTS usage_events_app_id_created_at_idx
    ON usage_events (app_id, created_at);
```

**查詢「某使用者本期已用量」的實際 SQL**（第 5 節位置一、位置二都呼叫同一個查詢）：

```sql
SELECT count(*)
  FROM usage_events ue
  JOIN apps a ON a.app_id = ue.app_id
 WHERE a.owner_id = $1
   AND ue.created_at >= $2; -- $2 = 依 subscriptions.started_at 算出的本期起始時間
```

本期起始時間 `current_period_start` 的算法（應用層計算，不需要存成欄位）：從 `started_at` 開始，找出小於等於 `now()` 的最近一次「月週期起點」——例如 `started_at` 是每月 15 號，現在是本月 20 號，本期起點就是本月 15 號；如果現在是本月 10 號（還沒到 15 號），本期起點則是上個月 15 號。這與 Stripe `billing_cycle_anchor` 的語意一致，且完全不需要一個「重置」動作或排程 job。

**寫入一筆用量事件的實際 SQL**（`handlePrompt` 在呼叫 `s.infer.Complete` 之後、確認呼叫成功時執行；`event_id` 可直接用 WebSocket 的 `RequestID`）：

```sql
INSERT INTO usage_events (app_id, event_id, kind)
VALUES ($1, $2, 'prompt')
ON CONFLICT (app_id, event_id) DO NOTHING;
```

`ON CONFLICT DO NOTHING` 讓這句 INSERT 天然冪等——同一個 `RequestID` 重複送達（例如客戶端重試）不會被算兩次，不需要額外的應用層去重邏輯。

---

## 7. 最終建議

**對 onagent 現階段的規模（早期、低併發），建議採用「事件流水帳 + 綁定訂閱起始日的週期計算 + 握手與每則訊息雙層檢查」的組合**，具體來說：

1. **計數方式**：用第 6 節的 `usage_events` 表，每則被處理的 `prompt` 寫入一筆事件，用量永遠是即時 `COUNT(*)` 查詢，不維護獨立的計數器欄位。這個選擇同時解決了第 2 節的併發計數問題與第 3 節的重置競態問題——兩個原本要分開處理的難題，用同一個設計就一起免費解決了，這也是 Stripe 自己從「可變的 usage records」走向「不可變的 meter events」的同一個理由。
2. **週期定義**：`subscriptions.started_at` 作為每個使用者自己的訂閱錨點，本期起訖用應用層計算得出，不需要排程 job 去「重置」任何東西。
3. **超額行為**：免費方案硬性中斷（握手階段擋新連線、`handlePrompt` 擋新 prompt，都回覆語意明確的錯誤——握手用 HTTP 429，訊息中用 `protocol.ErrorPayload{Code: "quota_exceeded"}`）；付費方案第一版也先做硬性中斷即可（軟性超額需要額外的計費對帳機制，複雜度不該在配額系統的第一版就一起做），但把 `subscriptions.monthly_quota` 設計成可以透過後台手動調整的欄位，讓客服/業務可以在被使用者要求時手動放寬，不需要等軟性超額機制上線。
4. **執行點**：`ws.Handler.ServeHTTP` 握手時查一次（擋住早已超額的新連線）+ `ws.Session.handlePrompt` 呼叫 `s.infer.Complete` 前查一次（防止長連線持續超支）。兩者都是在既有函式中插入一次索引良好的查詢，改動範圍小、風險低。

**為什麼是這個組合、而不是別的**：onagent 目前的規模不會遇到單一 row 被數百個併發寫入者搶鎖的問題，所以不需要 Redis 這類額外元件先發制人地解決一個還不存在的效能問題——那只會換來一個新的資料遺失風險與一份新的維運負擔。同樣地，排程歸零式的計數器會製造一個不需要存在的競態視窗；事件流水帳從架構上直接不會有這個問題。這是一個「先把正確性用最簡單的方式做對，效能問題等它真的出現再解」的選擇，而不是預先過度設計。

**什麼情況下應該重新考慮**：如果 `usage_events` 表成長到單一使用者的 `COUNT(*)` 查詢在索引之下仍然變慢（通常要到單一使用者累積數百萬筆事件的等級），可以先加一層「每小時物化一次」的彙總表作為讀取快取，不需要動到寫入路徑的正確性設計。如果併發規模成長到真的會在同一個 app 上出現數百個同時寫入的請求（目前的架構下這代表單一 WebSocket 連線在極短時間內收到數百則 `prompt`，屬於濫用而非正常使用情境），才是認真評估 Redis 熱路徑計數器的時間點——而且即使到了那個階段，也應該延續第 2 節提到的分工模式：Redis 做即時擋人用的快速判斷，`usage_events` 繼續作為帳務對帳的唯一真相來源，而不是讓 Redis 取代它。
