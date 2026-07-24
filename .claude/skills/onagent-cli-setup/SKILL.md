---
name: onagent-cli-setup
description: 協助使用者透過 onagent CLI 登入 onagent 平台、在 console 建立 app、定義並推送 tool 到 onagent 開發者平台。當使用者想串接 onagent SDK、建立 tool、或詢問如何使用 onagent CLI 時使用這個 skill。
---

# onagent CLI 設定與 Tool 串接

協助使用者完成 onagent 平台的完整串接流程：取得並登入 `onagent` CLI、在 console 建立 app 與設定必要參數、定義並推送 tool。

## 一、取得 onagent CLI 並登入

### 1. 檢查/取得 onagent CLI

**這個 skill 內建預先編譯好的 `onagent` 執行檔**，位於 `${CLAUDE_SKILL_DIR}/bin/`。目前只實際內建了：

- `onagent-windows-amd64.exe`

（原本曾一次編過 linux/darwin 共 4 個平台，之後決定先只保留 Windows；下面的平台判斷邏輯仍保留完整寫法，未來若補回其他平台的執行檔，不需要再改這段邏輯，只要把對應檔案放進 `bin/` 目錄即可生效。）

`go install github.com/tim72117/onagent/cmd/onagent@latest` 現在也能用了（go.mod 的 module path 先前跟實際 repo 位置對不上導致 `go install` 失敗，這個問題已修好；`backend/` 本身就是 module root，所以路徑不含 `backend/`）。但即使如此，**優先使用上面內建的執行檔**：不需要本機裝 Go 工具鏈、不需要等編譯、也不依賴網路抓取私有相依套件。全域 PATH 上通常也不會有 `onagent` 指令，所以**不要**直接執行裸指令 `onagent`，而是要先判斷目前所在平台，再直接呼叫 `${CLAUDE_SKILL_DIR}/bin/` 底下對應的執行檔。

判斷平台的方式：

- **Unix-like（Linux / macOS）**：執行 `uname -sm` 取得 OS 與 CPU 架構，再對應成 `<os>-<arch>`：
  - `Linux x86_64` → `linux-amd64`
  - `Linux aarch64` / `Linux arm64` → `linux-arm64`
  - `Darwin x86_64` → `darwin-amd64`
  - `Darwin arm64` → `darwin-arm64`
- **Windows**：直接使用 `windows-amd64`（bundled 目前只涵蓋這個組合）。

判斷完成後，直接用 Bash 呼叫對應的檔案（記得先確認/賦予執行權限），例如：

```bash
# Linux/macOS，以偵測到 linux-amd64 為例
chmod +x "${CLAUDE_SKILL_DIR}/bin/onagent-linux-amd64"
"${CLAUDE_SKILL_DIR}/bin/onagent-linux-amd64" list-apps
```

```bash
# Windows
"${CLAUDE_SKILL_DIR}/bin/onagent-windows-amd64.exe" list-apps
```

不要假設 `onagent` 已經加進 PATH，每次呼叫都應該用上述判斷邏輯組出完整路徑直接執行。如果之後在同一個 session 裡要重複呼叫，可以把判斷出來的完整路徑存進一個變數重複使用，但不要省略判斷平台這一步、也不要寫死成單一平台的路徑。

**判斷出來的檔案在 `bin/` 目錄下實際不存在時**（目前只有 `onagent-windows-amd64.exe` 真的存在，判斷出 Linux/macOS 的情況一定會落到這裡），改用下面的「備援方案」，不要嘗試執行一個不存在的檔案。

#### 備援方案：自行 clone + 編譯

目前只內建 Windows 的執行檔，判斷出其他平台（Linux、macOS，或更少見的 linux/386、linux/arm 等）時都會落到這裡。如果本機已有 Go 工具鏈，最簡單的方式是：

```bash
go install github.com/tim72117/onagent/cmd/onagent@latest
```

沒有 Go 工具鏈的話，才 fallback 用 clone 整個 repo 後在本機用 `go build` 編譯：

```bash
git clone https://github.com/tim72117/onagent.git
cd onagent/backend
go build -o onagent ./cmd/onagent
```

編譯完成後會在 `backend` 目錄下產生 `onagent`（Windows 上是 `onagent.exe`）執行檔。之後可以用相對路徑（如 `./onagent` 或 `.\onagent.exe`）呼叫，或自行加進 PATH。

### 2. 登入

> 以下與後續章節為了簡潔，一律直接寫 `onagent login`、`onagent list-apps`、`onagent save-tools` 等指令；實際執行時請替換成上一步判斷出來的完整路徑，例如 `${CLAUDE_SKILL_DIR}/bin/onagent-linux-amd64 login --web`，而不是直接執行裸指令 `onagent`。

