---
name: onagent-cli-setup
description: 協助使用者透過 onagent CLI 登入 onagent 平台、在 console 建立 app、定義並推送 tool 到 onagent 開發者平台。當使用者想串接 onagent SDK、建立 tool、或詢問如何使用 onagent CLI 時使用這個 skill。
---

# onagent CLI 設定與 Tool 串接

協助使用者完成 onagent 平台的完整串接流程：取得並登入 `onagent` CLI、在 console 建立 app 與設定必要參數、定義並推送 tool。

## 一、取得 onagent CLI 並登入

### 1. 檢查/取得 onagent CLI

**這個 skill 內建預先編譯好的 `onagent` 執行檔**，位於 `${CLAUDE_SKILL_DIR}/bin/`（`onagent-windows-amd64.exe`、`onagent-darwin-amd64`、`onagent-darwin-arm64`、`onagent-linux-amd64`、`onagent-linux-arm64`）。全域 PATH 上通常不會有 `onagent` 指令，**不要**直接執行裸指令 `onagent`，而是呼叫 `${CLAUDE_SKILL_DIR}/bin/` 底下對應目前平台的執行檔，例如：

```bash
"${CLAUDE_SKILL_DIR}/bin/onagent-linux-amd64" app list
```

若目前平台在 `bin/` 目錄下沒有對應的執行檔，不要嘗試執行不存在的檔案，也不要自行編譯或安裝——直接告知使用者這個 skill 目前沒有適用於他們平台的執行檔。

### 2. 登入

> 以下與後續章節為了簡潔，一律直接寫 `onagent login`、`onagent app list`、`onagent tool create` 等指令；實際執行時請替換成上一步判斷出來的完整路徑，例如 `${CLAUDE_SKILL_DIR}/bin/onagent-linux-amd64 login --web`，而不是直接執行裸指令 `onagent`。

`onagent` 提供兩種登入方式，指向的後端與 console 網址預設都是 `https://onagent.shuttle.tools`，如需指向本機開發環境可用 `-api`、`-console` 參數覆蓋。**`-console` 預設會直接繼承 `-api` 解析後的值**（因為 console 前端通常跟後端 API 同源部署）——只設 `-api` 就會同時決定 CLI 呼叫後端 API 打去哪裡、以及 `--web` 開瀏覽器要跳去的網址：例如 `onagent login --web -api http://localhost:8081`，瀏覽器會開到 `http://localhost:8081`，不需要額外再指定 `-console`。只有當 console 前端跟 API 不同源時（例如各自獨立部署），才需要另外用 `-console <url>` 覆蓋瀏覽器要開的網址。

- **`onagent login --web [-api <url>] [-console <url>]`**：開啟瀏覽器走網頁登入流程。這是預設應該優先使用的方式，適合互動式終端機環境，也是唯一能確保跟 console 網頁 UI（例如之後建立 app、簽發 apiKey）使用同一組登入狀態的方式。
- **`onagent login [-api <url>]`**：在終端機互動輸入 email/password 登入，不會開瀏覽器。適合沒有瀏覽器可用的環境（例如純 SSH、CI/無頭環境），或使用者明確表示不想開瀏覽器時使用。

兩者只是登入的互動方式不同，登入後的本機憑證狀態是通用的，後續 `onagent` 指令不需要再指定是用哪種方式登入的。

執行時直接照使用者情境選一種即可；若不確定，優先嘗試 `onagent login --web`。

### 3. 確認登入成功

登入後可用 `onagent app list` 驗證憑證是否生效：

```bash
onagent app list
```

- 如果回傳結果是 app 清單（即使是空清單），代表登入成功。
- 如果出現類似「not logged in」的錯誤訊息，代表尚未登入或憑證已失效，需要回到步驟 2 重新執行 `onagent login` 或 `onagent login --web`。

確認 `onagent app list` 不再出現「not logged in」錯誤後，才視為登入流程完成，可以繼續後續操作（例如在 console 建立 app、`onagent tool create`）。

## 二、建立 App、發 Key、設定 Origin

建立 app、發 API key、設定 Allowed origin 三件事現在都已經有對應的 `onagent` CLI 指令，也都可以在 console 網頁 UI 完成，兩種方式效果相同、擇一即可。`onagent` 的指令樹是 `<resource> <verb>` 形式：`app list`/`app create`/`app delete`/`app origin set`/`app thought set`、`key issue`/`key revoke`、`tool list`/`tool create`/`tool delete`，再加上 `login`/`login --web`。

### 1. 建立 app

優先用 CLI 建立（記得替換成上一節判斷出來的完整路徑）：

```bash
onagent app create <appId>
```

