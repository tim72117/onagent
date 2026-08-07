# 團隊協作編輯 App 設定討論：權限、資料庫設計與並發控制

本文件記錄一場由三位角色參與的架構設計討論，主題是第三方開發者如何讓團隊成員共同維護同一個 app 的 `thought` 與 `tools` 設定。討論需求最初由第三方開發者提出，並在討論過程中經系統架構師與資深工程師擴充與釐清。以下依序呈現參與角色、完整討論過程逐字稿，以及最終結論。

## 參與角色

- **第三方軟體開發者（Third-party developer）**：代表串接方，關注權限分級、變更追責、帳號獨立性與實際落地可行性。
- **系統架構師（Systems architect）**：代表 onagent 架構事實與決策收斂，釐清現行系統邊界與工程範圍取捨。
- **資深工程師（Senior engineer）**：代表資料庫設計與實作細節，補充 middleware、schema 變更與安全機制的具體方案。

## 討論過程

**第三方軟體開發者（Third-party developer）**：目前這個 app 是我一個人在維護串接，但團隊要擴編到 4、5 個人了——會有一位 prompt engineer 專門調 thought 欄位的措辭，另外兩位工程師要負責新增/修改 tools。我想先確認一件最基本的事：onagent 現在有沒有任何「同一個 app 給多個帳號存取」的機制？因為照我目前的理解，我只能用我自己申請的那組帳密登入 console 去改 thought 跟 tools，如果要讓其他人也能編輯，是不是就只能把我的帳密整個共享出去？這對我來說是不能接受的——密碼共享代表沒辦法區分是誰做的操作，而且我也不想讓一位只負責調文案的 prompt engineer，跟能刪 tool、轉 API key 的工程師擁有一模一樣的權限。

具體需求我列三點：第一，權限要分級，至少要有「只能改 thought」跟「能改 tools 甚至刪除/轉 key」這兩種角色的區隔。第二，要有變更紀錄——誰在什麼時間點改了什麼欄位，因為 thought 這種東西改壞了可能不會立刻報錯，是悄悄影響 production 的行為，我們得知道要 revert 到哪個版本、是誰的手改的。第三，帳號本身要是獨立的，不能只是共用一組 session cookie 了事。想先問問這在現有架構裡是怎麼設計的，還是說目前根本還沒有 team/multi-user 這層概念？

**系統架構師（Systems architect）**：先講結論：現有架構完全沒有 team/multi-user 這層概念，不是「有但陽春」，是根本不存在。`apps.owner_id` 是單一 FK 指向 `users.id`，schema 裡找不到任何 membership、role 或 org 表；session 也是一支 cookie 對一個 `user_id`，`console.go` 的 `withOwnedApp` 做的是 `owner_id == session.user.ID` 的嚴格比對，連 403 都不給、直接 404，連 super-admin override 都沒有。所以你講的「共享密碼」其實不是退而求其次的方案，而是目前唯一能讓第二個人碰到這個 app 的方式——因為系統設計上就是「一個 app 只認一個人」。

三個需求要分開估：角色分級跟獨立帳號，做法是新增一張 `app_members(app_id, user_id, role)` 表，把 `withOwnedApp` 那段 `owner_id == user.ID` 換成查 membership 並依 role 決定能不能碰 tools vs. thought，這是可控的中型工程，不需要動既有的單人 app 資料（舊 app 可以視為 owner 自動變成第一個 admin member）。變更紀錄是另一個獨立議題——`schema.sql` 裡沒有 audit log 表，`tools`/`apps` 也沒有 `updated_at`/`updated_by`，`saveTools` 是 DELETE 全表再 INSERT 的替換式寫法，要做「誰改了哪個欄位」得新增 `audit_log` 表並在每個寫入路徑補寫。

還有一個你沒提到但一定會撞到的問題：`saveTools` 目前完全沒有 optimistic concurrency 檢查，兩個人同時開著 console 編輯，後存的會整批覆蓋先存的，不會報錯也不會提示衝突。角色分級解決「誰能做什麼」，但解決不了「兩個人同時做，誰的版本活下來」——這是獨立於權限之外的另一塊，得靠 version 欄位或 ETag 才能擋。

