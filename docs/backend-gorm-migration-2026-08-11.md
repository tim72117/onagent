# Backend GORM 遷移：無法改寫成 GORM 的部分

以下九處是這次全面把 backend 資料庫層改成 GORM 的過程中，確認無法真正改寫成 GORM query builder、刻意保留原始寫法的地方。

## 1. `adminauth.Bootstrap` — functional unique index 的 upsert

`ON CONFLICT (lower(email)) DO NOTHING`。GORM 的 `clause.OnConflict{Columns: [...]}` 只能指定實體欄位，無法表示 `lower(email)` 這種運算式索引，保留 Raw SQL，透過 `*gorm.DB.Exec` 執行。

## 2. `cliauth.Approve` / `cliauth.Exchange` — TOCTOU 安全核心

CLI device-flow 登入的單次核准保證，建立在條件式 `UPDATE ... WHERE id = ? AND expires_at > ? AND approved = false` 加上 `RowsAffected == 0` 檢查上，絕對不能改成「先 `First()` 查、再 `Save()` 寫」——那樣會在讀跟寫之間留下 race window，讓第二個並發的 `Approve` 呼叫有機會搶到第二個 token。已用並發測試（兩個 goroutine 同時呼叫同一個 session id 的 `Approve`）驗證只有一次成功。

## 3. `quota.Record` — insert-select 子查詢

```sql
INSERT INTO usage_events (app_id, owner_id, event_id, kind)
SELECT $1, a.owner_id, $2, 'prompt' FROM apps a WHERE a.app_id = $1
ON CONFLICT (app_id, event_id) DO NOTHING
```

沒有對應的 GORM builder 寫法，而且刻意不拆成「先查 owner_id、再 insert」兩步——拆開會在查完 owner_id 到真正 insert 之間留下一個 app 被刪除的 race window，導致計費記錄孤兒化或歸屬錯誤。

## 4. `quota.CheckIntegrity` — 可擴充查詢清單

`internal/quota/integrity.go` 的 `integrityQueries` 設計成「加一筆查詢就自動出現在檢查清單」的彈性結構，每筆查詢的 SQL 各自獨立、語意不同。強行套上 ORM builder 只會破壞這個擴充性、沒有實質好處，保留 Raw SQL（`s.db.WithContext(ctx).Raw(q.query).Scan(&n)`）。

## 5. `auth.HasKey` — EXISTS 子查詢

`SELECT EXISTS(SELECT 1 FROM apps WHERE app_id = ? AND api_key_hash IS NOT NULL)`。GORM 沒有 builder 層級的 EXISTS 表達方式；`Where(...).Limit(1).Find()` 語意不同——那樣會真的抓一列資料出來證明存在，而不是讓 Postgres 純粹用索引判斷存在性，效能特性不一樣，不是等價替代，保留 Raw SQL。

## 6. `pq.Error`，不是 `pgconn.PgError`

`internal/db.Open()` 用 `postgres.Config{Conn: sqlDB}` 讓 GORM 復用既有透過 `lib/pq` 開好的 `*sql.DB` 連線，而不是讓 GORM 自己的驅動另外開一個 pgx 連線。實際結果：任何從 GORM 冒出來的驅動層錯誤（例如 `session.Register` 的 unique violation）仍然是 `*pq.Error`，不是 `pgconn.PgError`。`session.go` 早期草稿誤以為底層一定是 pgx、斷言成錯誤型別，後來修正並在程式碼裡加註解說明原因。

## 7. `github.com/lib/pq` 這個依賴無法移除

第 6 點的直接後果：`internal/db/db.go` 仍然需要註冊 `lib/pq` 作為 `sql.Open("postgres", ...)` 的驅動，`internal/session/session.go` 仍然需要 `pq.Error` 做型別斷言。要真正移除 `lib/pq`，得把底層連線整個換成 pgx，這已經超出這次遷移的範圍（改動面更大，且沒有行為上的實質好處）。

## 8. GORM 的 postgres 驅動預設假定底層是 pgx

在做 `GET /admin/api/schema-check` 端點時發現的相容性 bug：GORM 的 `Migrator().ColumnTypes()` 只要偵測到 `postgres.Config.DriverName` 是空字串，就會自己判斷「這一定是 pgx」，在內部查詢裡塞入一個 pgx 專用的 query-mode 參數。因為這個 repo 底層其實是 `lib/pq`（見第 6、7 點），這個多出來的參數會讓 `lib/pq` 直接報錯「got N parameters but the statement requires N-1」，導致每一次 `ColumnTypes` 呼叫都失敗。修正方式是在 `internal/db/db.go` 明確指定 `DriverName: "postgres"`。這個問題在這次遷移之前完全沒有人踩到，因為在 schema-check 端點之前，整個 repo 沒有任何地方呼叫過 `ColumnTypes`。

## 9. `quota` 的 `COALESCE(sub.started_at, now())` — 既有的 race condition，不是這次引入的

這個 `now()` 是 SQL 端的字面量，在查詢執行當下求值。早期改寫版本一度把它換成 Go 端 `time.Now()` 綁定參數，這樣會讓求值時機提前到查詢送出之前——對一個已知既有的 race（見 `quota_integration_test.go` 裡跟 timing 有關的斷言）來說，這是一個真實的行為改變，而遷移過程本來就不該偷偷改變既有行為。已在改寫過程中發現並改回 SQL 字面量；這個 race 本身是遷移前就存在的既有 bug，不在這次修復範圍內。
