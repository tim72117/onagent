# BackendDispatch 串接指南（給第三方開發者）

> 這是操作型指南，教你怎麼把自己的後端工具接上 onagent。設計決策與討論過程請見
> [backend-tool-dispatch-design-2026-08-08.md](backend-tool-dispatch-design-2026-08-08.md)；
> 目前的實作是該文件的**最小可行版本**，本文件只涵蓋已經真的實作出來的部分——完整方案裡的簽章認證、
> 重試、非同步模式目前都還沒做，見下方「目前的限制」。

## 這是什麼

`BackendDispatch` 讓一個 tool 的執行邏輯跑在**你自己的後端**，而不是跑在瀏覽器頁面裡。onagent 的 LLM
選中這個 tool 時，onagent 伺服器會主動發一個 HTTP POST 請求到你指定的 endpoint，等你回應後把結果餵回
LLM 繼續推論。

跟現有「工具在瀏覽器執行」的機制（`@onagent/bridge` SDK）完全獨立、並存——你可以同一個 app 裡有些
tool 在瀏覽器執行、有些 tool 在你自己的後端執行。

## 前置準備（跟一般 onagent app 完全一樣）

在開始之前，你需要：

1. 一個已經註冊好的 onagent app（`appId`）
2. 一把該 app 的 API key（用來認證 WS 連線，不是給 `BackendDispatch` 用的——見下方「認證現況」）
3. 該 app 的 `AllowedOrigin` 已設定（讓你的前端能通過 WS handshake）

這三項都是既有機制，`BackendDispatch` 沒有另外新增任何 app 層級的設定。

## 設定步驟

### 1. 在 tools.yaml 加上 `backendDispatch` 區塊

```yaml
appId: your-app-id
tools:
  - name: recommend_nearby
    description: 依使用者目前位置推薦附近地點
    parameters:
      type: object
      properties:
        lat:
          type: number
        lng:
          type: number
      required: [lat, lng]
    backendDispatch:
      endpoint: https://your-backend.example.com/onagent/recommend_nearby
      timeoutMs: 8000
```

- `endpoint`：必填，onagent 會直接對這個網址發 POST。
- `timeoutMs`：選填，不填預設 20000（20 秒）。
- `kind`（既有欄位，`action`/`query`）對 `backendDispatch` 的 tool 沒有作用——只要設了
  `backendDispatch`，這個 tool 一律是阻塞式的：onagent 會等你的回應，並把結果餵回 LLM 的推理過程，
  行為等同既有的 `kind: query`。

### 2. 用 CLI 推上去

```bash
onagent save-tools <appId> tools.yaml
```

例如：

```bash
onagent save-tools your-app-id tools.yaml
```

`appId` 是必填的位置參數（目標要寫入哪個 app），不是從 YAML 檔案裡的 `appId` 欄位讀取的——同一份
`tools.yaml` 可以被重複用在不同 app 上。

**目前 console 網頁介面沒有地方可以直接新增這個欄位**，只能透過 YAML + CLI 推送。（如果你之後在
console 網頁裡編輯這個 tool 的其他欄位再存檔，`backendDispatch` 設定不會被清掉——但要「新增」還是得
走 CLI。）

推送完成後**不需要**額外重啟或重新註冊——下一次 LLM 推論就會讀到最新設定。

### 3. 實作你的 endpoint

onagent 會這樣呼叫你：

**Request**

```http
POST /onagent/recommend_nearby HTTP/1.1
Content-Type: application/json

{"toolName":"recommend_nearby","args":{"lat":25.03,"lng":121.56}}
```

**Response（成功）**

```json
{"ok": true, "result": {"places": ["Cafe A", "Cafe B"]}}
```

`result` 可以是任意 JSON 結構，會原封不動序列化後餵給 LLM，你回什麼、LLM 就看到什麼。

**Response（失敗）**

```json
{"ok": false, "error": "no results found"}
```

回 `ok:false` 時，`error` 這段文字目前**不會**特別處理（例如區分「查無資料」跟「你的服務掛了」），
只會讓 onagent 把這次工具呼叫視為失敗、把錯誤訊息往上拋。設計文件裡規劃的 `failureKind` 分類（暫時性
失敗 vs. 永久性失敗）還沒實作。

HTTP 狀態碼務必回 `2xx`——非 2xx 一律視為失敗，不會嘗試解析 body。

### 4. 觸發測試

目前只支援既有的 WS `hello`/`prompt` 路徑（設計文件裡規劃的 `POST /v1/apps/{appId}/complete` 給無
UI 場景用的新 endpoint還沒實作）：

1. 前端（或任何 WS client）連線 `wss://.../ws?token=<你的 API key>`
2. 送 `hello {appId}`
3. 送 `prompt`，內容能讓 LLM 判斷該呼叫 `recommend_nearby`
4. 觀察你自己 endpoint 有沒有收到 POST 請求

## 目前的限制（實作前務必知道）

- **完全沒有認證/簽章**：onagent 打去你 endpoint 的請求目前是**明文、未簽署**的。任何知道這個 URL
  的人都能偽造請求打過去，你的 endpoint 收到請求時無法驗證來源真的是 onagent。**現階段只適合接一個
  你已經透過其他管道（例如私下確認網址）信任的測試端點，不要接任何有副作用（寫入、扣款）的操作。**
  設計文件第 5 節規劃的 HMAC 簽章+雙密鑰輪替機制尚未實作。
- **沒有重試**：逾時或失敗不會自動重打，一次就是一次。
- **沒有 idempotency key**：因為沒有重試，目前不是急迫問題，但也代表你的 endpoint 不需要（也無法）
  處理重複請求去重。
- **只支援同步模式**：你的 endpoint 必須在 `timeoutMs` 內回應，逾時就是失敗。沒有「先回 202、稍後
  callback 通知結果」這種非同步模式。
- **PoC 範圍建議只接查詢型、無副作用的工具**（例如查資料、算推薦），不要接會改變你系統狀態的操作
  （退款、下單）——現階段沒有認證保護，也沒有重試/去重機制，拿來做有副作用的操作風險過高。

## 常見坑：網路可達性

onagent 發出這個 HTTP 請求的是 **onagent 伺服器自己**，不是使用者的瀏覽器。如果你的測試 endpoint
跑在自己筆電的 `localhost`，而 onagent 是跑在 Docker 容器或雲端環境，onagent 那邊解析
`localhost` 只會打到它自己，打不到你的機器。

本機測試時，建議用 [ngrok](https://ngrok.com/) 之類的工具開一個公開通道，把 `endpoint` 指向那個公開
網址，而不是 `localhost`。

## 逾時值怎麼抓

`timeoutMs` 沒填的話預設 20 秒。如果你的 endpoint 內部還要呼叫其他外部服務（例如 Google Places
API），記得抓夠涵蓋那個外部服務尾端延遲的空間，同時又不要設太大——onagent 這邊等待期間，這一輪
LLM 推論會整個卡住等你回應。
