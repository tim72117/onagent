# 訂閱、方案與額度的資料模型設計（2026-09）

> 狀態：設計定稿，尚未實作。分期計畫見第 9 節；哪一期先做尚待決定。

本文展開 [refactor-subscription-billing-cycle-2026-09-03.md](refactor-subscription-billing-cycle-2026-09-03.md)
「待展開」清單裡的 schema 設計部分。該文已拍板的兩個方向——`subscriptions`
改成每期一筆、扣款接 Stripe——是本文的前提，不再重新論證。

定價與市場行情見 [research-pricing-2026-09.md](research-pricing-2026-09.md)。

---

## 1. 需求

1. 能限制**請求數**
2. 能限制 **token**
3. 為**個別功能**預留各自的額度
4. 方案週期支援**週／月／年**
5. 方案內容可調整，但**不能影響已成交的訂閱**

---

## 2. 現況與落差

| | 現況 | 需要 |
|---|---|---|
| 額度維度 | 單一 `Plan.MonthlyTokens` 純量（`quota/plan.go`） | 多維度 |
| 額度週期 | 寫死「月」（`quota/quota.go` 的 `currentPeriodStart` 家族） | 週／月／年 |
| 方案儲存 | 程式碼的 `plans` map，訂閱不留副本 | 成交當下的快照 |
| 訂閱列 | `user_id` 為主鍵，一人一列（`schema.sql`） | 每期一列 |
| 用量帳本 | `usage_events`，`kind` 已預留 | 大致夠用，補兩欄 |

**好消息是帳本那一半已經完整。** `usage_events.kind` 的註解本來就寫著
「room for 'tool_call' or token-based units later without a schema change」，
難做的 append-only／counter-free 設計已經到位。要補的都在 plan／subscription 側。

---

## 3. 兩組容易混淆的概念

整份設計的關鍵在於把這兩組拆開。混在一起是多數計費系統走歪的起點。

### 3.1 收費週期 ≠ 額度週期

| | 回答的問題 | 欄位 |
|---|---|---|
| **BillingInterval** | 多久扣一次錢 | `prices.billing_interval` |
| **QuotaPeriod** | 額度多久重置 | `prices.quota_period` |

年繳方案業界慣例是**按年收費、按月重置額度**（`billing_interval='year'` +
`quota_period='month'`）。沒有人賣「一次給 18M token、可以第一個月燒完然後閒置
十一個月」的年約——那讓成本前傾，且用戶體驗是「用完就死一整年」。

兩個欄位分開，兩種語意都表達得出來。

### 3.2 目錄 ≠ 快照

| 層 | 存什麼 | 可變嗎 |
|---|---|---|
| **目錄** | 「Starter 是 1.5M／$39／月」 | 會改 |
| **快照** | 「這個人這一期買到什麼」 | **永不改** |

方案定義會變，但已經發生的交易不能變。若只存 tier、額度查表推導，則調整方案會
追溯改變既有用戶的權益，且無法回答「他當初買的是什麼」——退款、爭議、
grandfathering 全部沒有依據。

---

## 4. 完整 schema

```
products ──┬──> prices ──> subscriptions ──> subscription_periods
           │                                          │
           └─(停售)                              usage_events ──> usage_rollups
```

### 4.1 `products` — 產品（可變）

```sql
CREATE TABLE products (
    id           TEXT PRIMARY KEY,                    -- 'starter' | 'pro'
    name         TEXT NOT NULL,
    description  TEXT,
    sort_order   INT NOT NULL DEFAULT 0,              -- 定價頁排序
    is_public    BOOLEAN NOT NULL DEFAULT true,       -- false = 不公開（客製方案）
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at  TIMESTAMPTZ                          -- 停售；既有訂閱不受影響
);
```

名稱、描述、排序都是呈現性資訊，改了不影響任何人的權益，所以這張表可變。

### 4.2 `prices` — 價格與額度（**不可變**）

