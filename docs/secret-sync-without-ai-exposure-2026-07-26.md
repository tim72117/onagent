# 讓 AI 操作密碼同步流程，但不揭示明文（2026-07-26）

> 狀態：方案調研，尚未實作。目前 `deploy/update-secret-manager.sh`（人工手動貼值）與 `.github/workflows/deploy-cloudrun.yml`（Workload Identity 直接授權）已經是這裡描述的原則的兩種實踐，這份文件是為了「如果之後要導入一個本機/團隊密碼管理工具當中間層（例如 1Password、Vault），要怎麼做才不會讓 AI 在操作過程中看到明文密碼」而寫的參考。

## 問題

當 AI agent（如 Claude Code）被要求「幫我把本地存的密碼推送到 GCP Secret Manager」時，最直覺的做法是讓它執行類似 `op read op://vault/item/field` 的指令、把讀出來的值再餵給 `gcloud secrets versions add`。

**這個做法一定會讓明文密碼進入 AI 的對話上下文**：

1. AI 透過工具執行指令、讀取 stdout，這段輸出就成為對話歷史的一部分。
2. 這個對話 session、任何日誌/transcript 記錄機制都可能保存這段文字。
3. 即使 AI 不會主動把值印出來給使用者看，這段明文已經存在於它處理過的資料裡，無法「事後假裝沒看過」。

`deploy/update-secret-manager.sh` 之所以設計成 `read -s` 隱藏輸入、由使用者自己手動貼值，正是為了避免這件事——讓真正的機密值只在使用者自己的終端機輸入時短暫存在，AI 從頭到尾看不到、也不需要去讀它。

## 核心原則：注入模式（injection），不是讀取模式（read-and-forward）

業界對「工具/腳本要用到密碼，但操作者不該看到密碼」這個情境，已有成熟且专门設計的機制,共通點是「密碼只在目標子行程的環境變數裡短暫存在，呼叫端下的指令和看到的輸出都不包含明文本身」：

| 方案 | AI 能否看到明文 | 原理 |
|---|---|---|
| **Workload Identity / OIDC 直接授權**（本專案已在用） | 完全不會 | `google-github-actions/auth@v2` 用短期 token 直接授權 CI runner 讀取 Secret Manager，值只在 runner 記憶體裡流動，從不經過任何人或 AI 的終端輸出 |
| **1Password `op run --` / `op inject`** | 完全不會 | 樣板檔案只寫引用路徑（如 `ADMIN_BOOTSTRAP_PASSWORD=op://vault/item/field`），`op run` 執行當下才動態解析、注入成子行程的環境變數，AI 只需要下達「執行這支腳本」的指令 |
| **HashiCorp Vault Agent / sidecar** | 完全不會 | 背景 agent 把密碼寫進只有目標行程能讀的暫存檔或環境變數，呼叫端（含 AI）只觸發同步動作，不經手內容 |
| **Bitwarden `bws run --`** | 完全不會 | 與 `op run` 同一模式，Bitwarden Secrets Manager 的 CLI 版本 |
| **CI/CD Pipeline 完全交給非 AI 執行**（本專案已在用） | 完全不會 | AI 只負責寫/改 workflow 檔案，不參與實際觸發或觀察執行輸出中的機密部分 |

## 具體範例：1Password `op run --`

```bash
op run --env-file=deploy/secrets.env.tpl -- bash deploy/sync-to-secret-manager.sh
```

- `deploy/secrets.env.tpl` 只包含**引用路徑**，完全不含明文，可以安全地讓 AI 讀寫、甚至進 git：
  ```
  ADMIN_BOOTSTRAP_EMAIL=op://onagent-vault/admin/email
  ADMIN_BOOTSTRAP_PASSWORD=op://onagent-vault/admin/password
  ```
- `op run` 執行時才動態解析、注入成子行程（`sync-to-secret-manager.sh`）的環境變數。
- 子行程內部呼叫 `gcloud secrets versions add ADMIN_BOOTSTRAP_PASSWORD --data-file=-` 之類的指令完成推送，值透過 stdin/環境變數直接傳遞，不經過任何會被记录成對話文字的管道。
- AI 看到的只有「這行指令本身」以及「執行成功或失敗」的結果訊息——`op run` 不會把解析後的值印到 stdout。

## 無法迴避的前提：紀律，不是純技術保證

這個模式能成立，前提是兩件事都要成立：

1. **腳本本身要寫得乾淨**——不能有任何 `echo $SECRET_VAR`、`print(secret)`，`set -x`/`set -o xtrace` 這類 debug 模式絕對不能開（會把展開後的變數值印到 log）。
2. **AI 作為執行者，不主動查看/列印任何中間變數**——只下達「執行這支已經設計好的腳本」這個指令，不會、也不需要用任何方式把值讀出來確認。

也就是說，防線不是「工具自動保證絕對安全」，而是「設計正確的腳本」+「AI 不做多餘的讀取動作」共同成立。這跟本專案 `deploy/update-secret-manager.sh` 依賴使用者自己手動輸入、`deploy-cloudrun.yml` 依賴 Workload Identity 直接授權，本質上是同一條紀律的不同實踐方式。

## 建議（若未來要導入）

- 若已經在用 1Password 管理其他密碼：導入 `op run --` 模式改動最小，只需要把 `deploy/update-secret-manager.sh` 現有的「互動輸入」步驟，替換成「`op run` 注入 + 呼叫 `gcloud secrets versions add`」。
- 若沒有既有密碼管理工具、也不想額外訂閱：可以考慮 **SOPS + age/PGP**——本地維護一份加密過的 `secrets.enc.yaml`，可安全進 git 版本控制，寫一支腳本解密後逐一推送到 Secret Manager，零額外服務依賴。
- Vault 對目前這個專案的規模（單人/小團隊）可能是殺雞用牛刀，除非團隊已經在使用它。
- 不論選哪個工具，**沿用「樣板檔案存引用路徑、實際值只在執行當下短暫存在」的原則**，不要退回「AI 讀值再轉發」的模式。
