# 可觀測性方案研究：現成 vs 自建（2026-07-25）

> 主題：針對「觀測系統狀態、用戶行為、異常偵測」三塊，調查成熟的現成方案與自建方案，比較兩者的
> 難度、成本、適用時機，給出決策建議。
>
> 方法：兩個 Opus subagent 分別研究「系統狀態」與「用戶行為」的現成方案（含外部工具實際調研與定價），
> 主線程負責「異常偵測」（與 onagent 核心路徑細節綁定較深）並整合。
>
> **決定一切的前提**：onagent 部署在 **Google Cloud Run**、後端 Go、資料庫 Postgres、個人/小團隊、
> 目前**零可觀測性依賴**（`go.mod` 無任何 otel/prometheus/sentry；純 `slog.NewTextHandler` 文字日誌；
> 無指標/追蹤/告警；`/healthz` 無條件回 200 不碰 DB）。

---

## 一句話結論

**「自建訊號發射器、購買承載平台」——而你要買的平台，其實已經買了，就是 GCP。**

因為跑在 Cloud Run 上，請求數、延遲分佈、錯誤率、CPU/記憶體、自動 trace **全部零成本零程式碼就有**。
外部 SaaS 能加的價值有限，反而是 process 內部狀態（那個推論 mutex 的佇列深度）**沒有任何外部工具看得到，
只能自建**。所以大部分該做的是「把訊號好好發出去」，而非「買一個地方存訊號」。

---

## 一、系統狀態觀測（後端健康、請求成敗、延遲、資源、DB、推論佇列）

### 最高槓桿的事實：因為在 Cloud Run 上，你已經擁有大部分

GCP 自動免費提供（零程式碼）：
- **`request_count`（依 HTTP 狀態碼標記）+ `request_latencies`（p50/p95/p99）** = 錯誤率與延遲，已在 Cloud Monitoring
- **CPU/記憶體/instance 數/啟動延遲** = 資源用量
- **自動請求 trace**，且 Cloud-Run 產生的 span **不計費**
- stdout/stderr 日誌已由 Cloud Logging 收集（約 50 GiB/專案/月免費）

**免費拿不到的兩塊**，正是要靠少量程式碼補的：
1. **日誌 severity**——純 `slog.NewTextHandler` 全部落成無差別的 `INFO` 文字，無法過濾錯誤、無法告警
2. **process 內部狀態**——推論 mutex 佇列深度、DB 可達性、per-tool 計時、WebSocket 狀態

### 該自建的（便宜、優先做）

| 自建項目 | 成本 | 為何便宜且高價值 |
|---|---|---|
| **slog JSON handler**（`level→severity`、`msg→message`） | 1-2 小時 | 立刻解鎖 Cloud Logging 的 severity 過濾、錯誤篩選、log-based 指標。**全文件投報率最高的一項** |
| **會檢查 DB 的 `/healthz`**（`db.PingContext` 帶逾時） | 1 小時 | 取代無條件 200，讓 uptime check 反映真實健康 |
| **記憶體內 counter 掛在 `/admin/api/live`**（推論佇列深度=mutex 等待者、in-flight 數、tool 呼叫延遲、LLM 呼叫數/錯誤） | 約半天 | **唯一能看到單一 mutex 塞車的地方**，沒有任何現成工具看得到，因為那是 process 內部狀態。`expvar` 或一個小 gauge struct 就夠 |
| **Cloud Monitoring log-based 告警**（severity≥ERROR 暴增、`/healthz` uptime 失敗） | 1-2 小時 | 用你已經零成本擁有的基礎設施 |

**要避免的假節約**：不要自建日誌儲存/搜尋 UI、指標 TSDB、儀表板層——Cloud Logging + Metrics Explorer
已經做好了。自建只到「發出結構良好的訊號」為止，承載與查詢是免費商品化的東西。

### 現成方案比較（系統狀態）

