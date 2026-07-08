# 完整版 OAuth：開放給第三方客戶端註冊（未實作，設計文件）

尚未實作。這份文件記錄「如果之後要開放讓**別人寫的工具**（不是我們自己的 `atp` CLI）也能用瀏覽器授權流程存取使用者帳號」時的完整設計。目前實作的簡化版（`atp login --web`，見 `backend/cmd/atp/main.go`、`backend/internal/console/console.go` 的 `approveCliAuth`、`apps/console/src/CliAuthPage.tsx`）刻意省略了這裡的機制，因為目前只有一個第一方客戶端（我們自己的 CLI），核准畫面不需要分辨「是誰在請求」。

## 現在的簡化版 vs. 完整版差在哪

| | 現在的簡化版 | 完整版 |
|---|---|---|
| 客戶端身份 | 沒有，固定就是「CLI 想登入」 | 有 `client_id`，核准畫面顯示「XXX 應用程式想存取你的帳號」 |
| redirect 網址驗證 | 前端寫死只接受 `http://localhost:*`/`http://127.0.0.1:*` | 依 `client_id` 查詢預先註冊的 redirect URI 白名單，拒絕不在清單內的網址 |
| 核准後拿到什麼 | 直接把 token 放進 redirect 網址的 query string | 先給一個短效、一次性的「授權碼」，客戶端再用授權碼換 token（見下方「為什麼要多一道換碼」） |
| 客戶端如何證明自己 | 不用證明，反正只有我們自己的 CLI 會呼叫 | PKCE（見下方），不需要客戶端保存密鑰 |

## 為什麼要多一道「授權碼換 token」，不能像現在這樣直接把 token 放進網址

現在的簡化版把 token 直接塞進 redirect 網址（`http://127.0.0.1:PORT/callback?token=...`），這對「只有我們自己的 CLI 會用」這個場景是可接受的簡化，但有真實風險：

- 網址本身可能被瀏覽器歷史紀錄、代理伺服器/CDN 的存取 log、`Referer` header 意外記下來——如果網址裡直接放著一個長效的登入憑證，等於這些地方都變成憑證外洩點
- 一旦開放給**別人寫的**第三方客戶端，我們沒辦法保證每個客戶端的實作品質，這個風險會被放大

完整 OAuth 的做法是：redirect 網址只帶一個**短效、一次性**的「授權碼」（authorization code），客戶端再另外發一個 POST 請求，用授權碼換真正的 token。就算授權碼透過上述管道外洩，效用也很低——很快過期、只能用一次，而且換碼時還要附上 PKCE 驗證值（下面說明），單獨一個授權碼被撿到也換不出 token。

## PKCE：讓客戶端不用保存密鑰也能安全換 token

CLI 工具、瀏覽器前端這類「公開客戶端」有個先天問題：它們的原始碼在使用者機器上，**沒辦法安全保存一把密鑰**（不像我們自己的後端可以）。傳統 OAuth 用 `client_secret` 讓客戶端證明自己身份，但這招對公開客戶端不適用——密鑰放進 CLI 裡等於公開了。

PKCE（[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)）解法：

```
1. 客戶端在發起流程前，自己產生一組隨機字串 code_verifier（43~128 字元）
2. 算出 code_challenge = base64url(sha256(code_verifier))
3. 發起授權請求時，只帶 code_challenge（不帶 code_verifier 本身）
4. 使用者核准後，拿到授權碼
5. 客戶端拿授權碼去換 token 時，這次要附上原始的 code_verifier
6. 後端重新算一次 sha256(code_verifier)，比對是否等於當初收到的 code_challenge
   —— 一致才給 token
```

這樣即使授權碼在中途被攔截，攻擊者沒有原始的 `code_verifier`（從沒在任何網路請求裡出現過），沒辦法換到 token。

## 完整流程圖