appId 合法格式必須符合正則 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`，也就是：
- 只能以英文字母或數字開頭
- 之後可以包含英文字母、數字、`-`、`_`

也可以在 https://onagent.shuttle.tools/app 登入後點「+ New app」手動建立，效果相同，只是多一道開瀏覽器的步驟。

需要刪除整個 app（連同底下所有 tool、key、origin 設定一併刪除，無法復原）時：

```bash
onagent app delete <appId>
```

### 2. 定義 tools

在 console 的 tool 編輯器裡定義 tool 並按 Save；也可以改用 `onagent tool create <appId> <tool.yaml>` 從本機檔案推上去，效果相同——**一份檔案只描述一個 tool**，`tool create` 會依 `name` 新增或取代同名的既有 tool，不會動這個 app 底下的其他 tool。完整的檔案格式與範例請見下一節「定義 tool 並用 onagent tool create 推上去」。

需要移除單一 tool 時：

```bash
onagent tool delete <appId> <toolName>
```

### 3. 發 API key

優先用 CLI 發：

```bash
onagent key issue <appId>
```

也可以在 console 裡按「Issue key」取得 `apiKey`，效果相同。**務必提醒使用者兩件事：**
- 明文的 `apiKey` **只會顯示這一次**，離開畫面（或終端機輸出捲走）後就再也看不到、拿不回來。
- 如果需要重新取得，只能「重新發一組」，而重新發一組會讓**舊的 key 立刻失效**。所以如果目前正式環境已經在用某一把 key，不要隨意重發，以免正式環境的連線瞬間全部失敗。

需要單純撤銷目前的 key（不換新的）時：

```bash
onagent key revoke <appId>
```

### 4. 設定 Allowed origin

優先用 CLI 設定：

```bash
onagent app origin set <appId> <origin>
```

`<origin>` 填你網站的完整 origin，例如 `https://your-site.example.com`（**不要**加路徑、**不要**加結尾斜線）。也可以在 console 的「Allowed origin」欄位填入同樣的值並按 Save origin，效果相同。

**這一步最容易被忽略，但沒做的話後果是整個串接完全失敗：只要 Allowed origin 沒設定，這個 app 的所有 WebSocket 連線都會被拒絕（fail-closed）——即使 `apiKey` 完全正確也一樣連不上。** 如果使用者回報「apiKey 明明是對的，但連線就是被拒絕／WebSocket 連不上」，第一件事就是提醒他們檢查這個 app 的 Allowed origin 是否已經設定、且與實際部署網域完全一致。

### 5. 設定 Thought（system prompt）

優先用 CLI 設定：

```bash
onagent app thought set <appId> <thought>
```

這是目前唯一能透過 CLI 寫入某個 app 的 thought（want agent 的自訂 system prompt）的指令，也可以改到 console 網頁 UI 的 Agent thought 編輯器操作，兩者效果相同。

傳空字串（`onagent app thought set <appId> ""`）會清除自訂 thought，改回平台預設值。

## 三、定義 tool 並用 onagent tool create 推上去

除了在 console 網頁 UI 用 tool 編輯器手動定義 tool，也可以把 tool 定義寫成一份本機的 YAML 檔案，再用 `onagent tool create` 指令推上去，效果完全相同。**一份檔案只描述一個 tool**——當使用者的 tool 數量較多、需要版本控制、或想要重複套用到多個 app 時，優先建議這個方式，每個 tool 各存一份檔案。

### tool 檔案的精確格式

檔案結構如下，各欄位規則務必照著寫，不要自行增減欄位：

- `name`（必填）：必須符合正則 `^[a-zA-Z_][a-zA-Z0-9_]*$`（英文字母或底線開頭，之後只能是英文字母、數字、底線），同一個 app 裡不能重複。
- `description`（必填）：給 LLM 判斷何時該呼叫這個 tool 的說明文字。
- `parameters`（必填）：JSON Schema 的子集，用來描述這個 tool 接受的參數：
  - `type`（必填）：目前這一層通常固定寫 `object`。
  - `properties`：物件，每個 key 是參數名稱，value 描述該參數的 `type`（支援 `string`、`number`、`integer`、`boolean`、`array`、`object`）與選填的 `description`。
  - `required`（選填）：陣列，列出哪些參數名稱是必填。
  - 若某個參數本身是 `array`，用 `items` 描述元素型別；若是 `object`，用 `properties`（可再搭配 `required`）描述其欄位，可以巢狀。
- `returns`（選填）：格式與 `parameters` 相同的 JSON Schema 子集，用來描述回傳值的形狀。這個欄位只用於 TypeScript 型別產生（codegen），不會送給 LLM，可以省略。
- `kind`（選填）：`action`（預設，不填即是這個）或 `query`。`action` 是 fire-and-forget——onagent 只在意呼叫成功與否，你的回傳值不會被 LLM 看到；`query` 會把你的回傳值（依 `returns` 的形狀）餵回 LLM 的推理過程。兩者目前都是阻塞式的，差別只在回傳值是否被 LLM 讀取，不在於是否等待回應。