| 方案 | 觀測範圍 | 整合成本 | 持續費用 | 何時不夠用 |
|---|---|---|---|---|
| **GCP 原生**（Logging/Monitoring/Trace/Error Reporting） | 上述全部 + 你的 JSON 日誌與告警 | 只需 JSON stdout（無需 SDK） | ~$0（2026-09 起告警每指標約 $0.35/月，本規模微不足道） | 高基數自訂指標會變貴；UI 較陽春 |
| **Sentry**（錯誤+追蹤） | panic、例外、錯誤分組、trace span | Go SDK（`sentry-go`）約 2 小時 | 免費 5K 錯誤/月、1 使用者；$26/月（50K） | 長期都夠；但不是指標/日誌儲存 |
| **Grafana Cloud** | 日誌+指標+追蹤+儀表板 | OTel/Prom exporter 約 1 天 | 免費：10K series、50GB、14 天保留 | 14 天保留 + 10K series 上限 |
| **Better Stack** | 日誌搜尋 + uptime/on-call | 約 2-3 小時 | 免費 3GB/3 天 + 10 monitors；約 $24-29/月 | 免費日誌量/保留期小 |
| **Axiom** | 高量日誌/事件儲存 | 約半天 | 免費 500GB 攝入/月、30 天 | 大量查詢時的運算費 |
| **SigNoz** | 日誌+指標+追蹤（OTel 原生） | 雲端半天/自架數天 | 雲端 $0.30/GB、**最低 $49/月**；自架免費但要自己顧 ClickHouse | 自架的維運負擔對小團隊立刻是負擔 |
| ~~Highlight.io~~ | — | — | **託管服務已於 2026-02 停止**（併入 LaunchDarkly），排除 | — |

---

## 二、用戶行為觀測（註冊 → 啟用 → 流失漏斗、功能採用）

### 現況：onagent 的資料已經能回答大部分漏斗

`usage_events` 帳本（`schema.sql`）加上 `users.created_at`、`apps`、`subscriptions`，**今天就能查、零新增埋點**：
- **註冊趨勢/世代**：`users.created_at`
- **建 app、推工具、設 origin、發 key**：可從 `apps`（`owner_id`/`allowed_origin`/`api_key_hash`）與 `tools` 列數推導
  ——但這些是**狀態**、不是帶時間戳的事件，看得到「目前形狀」但看不到「每步何時發生、順序如何」
- **各 owner/app 的 prompt 量**：`usage_events`
- **流失代理指標**：有 app 但近期無 `usage_events` 的 owner

### 唯一算不出來、卻最關鍵的：「真的上線」事件

決定付費意願的那個數字——**「第一次來自開發者自己網站的 prompt」vs「來自 console Playground 的 prompt」**
——目前**算不出來**。已驗證兩條路徑寫入的資料列一模一樣（`playground.go:202` 與 `ws/session.go:273` 都是
`kind='prompt'`、無 origin、無來源旗標）。

所以「這個開發者真的上線了嗎」**不是一個 join 就能算，而是需要新埋點**：在 `usage_events` 加一個
`source`/`origin` 欄位，或給 Playground prompt 一個不同的 `kind`。改動小，但是真的要改。這是自建路線的
**唯一前置條件**。

### 現成方案比較（用戶行為）

| 方案 | 回答什麼 | 整合成本 | 費用 | 隱私/資料所有權 | 天花板 |
|---|---|---|---|---|---|
| **自建於 Postgres**（擴充 `integrity.go:37` 的 `integrityQueries` registry 模式 + admin 面板） | 註冊/啟用/留存漏斗、prompt 量、各 app 採用——帳本已隱含的全部，加上上線事件（補一欄後） | 幾個漏斗查詢 + 一個 admin 分頁；registry 是 struct-literal append，admin API/SPA 已經在 iterate 它（`adminconsole.go:152`）；上線事件 = 1 migration + 1 寫入點 | 約 1-2 天；$0 邊際（自己的 Postgres） | **完全**——資料不離開自家 DB，對開發者工具受眾是正確預設 | 臨時探索、事件路徑分析、session replay、給非工程師的自助儀表板 |
| **PostHog**（產品分析裝在 console） | 完整漏斗、留存、路徑、feature flag、session replay、自助 | console（React）裝 SDK + 後端事件捕捉 | 免費 ≤1M 事件/月（此階段很夠）；自架是 MIT Docker 但維運重 | 雲端資料外流；自架換回所有權但要顧維運 | —（這就是天花板本身） |
| **Plausible**（行銷站） | `apps/landing` 的流量、來源、熱門頁、referrer——**不是**產品行為 | 一個 <1KB script tag | $9/月雲端（10K views）或自架（需 PG+ClickHouse、約 4GB RAM） | 無 cookie、對 GDPR 友善，很適合公開網站 | 看不到登入後的產品漏斗 |
| **Amplitude/Mixpanel 免費層** | B2B 產品分析、PM 友善 | console 裝 SDK + 後端 | Amplitude 免費 ≤50K MTU；Mixpanel 免費/新創方案 | 雲端、資料外流 | pre-PMF 過度；設定比 PostHog 重 |
| ~~June.so~~ | — | — | **已於 2025-08 收攤**併入 Amplitude，這個「簡單 B2B 分析」的位置已塌陷到 PostHog/Mixpanel 免費層 | — | — |

