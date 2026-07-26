#!/usr/bin/env bash
# =============================================================================
# onagent — 互動式更新 Secret Manager 裡的所有 secret
#
# 這支腳本會逐一詢問要不要更新每個 secret，直接在這支腳本裡完成 Secret
# Manager 的寫入 —— 不會印出機密值本身、不會把機密寫進任何檔案，值只在這次
# 執行的記憶體中短暫存在。
#
# 支援部分更新：每個 secret 都先問「要更新嗎？(y/N)」，選否（或直接按
# Enter）就完全跳過該項，不會動到 Secret Manager 裡現有的版本。可以只更新
# 其中一個、幾個，或全部都跳過。
#
#     用法：bash deploy/update-secret-manager.sh
# =============================================================================

set -euo pipefail

PROJECT_ID="onagent-prod"

echo "=============================================="
echo " onagent Secret Manager 更新"
echo " PROJECT_ID = ${PROJECT_ID}"
echo "=============================================="
echo

# -----------------------------------------------------------------------------
# upsert_secret <secret 名稱> <提示文字>：互動詢問是否更新、要更新就建立容器
# (已存在則略過)+ 隱藏輸入寫入新版本。跳過的 secret 完全不動 Secret Manager
# 裡現有的版本。
# -----------------------------------------------------------------------------
upsert_secret() {
  local name="$1"
  local prompt_label="$2"

  read -r -p "要更新 ${name} 嗎？(y/N): " update_choice
  if [[ ! "${update_choice}" =~ ^[Yy]$ ]]; then
    echo "略過 ${name} —— 沿用 Secret Manager 裡現有的版本。"
    echo
    return 0
  fi

  gcloud secrets create "${name}" \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}" \
    >/dev/null 2>&1 \
    && echo "已建立 secret 容器：${name}" \
    || echo "secret ${name} 已存在，略過建立"

  read -r -s -p "貼上 ${prompt_label} 的實際值（輸入時不會顯示）: " secret_value
  echo
  if [[ -z "${secret_value}" ]]; then
    echo "沒有輸入任何內容，略過 ${name}，不寫入 secret。"
    echo
    return 0
  fi

  printf '%s' "${secret_value}" | gcloud secrets versions add "${name}" \
    --data-file=- \
    --project="${PROJECT_ID}"
  unset secret_value

  echo "已寫入 ${name} 的新版本。"
  echo
}

upsert_secret "DATABASE_URL" "Postgres DSN"
upsert_secret "GOOGLE_API_KEY" "Google API 金鑰"
upsert_secret "ADMIN_BOOTSTRAP_EMAIL" "admin 後台第一個帳號的 email"
upsert_secret "ADMIN_BOOTSTRAP_PASSWORD" "admin 後台第一個帳號的密碼"

echo "=============================================="
echo " 完成。"
echo
echo " 提醒：新建立的 secret 要另外把"
echo "   KEY=SECRET_NAME:latest"
echo " 加進 .github/workflows/deploy-cloudrun.yml 的 --update-secrets，"
echo " 才會實際掛載到 Cloud Run service（見該檔案現有寫法）。"
echo "=============================================="