```sql
CREATE TABLE prices (
    id               TEXT PRIMARY KEY,   -- 'price_starter_monthly_v2'
    product_id       TEXT NOT NULL REFERENCES products(id),

    -- 收費
    amount_cents     INT NOT NULL,
    currency         TEXT NOT NULL DEFAULT 'usd',
    billing_interval TEXT NOT NULL,      -- 'week' | 'month' | 'year'

    -- 額度
    quota_period     TEXT NOT NULL,      -- 'week' | 'month' | 'year'
    limits           JSONB NOT NULL,     -- {"tokens":1500000,"prompts":5000}

    -- 生命週期
    effective_from   TIMESTAMPTZ,        -- 排程生效（NULL = 立即）
    sellable_until   TIMESTAMPTZ,        -- 停售時間；既有訂閱繼續沿用
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**這張表只 INSERT，永不 UPDATE。** 調價／調額度 = 新建一列
（`price_starter_monthly_v3`），舊列留給既有訂閱。

這一條規則本身就解決了 grandfathering、歷史查詢與爭議處理——因為舊 Price 永遠在。
反過來說，一旦允許 UPDATE，「他當初買的是什麼」就又沒有答案，只是把問題從
「程式碼會變」搬到「資料列會變」。

`limits` 用 JSONB 而非數個 INT 欄位：新增計量維度不該是一次 migration。

### 4.3 `subscriptions` — 訂閱關係

```sql
CREATE TABLE subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    price_id     TEXT NOT NULL REFERENCES prices(id),

    status       TEXT NOT NULL,          -- 'active'|'past_due'|'canceled'|'paused'
    started_at   TIMESTAMPTZ NOT NULL,   -- 週期錨點
    canceled_at  TIMESTAMPTZ,
    ends_at      TIMESTAMPTZ,            -- 取消後的服務截止日

    stripe_subscription_id TEXT UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 一人同時只能有一個生效訂閱，但歷史訂閱全部保留
CREATE UNIQUE INDEX subscriptions_one_active_idx
    ON subscriptions (user_id) WHERE status = 'active';