（`onagent app thought set <appId> <thought>`（見上一節「設定 Thought」）是設定/修改 thought 唯一的方式，跟這裡的 tool 檔案完全無關，是獨立的兩件事。）

### 範例

```yaml
name: search_products
description: Search the product catalog by keyword.
parameters:
  type: object
  properties:
    query:
      type: string
      description: The search keywords.
    maxResults:
      type: integer
  required:
    - query
returns:
  type: array
  items:
    type: object
    properties:
      id: { type: string }
      name: { type: string }
kind: query
```

另一個範例，`kind` 省略（預設為 `action`）：

```yaml
name: add_to_cart
description: Add a product to the current user's shopping cart.
parameters:
  type: object
  properties:
    productId:
      type: string
      description: The product's unique ID.
    quantity:
      type: integer
      description: How many units to add. Defaults to 1 if omitted.
  required:
    - productId
```

把每個 tool 各自存成一份本機檔案（例如 `search_products.yaml`、`add_to_cart.yaml`）後，逐一推上去：

```bash
onagent tool create <appId> search_products.yaml
onagent tool create <appId> add_to_cart.yaml
```

`onagent tool create` 依檔案裡的 `name` 決定要新增還是取代同名的既有 tool，不會動這個 app 底下其他 tool；同一份檔案可以原封不動地重複套用到多個不同的 appId。

執行前 `onagent` 會先在本機做一次 `Validate()`，通過才會送出。

要查看某個 app 目前所有 tool 的定義：

```bash
onagent tool list <appId>
```

### 常見驗證錯誤

協助使用者除錯時，優先檢查以下幾種最常見的驗證失敗原因：

- **tool name 不符合正則**：`name` 沒有以英文字母或底線開頭、或裡面含有連字號 `-`、空白、中文等不合法字元，都會被 `^[a-zA-Z_][a-zA-Z0-9_]*$` 擋下。
- **缺少 description**：檔案沒填 `description`。
- **缺少 parameters.type**：`parameters` 底下沒有寫 `type`（或整個 `parameters` 欄位被省略）。

遇到 `onagent tool create` 報錯時，先對照上述三點逐一檢查 yaml 內容，而不是猜測是網路或權限問題。

## 完整流程總覽

1. 判斷目前平台（`uname -sm` 或 Windows），呼叫 skill 內建的 `${CLAUDE_SKILL_DIR}/bin/onagent-<os>-<arch>[.exe]`；目前實際內建 Windows、Intel/Apple Silicon macOS、Linux（amd64/arm64）共五種組合，偵測到其他更少見的平台就告知使用者此 skill 目前沒有對應執行檔，不要自行編譯或安裝。
2. 執行 `onagent login --web`（或無瀏覽器環境用 `onagent login`）登入。
3. 用 `onagent app list` 確認不再出現「not logged in」，驗證登入成功。
4. 執行 `onagent app create <appId>` 建立 app（也可以到 console 網頁 https://onagent.shuttle.tools/app 點「+ New app」手動建立，效果相同）。需要刪除 app 時用 `onagent app delete <appId>`（無法復原）。
5. 定義 tool：在 console 的 tool 編輯器手動輸入，或每個 tool 各撰寫一份本機 YAML 檔準備用 `onagent tool create` 推送。
6. 執行 `onagent key issue <appId>`（或在 console 按「Issue key」）取得 `apiKey`，並立刻妥善保存（**只顯示一次**，重發會讓舊 key 立刻失效）。需要單純撤銷 key 時用 `onagent key revoke <appId>`。
7. 執行 `onagent app origin set <appId> <origin>`（或在 console 設定「Allowed origin」）為實際部署網域並存檔（**未設定會 fail-closed，WebSocket 全部連不上**，即使 `apiKey` 正確也一樣）。
8. 若採用 YAML 檔方式，對每個 tool 各自執行 `onagent tool create <appId> <tool.yaml>` 推送——這個指令依檔案裡的 `name` 新增或取代同名 tool，不會動這個 app 底下的其他 tool。需要移除某個 tool 時用 `onagent tool delete <appId> <toolName>`；查看目前所有 tool 用 `onagent tool list <appId>`。
9. 若 `tool create` 驗證失敗，依序檢查：tool name 正則、`description` 是否缺漏、`parameters.type` 是否缺漏。
10. 若要設定或修改 thought，執行 `onagent app thought set <appId> <thought>`（或在 console 的 Agent thought 編輯器操作），與 `tool create` 是各自獨立的步驟。