`onagent` 提供兩種登入方式，指向的後端與 console 網址預設都是 `https://onagent.shuttle.tools`，如需指向本機開發環境可用 `-api`、`-console` 參數覆蓋。

- **`onagent login --web [-api <url>] [-console <url>]`**：開啟瀏覽器走網頁登入流程。這是預設應該優先使用的方式，適合互動式終端機環境，也是唯一能確保跟 console 網頁 UI（例如之後建立 app、簽發 apiKey）使用同一組登入狀態的方式。
- **`onagent login [-api <url>]`**：在終端機互動輸入 email/password 登入，不會開瀏覽器。適合沒有瀏覽器可用的環境（例如純 SSH、CI/無頭環境），或使用者明確表示不想開瀏覽器時使用。

兩者只是登入的互動方式不同，登入後的本機憑證狀態是通用的，後續 `onagent` 指令不需要再指定是用哪種方式登入的。

執行時直接照使用者情境選一種即可；若不確定，優先嘗試 `onagent login --web`。

### 3. 確認登入成功

登入後可用 `onagent list-apps` 驗證憑證是否生效：

```bash
onagent list-apps
```

- 如果回傳結果是 app 清單（即使是空清單），代表登入成功。
- 如果出現類似「not logged in」的錯誤訊息，代表尚未登入或憑證已失效，需要回到步驟 2 重新執行 `onagent login` 或 `onagent login --web`。

確認 `onagent list-apps` 不再出現「not logged in」錯誤後，才視為登入流程完成，可以繼續後續操作（例如在 console 建立 app、`onagent save-tools`）。

## 二、建立 App、發 Key、設定 Origin

建立 app、發 API key、設定 Allowed origin 三件事現在都已經有對應的 `onagent` CLI 指令，也都可以在 console 網頁 UI 完成，兩種方式效果相同、擇一即可。`onagent` 目前有 `login`、`login --web`、`list-apps`、`create-app`、`issue-key`、`set-origin`、`save-tools` 七個指令。

### 1. 建立 app

優先用 CLI 建立（記得替換成上一節判斷出來的完整路徑）：

```bash
onagent create-app <appId>
```

appId 合法格式必須符合正則 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`，也就是：
- 只能以英文字母或數字開頭
- 之後可以包含英文字母、數字、`-`、`_`

也可以在 https://onagent.shuttle.tools/app 登入後點「+ New app」手動建立，效果相同，只是多一道開瀏覽器的步驟。

### 2. 定義 tools

在 console 的 tool 編輯器裡定義 tool 並按 Save；也可以改用 `onagent save-tools <appId> <tools.yaml>` 從本機檔案推上去，效果相同（`save-tools` 只會把檔案裡的 `tools` 內容送出，且一律套用指令參數上的 `appId`，跟檔案裡寫的 `appId` 無關）。完整的 `tools.yaml` 撰寫格式與範例請見下一節「定義 tool 並用 onagent save-tools 推上去」。

### 3. 發 API key

優先用 CLI 發：

```bash
onagent issue-key <appId>
```

也可以在 console 裡按「Issue key」取得 `apiKey`，效果相同。**務必提醒使用者兩件事：**
- 明文的 `apiKey` **只會顯示這一次**，離開畫面（或終端機輸出捲走）後就再也看不到、拿不回來。
- 如果需要重新取得，只能「重新發一組」，而重新發一組會讓**舊的 key 立刻失效**。所以如果目前正式環境已經在用某一把 key，不要隨意重發，以免正式環境的連線瞬間全部失敗。

### 4. 設定 Allowed origin

優先用 CLI 設定：

```bash
onagent set-origin <appId> <origin>
```

`<origin>` 填你網站的完整 origin，例如 `https://your-site.example.com`（**不要**加路徑、**不要**加結尾斜線）。也可以在 console 的「Allowed origin」欄位填入同樣的值並按 Save origin，效果相同。

**這一步最容易被忽略，但沒做的話後果是整個串接完全失敗：只要 Allowed origin 沒設定，這個 app 的所有 WebSocket 連線都會被拒絕（fail-closed）——即使 `apiKey` 完全正確也一樣連不上。** 如果使用者回報「apiKey 明明是對的，但連線就是被拒絕／WebSocket 連不上」，第一件事就是提醒他們檢查這個 app 的 Allowed origin 是否已經設定、且與實際部署網域完全一致。

## 三、定義 tool 並用 onagent save-tools 推上去

除了在 console 網頁 UI 用 tool 編輯器手動定義 tool，也可以把 tool 定義寫成一份本機的 `tools.yaml` 檔案，再用 `onagent save-tools` 指令一次推上去，效果完全相同。當使用者的 tool 數量較多、需要版本控制、或想要重複套用到多個 app 時，優先建議這個方式。

### tools.yaml 的精確格式

檔案結構如下，各欄位規則務必照著寫，不要自行增減欄位：