```
第三方客戶端                        後端                          使用者瀏覽器
    │                                 │                                 │
    │  產生亂數 code_verifier          │                                 │
    │  code_challenge =                │                                 │
    │    base64url(sha256(verifier))   │                                 │
    │                                  │                                 │
    │  開瀏覽器導到：                   │                                 │
    │  /cli-auth?                      │                                 │
    │    client_id=xxx&                │                                 │
    │    redirect_uri=...&             │                                 │
    │    code_challenge=...&           │                                 │
    │    state=...                     │                                 │
    │ ─────────────────────────────────┼────────────────────────────────>│
    │                                  │                                 │
    │                                  │  依 client_id 查註冊資訊，       │
    │                                  │  核對 redirect_uri 是否在        │
    │                                  │  該客戶端的白名單內               │
    │                                  │  （不在白名單直接拒絕，           │
    │                                  │   不進到核准畫面）                │
    │                                  │                                 │
    │                                  │  核准畫面顯示：                  │
    │                                  │  「{client.name} 想存取你的帳號」 │
    │                                  │<────────────────────────────────│
    │                                  │  使用者按下核准                  │
    │                                  │<────────────────────────────────│
    │                                  │                                 │
    │                                  │  產生短效授權碼，                │
    │                                  │  記下 code_challenge/            │
    │                                  │  redirect_uri/user_id            │
    │                                  │                                 │
    │  redirect 回：                    │                                 │
    │  {redirect_uri}?                 │                                 │
    │    code=xxx&state=...            │                                 │
    │ <─────────────────────────────────┼─────────────────────────────────│
    │                                  │                                 │
    │  POST /oauth/token                │                                 │
    │  { code, code_verifier,          │                                 │
    │    client_id }                   │                                 │
    │ ─────────────────────────────────>│                                │
    │                                  │  驗證 sha256(code_verifier)      │
    │                                  │  == 當初記下的 code_challenge     │
    │                                  │  驗證通過才發 token               │
    │  { token }                       │                                 │
    │ <─────────────────────────────────│                                 │
```

## 需要新增的東西

### 資料庫：客戶端註冊表

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id     TEXT PRIMARY KEY,   -- 公開值，不是密鑰，可以寫在客戶端原始碼裡
    name          TEXT NOT NULL,      -- 核准畫面顯示用，例如 "Acme CLI"
    redirect_uris TEXT[] NOT NULL,    -- 白名單，每個必須是完整、精確比對的網址（不接受萬用字元，避免寬鬆比對被繞過）
    owner_id      BIGINT REFERENCES users (id) ON DELETE CASCADE, -- 誰註冊的這個客戶端
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 短效授權碼，換過一次就作廢
CREATE TABLE IF NOT EXISTS oauth_codes (
    code            TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_challenge  TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,    -- 記下當初核准時實際用的 redirect_uri，換碼時要求完全一致
    expires_at      TIMESTAMPTZ NOT NULL, -- 建議 1~10 分鐘內
    used            BOOLEAN NOT NULL DEFAULT false, -- 換過一次就標記，防止授權碼被重複使用
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 新增端點

- `GET /console/oauth-clients` / `POST /console/oauth-clients`——讓使用者自己註冊/管理第三方客戶端（類似 GitHub「Developer settings → OAuth Apps」），需要登入
- `POST /console/cli-auth/approve` 要擴充：多驗證 `client_id` 存在、`redirect_uri` 在該客戶端白名單內；核准後不再直接回 token，改成產生 `oauth_codes` 一筆紀錄，redirect 帶授權碼回去
- `POST /oauth/token`——不需要登入（授權碼本身 + PKCE 驗證值就是憑證），驗證授權碼未過期、未使用過、`code_verifier` 雜湊比對通過，成功才呼叫 `usertoken.Issue` 發真正的 token，並把該授權碼標記為已使用

### CLI/客戶端這邊要多做的事

- 產生 `code_verifier`/`code_challenge`（`crypto/rand` + `crypto/sha256`，Go 標準庫就有，不用額外套件）
- 從單純「收到 callback 存 token」，改成「收到 callback 裡的授權碼，再多發一個 POST 換 token」

## 什麼時候該做

現在（只有一個第一方 CLI）不需要——`client_id`/PKCE/授權碼換 token 這整套機制存在的意義，是在**不完全信任的第三方客戶端生態系**裡才成立。等真的有「別人寫的工具想串接這個平台、代表使用者操作」的需求出現時，再回來做這份設計，不要提前做。
