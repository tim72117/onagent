# onagent

[![License: BSL 1.1](https://img.shields.io/badge/license-BSL%201.1-blue.svg)](LICENSE)

onagent 是一個推論服務：開發者把自己的網站或軟體串接上 onagent，終端使用者就能直接用自然語言操作，不需要自建一套 LLM agent 系統。

## Features

- **開箱即用的推論服務**：開發者描述自己網站有哪些操作（搜尋、填表單、導航、下單等），onagent 負責把使用者的自然語言請求轉成實際的工具呼叫，不需要自己架設或維運 LLM agent 邏輯。
- **Agent Bridge SDK**：瀏覽器端 SDK，處理與推論服務的連線、重連、指令派發，讓 LLM 能就地操作頁面（填表單、跳轉、標示元素）——串接幾行程式碼就能為自己的網站加上 AI 操作能力。
- **BackendDispatch**：工具呼叫也可派發到開發者自己的後端服務，不限於瀏覽器端操作，串接既有的後端系統一樣適用。
- **工具 schema 自動產生**：從描述的操作自動產生 LLM 工具定義與對應的前端型別，串接時不用自己手刻 schema。
- **開發者主控台**：管理應用、工具定義、API 金鑰、允許連線網域、agent 系統提示詞，並附即時測試用的 Playground。同樣的操作也可透過 CLI 完成。
- **帳號與配額系統**：開發者帳號、CLI 長效權杖、應用專屬 API 金鑰各自獨立管理；用量以不可竄改的紀錄逐筆累加，依訂閱方案限制每月額度。
- **營運後台**：獨立於開發者帳號體系之外，供內部人員管理帳號、方案，並提供資料庫結構一致性檢查。

## Quick Start

需要 Go 1.26+、Node 20+、Postgres（本機開發可用預設連線字串，見下方）。

```bash
# 1. 啟動後端（AI_PROVIDER 未設定時使用 mock 推論，不需要任何 LLM 憑證即可跑起來）
cd backend
go run ./cmd/server

# 2. 開發者主控台（另開一個終端機）
cd apps/console
npm install
npm run dev   # http://localhost:5173

# 3. 營運後台（選用，非開發第三方應用時不需要）
cd apps/admin
npm install
npm run dev   # http://localhost:5174
```

大多數情境只需要 backend + console 就能開發、測試工具定義；admin 是給內部維運用的獨立介面。

## Configuration

後端透過環境變數設定。複製 `backend/.env.example` 為 `backend/.env` 並填入實際值：

```bash
cp backend/.env.example backend/.env
```

| 變數 | 說明 |
|---|---|
| `ADDR` | 監聽位址，預設 `:8080` |
| `DATABASE_URL` | Postgres 連線字串 |
| `APP_ORIGINS` | 允許開啟 `/ws` 的第三方網站來源（CSV），正式環境必填 |
| `ALLOWED_ORIGIN` | 本專案自己前端（console/admin）的來源（CSV），正式環境必填 |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | 啟動時建立的第一個營運後台帳號 |
| `QUOTA_ENABLED` | 設為 `false` 停用每月額度限制（自建部署適用） |
| `AI_PROVIDER` / `AI_MODEL` | LLM 供應商與模型，未設定時使用 mock 推論 |
| `VLLM_BASE_URL` / `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` | 對應供應商所需的連線資訊 |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URL` | 選用的「用 Google 登入」設定；`CLIENT_ID` 未設定時整個功能停用 |

完整清單與說明：`go run ./cmd/server -h`。

## Development

```bash
cd backend
go build ./...
go vet ./...
go test ./...                          # 不需要資料庫的單元測試
go test -tags integration ./... \
  -args -dsn "<your-postgres-dsn>"     # 需要真實 Postgres 的整合測試
```

前端各 app（`apps/console`、`apps/admin`）皆使用 Vite + React，`npm run build` 產生 production build。

## License

[Business Source License 1.1](LICENSE) — 發布 4 年後自動轉為 Apache License 2.0。
