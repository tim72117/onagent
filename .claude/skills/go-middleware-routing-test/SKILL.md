---
name: go-middleware-routing-test
description: 為 Go net/http 專案裡的 CORS/origin-checking 類 middleware 撰寫兩層測試——一層測 middleware 函式本身的行為，一層測「哪些路由實際接上了哪個 middleware/allowlist」的路由接線是否正確。當使用者要求「幫這個 middleware 寫測試」、「測試路由的 CORS 設定」，或改動了依路徑分派不同 origin allowlist 的程式碼時使用。
---

# Middleware 行為測試 + 路由接線測試（兩層模式）

## 核心觀念：兩種測試各自抓不同的錯

只測 middleware 函式本身（傳入假的 `next` handler、直接呼叫），**測不出**「這個路由到底有沒有接對 middleware」這種接線錯誤——例如把 `/admin/*` 手滑接成 `publicCORS` 而非該用的嚴格 checker，middleware 單元測試依然全過，因為它只驗證函式邏輯,不驗證誰在用它。

因此當程式碼裡有「依路徑分派到不同 origin allowlist」這種模式時（例如同一個 `withCORS`/`corsMiddleware` 被套用到多組路由，各自綁定不同的允許清單），必須寫兩層測試：

1. **Middleware 單元測試**——驗證函式本身：給定一個 allowlist、給定 Origin header，回應該不該有 CORS header。不管路徑字串，因為 middleware 本身通常也不检查路徑。
2. **路由整合測試**——驗證接線本身：把「建構 mux、掛載各路由群組」這段邏輯抽成獨立可測試的函式，測試時傳入假的 handler，發真實 HTTP 請求打實際路徑（`/console/ping`、`/admin/ping` 等），確認每條路徑拿到的 middleware/allowlist 符合預期。

第 2 層是最容易被省略、但最容易抓到真實漏洞的一層——真正的資安事故往往不是 middleware 邏輯寫錯，而是某個路由忘了套 middleware、或套錯了 allowlist。

## 步驟

### 1. 確認可測試性：mux 建構邏輯是否已抽成獨立函式

檢查路由掛載程式碼是否還埋在 `main()`（或其他不可單獨呼叫的大函式）裡。如果是,先做最小侵入的抽取：

- 把「建 sub-mux、呼叫 `handler.Register(subMux)`、包 middleware、`mux.Handle(prefix, wrapped)`」這幾行抽成一個獨立函式，例如 `mountCredentialedRoutes(mux *http.ServeMux, console, admin routeRegistrar, allowed OriginChecker)`。
- 為了讓測試能傳入假 handler 而非需要真實 DB 的 handler，定義一個只含 `Register(mux *http.ServeMux)` 的最小介面（例如 `routeRegistrar`），而不是要求具體型別——真正的 handler 天然滿足這個介面,不需要改動它們的程式碼。
- `main()` 本身改成呼叫這個新函式,行為不變。

### 2. 寫 middleware 單元測試

對每個 middleware 函式（例如 `corsMiddleware(allowed) func(http.Handler) http.Handler`），至少涵蓋：

- 屬於這個 middleware 的 allowlist 內的 origin → 應該拿到對應的 CORS header（`Access-Control-Allow-Origin` 精確等於該 origin，而非 `*`，若牽涉 credentials）。
- **刻意用「屬於另一份 allowlist、但不屬於這份的 origin」去測試拒絕情境**，而不是隨便編一個假網域——這樣能明確證明「這份清單不會不小心信任了另一份清單的來源」，直接對應防止未來有人把兩份清單合併（`anyOf`）的回歸。
- 若有公開、非 credentialed 的 middleware（例如回 `*` 的），也要驗證它不會意外帶上 `Access-Control-Allow-Credentials`。

用 `httptest.NewRequest` + `httptest.NewRecorder()` 直接呼叫 middleware 包裝過的 handler，不需要真正啟動 server。

### 3. 寫路由整合測試

用第 1 步抽出的函式，搭配一個「最小假 handler」：

```go
type fakeRegistrar struct {
    patterns []string // 模擬真實 handler.Register 會註冊的所有路徑
}

func (f fakeRegistrar) Register(mux *http.ServeMux) {
    for _, p := range f.patterns {
        mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
            w.WriteHeader(http.StatusOK)
        })
    }
}
```

注意：如果真實 handler 會把多個前綴（例如 `/console/*` 與 `/auth/*`）註冊在**同一個** sub-mux 上，`fakeRegistrar` 也要模擬這個行為（讓 `patterns` 同時含兩種前綴），否則測試會漏掉「兩個前綴共用同一個 sub-mux/middleware」這個真實拓樸,前面就有踩過這個坑：一開始誤把 `/auth/ping` 直接註冊到最外層 mux，繞過了中間的 middleware 包裝，導致測試沒有真正驗證到 `/auth/*` 的 CORS 行為。

測試案例至少涵蓋每一組「路由前綴 × (屬於自己 allowlist 的 origin / 屬於別份 allowlist 的 origin)」的組合，用 table-driven test 寫最省重複：

```go
cases := []struct {
    name   string
    path   string
    origin string
    wantCC bool
}{
    {"console trusts site origin", "/console/ping", siteOrigin, true},
    {"console rejects third-party app origin", "/console/ping", thirdPartyOrigin, false},
    // ...admin、auth 等其餘前綴同樣模式
}
```

### 4. 驗證

跑 `go build ./...`、`go vet ./...`、`go test ./<package>/... -v`，確認新測試通過、且沒有破壞既有 build。

## 為什麼要分兩層而不是只做其中一層

- 只做第 1 層（middleware 單元測試）：邏輯正確性有保障，但接線錯誤（漏接、接錯 allowlist）完全測不到。
- 只做第 2 層（路由整合測試）：能測到接線，但如果 middleware 內部邏輯本身有 bug（例如漏判某個 header），測試案例通常不會像專門的單元測試那樣窮舉邊界情況，容易漏測。
- 兩層一起做，且刻意讓路由整合測試使用真實 handler 會註冊的完整路徑清單（而非只測一條路徑），才能同時涵蓋「函式邏輯對不對」與「這段邏輯真的被用在正確的地方」。