```

那個 partial unique index 是這張表的重點：用資料庫保證「同時只有一個生效訂閱」，
不必靠應用層紀律。

### 4.4 `subscription_periods` — 每期一列（**方案快照在這**）

```sql
CREATE TABLE subscription_periods (
    id              BIGSERIAL PRIMARY KEY,
    subscription_id BIGINT NOT NULL REFERENCES subscriptions(id),
    user_id         BIGINT NOT NULL,       -- 反正規化：quota 查詢免 JOIN

    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,  -- 明確儲存，不推導（見 5.1）

    -- 成交當下的快照
    price_id        TEXT NOT NULL REFERENCES prices(id),
    limits          JSONB NOT NULL,        -- 從 prices.limits 複製
    amount_cents    INT,                   -- NULL = 純額度期（見 5.2）

    stripe_invoice_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscription_periods_user_start_idx
    ON subscription_periods (user_id, period_start DESC);
```

**為什麼 `limits` 要從 `prices` 再複製一份？** Price 已經不可變，理論上 JOIN 即可。
仍要複製的理由是**個人化額度**：管理員要給某個帳號特殊額度時，直接改這一期的
`limits`，不需要為一個人建一個 Price。這取代了現行 `subscriptions.monthly_quota`
那個「有讀取路徑、無寫入路徑」的欄位。

### 4.5 `usage_events` — 帳本（現有，補三欄）

```sql
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS period_id BIGINT REFERENCES subscription_periods(id),
  ADD COLUMN IF NOT EXISTS source    TEXT,     -- 'widget'|'playground'|'cli'|'api'
  ADD COLUMN IF NOT EXISTS quantity  BIGINT;   -- 通用計量值

CREATE INDEX IF NOT EXISTS usage_events_period_kind_idx
    ON usage_events (period_id, kind);
```

- **`period_id`**：寫入時就決定這筆屬於哪一期。對帳從「日期範圍比對」變成 JOIN；
  修正期界（換約、時區修正）不會讓歷史用量跳到別期。
- **`source`**：**不要塞進 `kind`**。`kind` 是「發生了什麼事」，`source` 是
  「從哪裡來」。把來源塞進 kind 會產生 `prompt_playground`／`prompt_cli`…的
  組合爆炸，且 kind 是單向門（寫進去的值永遠得被認得）。
- **`quantity`**：讓未來的計量不受限於「token 或計次」兩種，例如「儲存 GB·小時」。

### 4.6 `usage_rollups` — 歷史聚合（逃生門）

```sql
CREATE TABLE usage_rollups (
    period_id    BIGINT NOT NULL REFERENCES subscription_periods(id),
    kind         TEXT   NOT NULL,
    day          DATE   NOT NULL,
    event_count  BIGINT NOT NULL,
    total_tokens BIGINT NOT NULL,
    PRIMARY KEY (period_id, kind, day)
);
```

帳本會無限成長。唯一不破壞現有 counter-free 哲學的解法是 append-only 的每日聚合：
**rollup 是不可變的歷史聚合**，查詢時已結束的日子讀 rollup、當天讀原表。

不要用可變的 running counter——那正是原設計刻意避開的 reset 邊界 race。

---

## 5. 三個關鍵決定

### 5.1 `period_end` 明確儲存，不推導

現行設計從 `started_at` 推導邊界。一旦有了每期一列，推導會與資料表產生兩個真相
來源——換約、補開帳期、時區修正都會讓兩者不一致。

推導邏輯仍需要，但只用來**產生**下一期，不用來**查詢**歷史。

### 5.2 年繳每月重置的形狀

一張年繳 invoice → **十二列 period**：

| 列 | `amount_cents` | `stripe_invoice_id` | 意義 |
|---|---|---|---|
| 第 1 列 | 39000 | `in_xxx` | 收費期起點 |
| 第 2–12 列 | NULL | NULL | 純額度期（重置額度，不收錢） |

「收了多少錢」與「額度怎麼重置」各自清楚，且 quota 引擎只要看 period 列，
不需要知道收費週期。

### 5.3 額度週期的邊界規則

四種週期只有**兩類數學**：

- **月步長家族**（month=1、year=12）：沿用現有 `monthBoundary` 的夾日規則
  （1/31 訂閱 → 2/28，Stripe 同此行為）。`daysInMonth` 已處理閏年，
  所以 **2/29 年約自動正確**。
- **週**：無夾日問題（每週都是七天），錨點即 `started_at`，第 k 期起點 =
  錨點加 7k 天。用 `time.Date` 的日曆正規化，**不是** `Add(7*24*time.Hour)`
  （後者在 DST 週會讓牆鐘時間漂移一小時）。

必須保住的不變量：**永遠從原始錨點重算，不從被夾過的上期邊界疊加**。
現行 `nextPeriodBoundary` 已有這個性質（11/30 → 2/28 → 5/30 正確回彈），
泛化時不能弄丟。

**時區一律 UTC。** 現行註解宣稱在 `started_at` 自己的 location 運算以落在
用戶當地牆鐘時間——實際上做不到：`started_at` 是 `TIMESTAMPTZ`，Postgres 只存 UTC
瞬間，掃回來的 Location 是連線的而非訂閱建立時的。明文改成 UTC 是把既成事實寫清楚，
附帶好處是邊界永遠不會落在 DST 的間隙或重複時段。

---

## 6. 額度模型（meter）

### 6.1 Meter 是「讀法」，不是「事件類型」

```go
type MeterID string

type Meter struct {
    ID    MeterID
    Unit  Unit     // UnitCount（COUNT）| UnitToken（SUM total_tokens）
    Kinds []string // 這個 meter 聚合哪些 usage_events.kind
    Name  string
}
```

`tokens` meter 與 `prompts` meter 讀的是**同一批 `kind='prompt'` 的列**，
一個 SUM、一個 COUNT。Meter 與 kind 是多對多，不是一對一。

### 6.2 寫入路徑：一列，兩種讀法

**不要為了「兩種計量」而每次 round-trip 寫兩列。** 理由：

1. `kind='tokens'` 不是事件而是單位——一列記錄的是「發生了什麼事」，
   token 數是該事件的屬性（欄位早已存在）。
2. **過渡期會雙倍計費**：現行 `usageSince` 不過濾 kind，只要有任何時刻
   「新寫入端（兩列都帶 token）+ 舊聚合端（不過濾）」並存（rolling deploy、
   回滾、或未來某個查詢忘了加 `WHERE kind`），token 就被算兩次。
   一列模型**結構上不可能**發生這件事。
3. 兩列非原子：`Record` 目前是單條 INSERT，拆兩列要嘛包 transaction，
   要嘛接受帳本內部不一致。
4. `event_id` 語意會被進一步稀釋（它已經不是 dedup key）。

只有**真正不同的事件**（例如 `backend_dispatch`）才寫自己的列——那時 token 欄位
為 NULL，天然不污染 token meter。

### 6.3 缺鍵 = 不設限，0 = 禁用

`limits` JSONB 缺少某個 meter 的鍵 = **該項不設限**。這是唯一正確的選擇：
新 meter 上線時，舊的 period 快照沒有這個鍵，必須解讀為不受限，否則等於對全體
用戶追溯設限。

值為 0 = **完全禁用**，語意與缺鍵不同。未來「免費版不能用後端派送」就靠這個區分。

### 6.4 檢查只發一條查詢

```sql
SELECT kind, COUNT(*) AS cnt, COALESCE(SUM(total_tokens), 0) AS tokens
  FROM usage_events
 WHERE period_id = $1
 GROUP BY kind
```

一次 index scan 拿回所有 kind 的計數與 token 合計，Go 端再套上 meter 定義。
**Check 的資料庫成本與 meter 數量無關**，永遠一條查詢。

### 6.5 建議的計量項

| Kind | 單位 | 狀態 |
|---|---|---|
| `prompt` | count + token | 現在就有（一列兩種讀法） |
| `backend_dispatch` | count | **最有理由獨立**：打第三方 endpoint，成本與 LLM 無關 |
| `tool_call` | count | **可能永遠不需要**：與 round-trip 數高度相關，token meter 已隱含涵蓋 |

**沒有寫入點就不要定義 kind 常數**——那是死碼，而 kind 是單向門。

---

## 7. 請求數上限的真實角色

需求 1 要「限制請求數」，設計上支援，但必須誠實記錄一件事：

**以「月」為期的請求數上限幾乎不是濫用防線。** 濫用是速率問題（每分鐘、每小時），
不是每月總量問題。跑迴圈的腳本在撞到「5,000 次／月」之前早就燒完 token 額度——
**token 上限本身就是花費上限，已經封頂了損害**。

所以：

- **token meter 是主要的商業額度**，對應真實成本
- **請求數 meter 照做**（基礎設施免費支援，同一批列 COUNT 即可），
  定在 token 額度對應輪數的約 10 倍，角色是「方案展示維度 + 最後保險」
- **真正的濫用防線是 rate limiting**——每連線／每用戶每分鐘，
  屬於 ws 層的 in-memory limiter，**不該進 quota ledger**
  （為了算 60 秒窗口去查資料庫是錯的形狀）

另注意 `COUNT(*)` 數的是 **round-trip 數**而非使用者輪數。對外不要稱之為「對話數」。

---

## 8. 目錄層：自建 vs 交給 Stripe

`products`／`prices` 這兩張表與 Stripe 的 Product／Price 功能完全重疊。

**若接 Stripe**（[已拍板方向](refactor-subscription-billing-cycle-2026-09-03.md)）：
建議**不自建這兩張表**，`subscription_periods.price_id` 直接存 Stripe 的 price ID，
`limits` 從 Stripe 的 metadata 讀來快照。版本管理、生效時間、grandfathering
都是 Stripe 的核心功能，自己再維護一份會變成兩個真相來源，不一致時無從判斷以誰為準。

**若改接台灣金流**（綠界、藍新、TapPay——該文列為備選）：那些沒有方案管理功能，
`products`／`prices` 就必須自建，且要在導入時一併完成。

**這是個需要先確認的分岔**，因為它決定第 4.1／4.2 兩節要不要實作。

---

## 9. 分期計畫

### Phase 0 — 準備形狀（零 schema 變更）

行為與今天**逐位元相同**，只是把形狀準備好：

1. `Plan.MonthlyTokens` → `Limits map[MeterID]int`，meter 定義表（先只有
   `tokens`、`prompts`）
2. 日期運算泛化成 `periodStart/periodEnd(anchor, period, now)`，
   `Plan` 加 `Period` 欄位，所有 plan 先填 month
3. 邊界計算明文改為 UTC，修正時區註解
4. `usageSince` 改成 6.4 那條 GROUP BY；`Decision`／`Standing`／`UserSummary`
   改成 per-meter 形狀，錯誤訊息區分「額度用完（請升級）」與「請求過於頻繁（請放慢）」
5. 順手清理：`quota.go` 與 `schema.sql` 仍寫著 "COUNT(*)" 的過時註解，
   以及 `quota.go` 對不存在的 `docs/subscription-usage-quota-design.md` 的引用

**真正的工作量在 4 的形狀改變與前端連動，不在 SQL。**

### Phase 1 — 手動開通與到期

原本寫成「開賣」，但那不成立：`SetTier` 的唯一呼叫者是 admin console
（`quota/plan.go` 明寫「there is no developer-facing console surface that lets a
user pick their own tier at all」），而自助付費需要整條 Stripe 流程，那屬於
Phase 2。這一期的目標因此縮小為**人工收款所需的最小集合**。

**1a — 訂閱到期（一個向前相容的欄位）**

```sql
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
```

```go
// 到期後回退 free。沿用本套件 counter-free 的作法：查詢時比對，
// 不用排程去改資料，也就沒有「排程掛了導致該降級的沒降級」的風險。
if endsAt != nil && now.After(*endsAt) {
    return FreePlan
}
```

`NULL = 永不過期`，既有帳號行為完全不變，不需要 backfill。

這個欄位**是最終設計的一部分**（見 4.3），不是權宜：Phase 2 只在旁邊加
`status`（`active`／`past_due`／`canceled`／`paused`）讓語意更細，判斷邏輯
往上疊一層守衛，`ends_at` 本身與既有比較都不動。

**實作注意**：到期判斷必須放在 **tier → plan 的解析點**，不能只放進 `Check`。
目前額度與方案名稱是在兩處分別解析的（`userStandingRow.limit()` 與
`PlanFor(st.tier).Name`），只改一處會出現 admin 顯示 "Starter" 但實際額度是
free 的錯亂。這正是它應該與 `Limits map` 一起做的原因——那個重構本來就要統一
這兩處。

**1b — 方案上架**

- `plans` map 加 starter／pro（**只做月繳**，用不到週／年）
- 付費 tier 加 `prompts` 上限（約 token 對應輪數的 10 倍，見第 7 節）
- Console 把 token 翻譯成人話：「已用 32%，約剩 340 輪對話」
- `SetTier` 接受可選的到期日與週期錨點
- 另立工作項：ws 層 in-memory rate limiter（見第 7 節）

做完 1a+1b，管理員即可手動開通付費帳號並設定到期日，時間一到自動回 free ——
**足以支撐人工收款的早期階段，不需要 Stripe**。

**不在這一期**：使用者自助取消（需要 `canceled_at` 與前端介面）、
扣款失敗自動降級（需要 webhook，屬 Phase 2）。

### Phase 2 — schema 變更，跟著 Stripe 整合一起

**這三件事必須同時做，不可分批：**

1. `subscriptions` 改每期一列 + `subscription_periods`
2. `usage_events.period_id`（需要 backfill 歷史資料）
3. `event_id` dedup 改用伺服器端產生的 round-trip id

理由：`period_id` 需要 period 表存在才能引用；兩者都要 backfill 同一批
`usage_events`；dedup 改動也要掃同一批資料。**分批 = 兩次 backfill = 兩次風險窗口。**

第 3 項的急迫性來自現有註解自己標記的 TODO（`quota.go` 與 `schema.sql` 都寫著
"revisit once Stripe billing lands"）：dedup 目前是關閉的，免費階段「偶爾多算」
無所謂，**收錢後就是客訴來源**。

### Phase 3 — 視情況

- `usage_rollups`（用量規模成長時）
- `source` 欄位（要區分 widget／playground／cli 時）
- `org_id`（做團隊方案時）

---

## 10. 演進成本表

設計是否成功，看的是「未來要改時要付多少代價」：

| 未來需求 | 需要做什麼 | Migration？ |
|---|---|---|
| 新增方案 | `plans` map／Stripe 加一列 | 否 |
| 調整方案內容 | 新建一個 Price | 否 |
| 新增計量維度 | 新 kind + `limits` 加鍵 | 否 |
| 新增額度週期 | `Period` 加常數 | 否 |
| 個人特殊額度 | 改該期 `limits` | 否 |
| 中途換約 | 關舊期、開新期 | 否 |
| 團隊／多席次 | `subscriptions.org_id` | 一個欄位 |
| 用量爆量 | `usage_rollups` | 新表，不動舊的 |

**只有 Phase 2 需要 migration**，其後的擴充都是加欄位或改程式碼。

---

## 11. 待決事項

1. **年繳的額度語意**——一年一池，還是每月重置？（5.2 假設後者）
2. **金流廠商**——Stripe 或台灣金流？決定 4.1／4.2 是否自建（見第 8 節）
3. **超額處理**——硬停，或超額計費（約 $30／百萬 token，仍有 98% 毛利）
4. **`monthly_quota` 的去留**——per-cycle 模型下由「改該期 limits」取代，
   該欄位可廢除
5. **是否賣週繳**——客單價低、金流手續費占比高、退訂管理頻繁；
   CopilotKit 等對標品均無週繳