---

## 三、異常偵測（fail-open、逾時、goroutine 洩漏、推論塞車）

這塊 onagent 現況最赤裸：**只有 10 個純文字 `log.Warn/Error`，沒有任何一個能觸發告警**——異常發生了
也沒人知道。盤點目前「會發生但看不到」的異常：

| 異常 | 位置 | 目前的可見度 |
|---|---|---|
| **quota fail-open**（DB 錯誤時放行無限免費推論） | `ws/handler.go:149`、`ws/session.go:247`、`playground.go:205` | 只有一行純文字 `Warn`，無法告警——**一次 DB 分區 = 靜默的無上限 LLM 開銷** |
| **推論逾時**（90 秒） | `want.go:63` `completeTimeout` | 回一個 error，無計數、無告警 |
| **互動逾時**（頁面 20 秒沒回應） | `session.go:322` `interactionTimeout` | 同上 |
| **pong 逾時**（連線 60 秒沒回應） | `session.go:25` | 連線靜默關閉 |
| **panic** | 已有 recover middleware（`main.go`）+ `session.go`/`playground.go` 的 goroutine | 有 recover 但只是純文字 log，沒有 Sentry 那種分組/堆疊/告警 |

### 這塊的現成 vs 自建

- **現成的最佳解是 Sentry**——panic 分組、堆疊追蹤、錯誤趨勢告警，這正是 GCP Error Reporting 做得比較不優雅
  的那塊。`sentry-go` 約 2 小時接上，免費層對這個規模很夠。
- **自建的部分**：把上表每個 fail-open/timeout 從「純文字 log」升級成「帶結構欄位的事件 + 一個計數器」
  ——這**依賴第一塊的 slog JSON handler 先做好**（否則發出去的還是查不了、告不了警的文字）。做完 slog JSON 後，
  這些幾乎是順手：每個 fail-open 發一個 `quota_check_failopen` 計數，Cloud Monitoring 設一條告警即可。

**異常偵測的結論**：Sentry（現成，2 小時）補 panic/錯誤分組那塊；其餘 fail-open/timeout 的可觀測性是自建，
但**完全搭在第一塊 slog JSON 的基礎上**，不是獨立工作。

---

## 綜合建議與順序

**「自建發射器、買 GCP + 兩個便宜的現成品補洞」**：

**第一階段（一個聚焦的工作日，約 $0/月，onagent 單獨可完成）**：
1. **slog JSON→severity handler**（1-2 小時）——**一切的地基**，三塊都依賴它
2. **會檢查 DB 的 `/healthz`**（1 小時）
3. **記憶體內 gauge 掛 `/admin/api/live`**（半天）——推論 mutex 佇列深度、in-flight 數，**外部工具看不到的唯一視角**
4. **兩條 Cloud Monitoring log-based 告警**（1-2 小時）——fail-open 暴增、`/healthz` 失敗

做完這一階段，就有了：請求率/延遲/錯誤（GCP 免費）、資源用量（免費）、DB 健康、以及那個沒有任何 SaaS
看得到的單一 mutex 塞車視角——全部約 $0/月。

**第二階段（各約 2 小時-1 天的現成品，補 GCP 較弱的兩塊）**：
- **Sentry 免費層**（約 2 小時）——panic/錯誤分組與堆疊，補異常偵測
- **Plausible 裝在 `apps/landing`**（一個 script tag，約 $9/月）——行銷站流量/來源，這是跟產品漏斗**不同的工作**

**第三階段（用戶行為，約 1-2 天，前置條件：先補上線事件欄位）**：
- 先在 `usage_events` 加 `source`/`origin` 欄位，才能區分「真的上線」vs Playground 點擊
- 用 `integrity.go` 現成的 registry 模式擴充出漏斗查詢 + admin 分頁，資料完全留在自家 Postgres

**明確暫緩到成長階段**：Grafana Cloud / SigNoz / OTel sidecar（自訂指標的長期歷史）、PostHog（臨時探索/
session replay）——現在導入是這個階段回收不了的維運負擔。

---

*三塊各自的「最該先做且無可替代」的一件事：系統狀態 → **slog JSON handler**（所有觀測的地基）；
用戶行為 → **補上線事件欄位**（否則沒有任何工具能分辨真實啟用與 Playground 點擊）；
異常偵測 → **Sentry 免費層**（GCP 唯一做得較弱的一塊）。前兩者 onagent 單獨可做、當天可上線。*