- `appId`（最上層，可省略）：可以寫，但沒有實際作用——執行 `onagent save-tools <appId> <file>` 時，一律以指令參數上的 `appId` 為準，檔案裡寫的值會被完全覆蓋、忽略不採用。
- `thought`（最上層，選填）：want agent 的自訂 system prompt，可省略。
- `tools`（必填）：一個陣列，每個元素是一個 tool 定義，包含：
  - `name`（必填）：必須符合正則 `^[a-zA-Z_][a-zA-Z0-9_]*$`（英文字母或底線開頭，之後只能是英文字母、數字、底線），同一個 app 裡不能重複。
  - `description`（必填）：給 LLM 判斷何時該呼叫這個 tool 的說明文字。
  - `parameters`（必填）：JSON Schema 的子集，用來描述這個 tool 接受的參數：
    - `type`（必填）：目前這一層通常固定寫 `object`。
    - `properties`：物件，每個 key 是參數名稱，value 描述該參數的 `type`（支援 `string`、`number`、`integer`、`boolean`、`array`、`object`）與選填的 `description`。
    - `required`（選填）：陣列，列出哪些參數名稱是必填。
    - 若某個參數本身是 `array`，用 `items` 描述元素型別；若是 `object`，用 `properties`（可再搭配 `required`）描述其欄位，可以巢狀。
  - `returns`（選填）：格式與 `parameters` 相同的 JSON Schema 子集，用來描述回傳值的形狀。這個欄位只用於 TypeScript 型別產生（codegen），不會送給 LLM，可以省略。

### 完整範例

```yaml
appId: my-app
thought: ""
tools:
  - name: search_products
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

  - name: add_to_cart
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

把這份檔案存成本機檔案（例如 `tools.yaml`）後，用以下指令推上去：

```bash
onagent save-tools <appId> tools.yaml
```

`<appId>` 這個指令參數會覆蓋檔案內 `appId` 欄位寫的值——`onagent save-tools` 只會讀取並送出檔案裡的 `tools` 陣列，實際套用到哪個 app 完全由指令參數決定。這代表同一份 `tools.yaml` 可以原封不動地重複套用到多個不同的 appId，不需要為每個 app 各寫一份檔案、也不用記得同步修改檔案內的 `appId`。

執行前 `onagent` 會先在本機做一次 `Validate()`，通過才會送出。

### 常見驗證錯誤

協助使用者除錯時，優先檢查以下幾種最常見的驗證失敗原因：

- **tool name 不符合正則**：`name` 沒有以英文字母或底線開頭、或裡面含有連字號 `-`、空白、中文等不合法字元，都會被 `^[a-zA-Z_][a-zA-Z0-9_]*$` 擋下。
- **缺少 description**：`tools` 陣列裡任何一個 tool 沒填 `description`。
- **缺少 parameters.type**：`parameters` 底下沒有寫 `type`（或整個 `parameters` 欄位被省略）。
- **重複的 tool name**：同一個 app 的 `tools` 陣列裡出現兩個相同的 `name`。

遇到 `onagent save-tools` 報錯時，先對照上述四點逐一檢查 yaml 內容，而不是猜測是網路或權限問題。

## 完整流程總覽

1. 判斷目前平台（`uname -sm` 或 Windows），呼叫 skill 內建的 `${CLAUDE_SKILL_DIR}/bin/onagent-<os>-<arch>[.exe]`；目前只實際內建 Windows，偵測到其他平台就用 `go install`（現在可以用了）或 clone repo 後 `go build` 自行編譯。
2. 執行 `onagent login --web`（或無瀏覽器環境用 `onagent login`）登入。
3. 用 `onagent list-apps` 確認不再出現「not logged in」，驗證登入成功。
4. 執行 `onagent create-app <appId>` 建立 app（也可以到 console 網頁 https://onagent.shuttle.tools/app 點「+ New app」手動建立，效果相同）。
5. 定義 tool：在 console 的 tool 編輯器手動輸入，或撰寫本機 `tools.yaml` 準備用 `onagent save-tools` 推送。
6. 執行 `onagent issue-key <appId>`（或在 console 按「Issue key」）取得 `apiKey`，並立刻妥善保存（**只顯示一次**，重發會讓舊 key 立刻失效）。
7. 執行 `onagent set-origin <appId> <origin>`（或在 console 設定「Allowed origin」）為實際部署網域並存檔（**未設定會 fail-closed，WebSocket 全部連不上**，即使 `apiKey` 正確也一樣）。
8. 若採用 `tools.yaml` 方式，執行 `onagent save-tools <appId> tools.yaml` 推送（指令參數的 `appId` 一律覆蓋檔案內的 `appId`）。
9. 若 `save-tools` 驗證失敗，依序檢查：tool name 正則、`description` 是否缺漏、`parameters.type` 是否缺漏、tool name 是否重複。