**資深工程師（Senior engineer）**：這位開發者提的第一點——「只能改 thought vs 能改 tools/key」——直接對應到現有 `withOwnedApp` 的問題：它現在是布林判斷（`console.go:163-173`，是不是 `owner_id == user.ID`），不是分級判斷。要做分級，`app_members` 這張表除了 role 欄位還不夠，得定義清楚 role 對應到哪些 route：至少要區分 `setThought` vs `saveTools` vs key issue/revoke vs `deleteApp` 這四類，因為架構師講的「兩種角色」太粗——你們要的其實是三層：prompt engineer 只碰 `setThought`、工程師碰 `saveTools` 但不能碰 key/`deleteApp`、你自己保留全權限。這代表 `withOwnedApp` 要拆成好幾個 middleware，每個 route 各自宣告需要的最低權限，不是單一 owner 判斷換成單一 member 判斷就結束。

變更紀錄這塊我補充架構師沒講細的部分：`audit_log` 表本身便宜（`app_id, user_id, field, old_value, new_value, created_at`），但寫入點要埋在哪很關鍵——`saveTools` 是 DELETE+INSERT 整批替換（`registry.go:277-304`），沒有逐筆 diff，所以你要嘛在應用層寫入前先跟 DB 裡舊資料做一次 diff 算出誰改了哪個 tool，要嘛乾脆整包 payload 存一份 snapshot 當作「這次存檔」的紀錄，不追求欄位級別的 diff。前者實作量不小，後者夠用但只能告訴你「誰在什麼時間整包存了什麼」，不能精準指出改了哪個 tool 的哪個欄位。

至於「暫時共用密碼」的成本要講清楚：`sessions` 表（`schema.sql:24-29`）一個 session 對一個 `user_id`，共用帳密等於所有人共用同一組 bcrypt 密碼與 cookie，你完全無法從 audit 角度區分操作者，而且一旦要拿掉某個人的存取權（比如工程師離職），你得整組改密碼、逼所有人重新登入——這比補 `app_members` 表還麻煩，而且完全不解決你要的分級需求，純粹是風險，不是省工。

**第三方軟體開發者（Third-party developer）**：第一，先回應「暫時共用密碼」這件事——工程師講的成本我完全同意，但我要講更直白一點：這對我來說不是「成本高不高」的問題，是 non-starter，直接排除，不用當選項討論。理由很簡單：thought 一旦被改壞是悄悄影響 production、不會報錯，我事後要查是誰動的手，共用帳密等於直接放棄事後追責的可能性，我寧可暫時維持我一個人手動轉發修改需求，也不要走這條路。

第二，回應資深工程師拆的三層角色——完全符合我要的，而且我要更明確講一句：prompt engineer 這個角色，我要的不是「只能碰 `setThought`」這種正面表列，我要的是反向確認——他即使拿到 URL 或用 devtools 直接打 API，`saveTools`/key issue-revoke/`deleteApp` 這些 route 也必須是後端擋下、回 403 或 404，不能只是前端把按鈕藏起來而已。這點務必講清楚，因為我們看過太多「UI 隱藏=權限控制」的假安全。

第三，關於 audit 要 diff 還是存整包 snapshot——先做 snapshot 版就好，我要的是「能 revert、能看出是誰在哪個時間點存的檔」，欄位級 diff 之後再說，不想因為這個卡住第一版上線。

最後一個新需求：`app_members` 要能設「唯讀」角色嗎？我想讓新人 onboarding 時先只能看不能存，觀察個幾天再升級權限。

**系統架構師（Systems architect）**：settled 的部分先講清楚：密碼共享徹底出局，這點在我看來從一開始就不該當選項，現在開發者也自己排除了，不用再花篇幅論證。三層角色（唯讀/thought-only/tools-full）加上「後端強制、不是前端藏按鈕」，這也定案——這本來就是唯一站得住腳的做法，`withOwnedApp` 要拆成 per-route 的 middleware，每個 route 自己宣告最低權限需求，唯讀角色只是多一種 role 值，對這個設計沒有額外成本，可以直接收進第一版範圍。Snapshot 式 audit（存整包 payload，不做欄位級 diff）我也同意先做這版就好，revert 用得到、實作量可控。

