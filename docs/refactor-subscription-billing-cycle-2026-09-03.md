# 訂閱與計費週期重構規劃（草案，待展開）

> 狀態：草案，方向已拍板，細節尚未展開。

## 背景

稽核 `usage 沒有增加` 這個問題時發現：`subscriptions` 表目前是 `user_id` 為主鍵的單筆現況設計（`backend/internal/db/schema.sql`），沒有訂閱記錄的帳號（例如早於「建帳號時自動建立 free 訂閱」這個機制的舊帳號）會讓 `COALESCE(started_at, now())` 每次查詢都把計費週期錨點算成「現在」，導致這類帳號的用量永遠顯示為 0、額度事實上永遠不會被扣滿。已在 `backend/internal/quota/admin.go` 修正 admin 顯示層（無訂閱時不再偽裝成 free），但底層資料模型本身的侷限性——一人只能有一筆現況、沒有週期歷史——尚未處理。

## 已確認的方向

1. **`subscriptions` 改成多筆歷史記錄**：不再是 `user_id` 主鍵的單筆現況，改成一人可有多筆（每個計費週期一筆），每期結束、續訂時新增一筆記錄，而不是原地更新同一筆。
2. **扣款機制要接 Stripe**：設計完整流程（webhook、subscription 同步、失敗重試等 Stripe 特有的整合細節），不是先做內部記帳再談外部支付服務商。

## 待展開（下次規劃時處理）

- `subscriptions` 改多筆後，現有假設「一人一筆」的查詢/寫入全部要重新設計：`SetTier`（admin.go）、`ownerStanding`、`StandingFor`、`ListUsers`（quota.go/admin.go）。
- Stripe 整合的完整流程：webhook 接收與驗證、subscription 狀態同步、扣款失敗與重試、與現有 `tier`/`monthly_quota` 模型的對應關係。
- 新舊資料的遷移路徑（現有單筆 `subscriptions` 記錄如何轉換成新模型下的「第一期記錄」）。

## 金流廠商備選

拍板方向是接 Stripe，但列出其他可能的備選，供之後評估：

- **Stripe**（已拍板）— 國際主流，訂閱/webhook 生態成熟。
- **PayPal** — 使用者端普及度高，但訂閱管理彈性不如 Stripe。
- **TapPay** — 台灣本地，適合以新台幣計價、本地信用卡為主的情境。
- **藍新金流（Neweb Pay）** — 台灣老牌金流商，中小企業常用。
- **綠界（ECPay）** — 台灣常見選項，串接文件多為中文。

## 概略執行步驟

1. 設計新的 `subscriptions`（多筆歷史）schema，決定主鍵與續訂觸發方式。
2. 寫資料遷移，把現有單筆記錄轉成新模型下的第一期記錄。
3. 重寫 `SetTier`/`ownerStanding`/`StandingFor`/`ListUsers` 這些假設「一人一筆」的邏輯。
4. 接入 Stripe：webhook 接收、驗證、subscription 狀態同步。
5. 設計扣款失敗與重試流程。
6. 補上對應的整合測試，涵蓋續訂、扣款失敗、新舊資料混存這幾種情境。
