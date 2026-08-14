# 跨站傳輸與安全性筆記

這個平台把一個 JS SDK 嵌入任意第三方開發者的網站，很像 Google Analytics 的
`gtag.js`——但跟 GA 單向的遙測資料不同，這個 SDK 是雙向的：後端可以推送
`tool_call` 訊息，在頁面上執行實際動作。這個差異決定了 GA 的設計哪些部分
適用、哪些不適用。以下發現來自研究 gtag.js/GA4 如何處理跨站資料傳輸，並
對照這個專案以 WebSocket 為基礎的設計。

## 我們借用 GA 的做法

- **Stub function + 佇列緩衝。** `gtag()` 是一個 stub，在真正的函式庫載入
  之前，先把參數推進 `window.dataLayer`；函式庫準備好之後再清空佇列。
  `AgentBridge` 內部做的是同一件事——在 WebSocket 連上 `ack` 之前呼叫的
  `prompt()`，會先被緩衝、等連線建立後才清空送出（見
  `packages/bridge/src/client.ts`）。呼叫端完全不需要檢查「是否已就緒」
  的旗標。
- **卸載時的 `sendBeacon` 備援。** GA 用 `sendBeacon`/keepalive `fetch`
  確保頁面關閉前最後一筆事件能送出。因為 WebSocket 連線在頁面卸載時會
  直接斷掉（無法保證傳送中的 frame 有送達），`AgentBridge` 在設定了
  `beaconUrl` 的情況下，會在 `visibilitychange -> hidden` 時選擇性地用
  `sendBeacon` 送出最後佇列裡的訊息。
- **給嵌入方的 CSP 文件。** GA 發布一段極簡的 CSP 片段給開發者加進自己
  的網站。我們也該做一樣的事（見下方）。

## GA 的做法裡不適用於這裡的部分

- **`no-cors` beacon 請求。** GA 的 `/g/collect` 端點通常是用 `no-cors`
  的 GET/POST 或 `sendBeacon` 打過去——瀏覽器允許這樣做、接收端完全不需要
  任何 CORS header，因為呼叫方根本不會讀取回應內容。這對單向遙測資料有效。
  但**對我們不適用**：我們需要讀回 `tool_call` 的回應，所以一個只能拿到
  不透明、讀不到內容的回應的傳輸方式，從一開始就不是選項。這正是為什麼
  主要通道是 WebSocket，不是 beacon。
- **依賴瀏覽器強制執行的跨來源保護。** CORS 保護的是**讀取**跨來源的回應
  內容；它對 WebSocket 的握手完全沒有規範。WebSocket 的 `Upgrade` 請求
  **不受** CORS 管控——任何網頁、任何來源，都能對任何 WebSocket 端點開啟
  連線，只要伺服器回應 `101`，瀏覽器就會欣然完成握手。`Origin` header
  雖然會被送出，但沒有任何機制強制伺服器去檢查它。

## 這對我們的實作意味著什麼

因為 WebSocket 沒有瀏覽器端的跨來源關卡，**伺服器是唯一的把關點**：

- `backend/internal/ws/handler.go` 在升級連線的 `CheckOrigin` callback
  裡，會拿 `Origin` header 去比對開發者設定的白名單（`APP_ORIGINS`），
  比對不到就直接拒絕握手。沒設定白名單時只會記錄成一則僅供開發環境
  參考的警告，絕不會用一種「看起來像正式環境安全」的方式靜默放行。
- Session 身份識別應該改成每個網站各自簽發的短效權杖（例如：用 app key
  換發一個 session token），而不是單純的 cookie——因為 cookie 會被瀏覽器
  自動附加到任何 WebSocket 握手上，這正是 CSRF 攻擊利用的同一種「環境
  隱含授權」問題。這部分**目前還沒實作**（目前還沒有這層認證機制），
  但在這個系統被用在任何超出本機/mock 資料的場景之前，應該要先做好。
- 工具派發永遠不會退回用 `eval` 或依任意名稱做動態屬性查找，一律走明確
  的白名單：`AgentBridge` 只會呼叫開發者在 `tools` 裡註冊過的 handler，
  其餘一律拒絕（明確回傳 `tool_result.ok = false`）。見 `client.ts` 裡
  的 `handleToolCall`。

## 建議給嵌入方網站的 CSP 設定

等這個系統部署到真實網域之後，發布類似這樣的設定：

```
connect-src https://api.<platform-domain> wss://ws.<platform-domain>;
script-src https://sdk.<platform-domain>;
```

兩個容易漏掉的細節（研究 GA 的 CSP 設定時發現的）：

- `connect-src` 必須明確包含 `wss://` scheme——只寫 `https://` 不會涵蓋
  WebSocket 的升級請求。
- 比起列出精確的主機名稱，優先用萬用字元涵蓋子網域
  （`https://*.<platform-domain>`），這樣之後新增 edge/region 端點時，
  不需要要求每個嵌入方網站都跟著更新自己的 CSP。

## 尚待處理的項目（尚未實作）

- 每個 session 各自的認證權杖簽發/驗證機制。
- `/ws` 跟 codegen 端點的速率限制/濫用防護。
- 後端一個真正的 `beaconUrl` HTTP 端點（SDK 端已經支援呼叫，但伺服器端
  的接收 handler 還不存在）。