還沒 settled、而且我要提醒一個資深工程師和開發者都還沒講到的風險：唯讀角色一旦存在，代表 console 會出現「看得到但按鈕全部 disabled」的畫面——這個 UI 狀態現在完全不存在，`App.tsx` 的 draft state（`App.tsx:63`）是假設打開就能編輯在設計的，唯讀模式下你的 3 個角色會同時打開同一個 app 觀察，這就直接撞回我之前提的 concurrency 問題：唯讀者不會寫入所以還好，但兩位「tools-full」工程師如果真的同時編輯，`saveTools` 的 replace-all 語義還是會互相蓋掉，而且蓋掉的還可能包含 prompt engineer 剛存的 thought（因為 `saveTools` 跟 `setThought` 是分開的 API，交錯呼叫時序上仍有 race window）。這件事不能無限期延後——建議做法是給 `apps` 表加一個 version 整數欄位，`saveTools`/`setThought` 都帶入 If-Match 比對，衝突就 409 回前端，這比 audit log 便宜很多，我認為應該跟 `app_members` 一起排進第一版，而不是留到「以後」。

**資深工程師（Senior engineer）**：這位開發者提的三個回應都對，但我要補幾個具體的坑，不然第一版寫出來會卡住。

第一，「後端強制、不是前端藏按鈕」——這件事目前完全沒有基礎建設可以複用。`withOwnedApp` 現在是單一函式（`console.go:163-173`），要拆成 per-route middleware，意味著每個 handler 註冊時要宣告 required role，這是 router 層的改動，不是加個 if。而且 role 判斷不能只查 `app_members` 一次就好——`deleteApp`、key issue/revoke 這幾條路徑我建議直接定成「僅限 owner」，不開放給 tools-full 角色，因為一旦 `app_members` 允許多個 admin，「誰能刪 app」這件事本身也要決策，這是開發者還沒表態的地方。

第二，唯讀角色的技術本質：它不是「多一種 role 值」這麼簡單——架構師輕描淡寫帶過了。唯讀使用者仍然要能觸發 GET，但 `saveTools`/`setThought` 這些 POST 全部要在 middleware 就擋掉，回 403（這裡跟現有 `withOwnedApp` 的「故意 404」哲學會衝突，要決定：對已知是 member 但唯讀的人，是回 403 還是維持 404 語意？我建議 403，因為對方已通過 membership 驗證，404 沒必要）。

第三，version 欄位這件事我附議架構師，而且要講清楚 schema：`apps` 加 `version INT NOT NULL DEFAULT 1`，`saveTools`/`setThought` 都要求呼叫方帶入 `known_version`，寫入時 `UPDATE apps SET version = version + 1 WHERE app_id = $1 AND version = $2`，受影響 row 數為 0 就回 409。這個機制跟 `app_members` 是正交的，可以同批做，成本不高。

**第三方軟體開發者（Third-party developer）**：三個都同意，收進第一版。`deleteApp`/key issue-revoke 限 owner-only 這點我明確表態：同意，而且我覺得這本來就該是常識——tools-full 角色的定位應該是「日常維護 tools 內容」，不是「跟我共享帳號控制權」，能刪 app、能轉 key，某種意義上就等於能讓整個 app 失效或金鑰外洩後失控，這種殺傷力的操作我不打算下放給任何人，包含未來可能加入的第二個資深工程師。403 vs 404 那個我也選 403，資深工程師的理由我認同——對方是已知 member，沒有隱藏存在性的必要，反而 403 比較誠實，404 在這裡只會讓唯讀角色的人以為自己根本沒被加進來，徒增困惑跟客服負擔。

version 欄位加 409 衝突偵測這個機制我完全支持排進第一版，而且我要追加一個 UI 端的要求：409 發生時，前端不能只丟一個「儲存失敗請重試」就打發，因為對使用者來說「重試」等於直接覆蓋別人剛存的版本，問題完全沒解決。至少要能讓使用者看到「這個 app 已經被 XXX 在 OO:OO 更新過」，最好能讓他重新載入最新版再決定要不要合併自己的修改——這部分現有 `App.tsx` 完全沒有對應的 UI 狀態，我想先確認這是否也算進第一版的工程量，還是會被切到之後的 iteration？這個沒做好，version 機制在使用者體感上就只是「多一種存檔失敗的方式」而已，沒有真正解決協作痛點。

## 結論

### 1. 已達成共識的架構

**現況定性**：目前不是「陽春的多人機制」，而是根本不存在——`apps.owner_id` 是單一 FK 指向 `users.id`，無 membership/role/org 表；`sessions` 是一支 cookie 對一個 `user_id`；`withOwnedApp`（`console.go:163-173`）是 `owner_id == session.user.ID` 的嚴格比對，連 403 都不給、直接 404，無 super-admin override。

**共用密碼方案**：討論一開始即被判定為 non-starter，直接排除，不列入選項討論——因為它讓事後追責（誰改壞了 thought）徹底不可能，且移除單一成員權限時必須整組改密碼、逼全員重新登入。

**第一版工程範圍收斂為兩個正交但同批交付的子系統**：(a) `app_members` 權限分級表 + per-route middleware 改寫；(b) `apps.version` 樂觀鎖並發控制。Audit log 採 snapshot 版，欄位級 diff 明確延後。

### 2. 已達成共識的權限／資料庫設計

- 新增 `app_members(app_id, user_id, role)`，取代 `withOwnedApp` 單一 owner 比對。
- **三層角色**定案：唯讀（read-only，可 GET 不可寫）、thought-only（僅 `setThought`）、tools-full（`saveTools`，但**不含** `deleteApp` 與 key issue/revoke）。
- `deleteApp` 與 key issue/revoke **限 owner-only**，不因 `app_members` 允許多 admin 而下放——開發者明確表態此權限殺傷力太大，不下放給任何協作者。
- `withOwnedApp` 要拆成 per-route middleware，每個 handler 註冊時宣告 required role，而非單一函式判斷。
- Audit 採 snapshot 式：整包 payload 存檔紀錄（誰、何時存了什麼），不做欄位級 diff，實作量可控，revert 可用。
- 舊有單人 app 資料相容處理：原 owner 自動變成第一個 admin member，無需遷移既有資料。

### 3. 已達成共識的安全要求

- **後端強制，不得只靠前端隱藏按鈕**：唯讀/thought-only 角色即使直接打 API（繞過 UI），`saveTools`/`deleteApp`/key 相關 route 也必須在 middleware 層擋下。
- 對已通過 membership 驗證但權限不足者，回應改為 **403**（而非現行 `withOwnedApp` 對非 owner 一律 404 的「隱藏存在性」哲學）——因為對方已知是 member，404 只會造成困惑與客服負擔。
- 並發衝突控制：`apps` 加 `version INT NOT NULL DEFAULT 1`，`saveTools`/`setThought` 都要求帶入 `known_version`，寫入用 `UPDATE apps SET version = version + 1 WHERE app_id = $1 AND version = $2`，受影響 row 數為 0 即回 409——此機制與 `app_members` 同批排入第一版，不延後。
- 409 發生時前端不得只顯示「儲存失敗請重試」（等同鼓勵覆蓋他人版本），至少需顯示「已被 XXX 於 OO:OO 更新」並引導重新載入最新版。

### 4. 明確列為未解決的事項

- **409 衝突 UI 的工程量歸屬**：開發者提出的「顯示是誰在何時更新、可重載最新版再決定合併」這套 UI（`App.tsx` 目前無對應狀態）是否算進第一版範圍，還是切到後續 iteration——討論結束時尚未拍板，留待下次確認。
- 欄位級 audit diff（相對於 snapshot）明確承認是「以後再說」，非本次範圍但未來仍是待辦。
