#!/usr/bin/env bash
# =============================================================================
# onagent — 互動式設定 AI_PROVIDER 相關的 Secret Manager secret
#
# 這支腳本會問你要用哪個 provider、要用哪個 model、金鑰內容是什麼，
# 直接在這支腳本裡完成 Secret Manager 的寫入 —— 不會印出金鑰本身、
# 不會把金鑰寫進任何檔案，金鑰只在這次執行的記憶體中短暫存在。
#
#     用法：bash deploy/set-ai-provider-secrets.sh
# =============================================================================

set -euo pipefail

PROJECT_ID="onagent-prod"

echo "=============================================="
echo " onagent AI_PROVIDER 設定"
echo " PROJECT_ID = ${PROJECT_ID}"
echo "=============================================="
echo

# -----------------------------------------------------------------------------
# 1. 選 provider
# -----------------------------------------------------------------------------
echo "要用哪個 provider？"
echo "  1) anthropic（Claude，需要 ANTHROPIC_API_KEY）"
echo "  2) google（Gemini，需要 GOOGLE_API_KEY）"
read -r -p "輸入 1 或 2: " PROVIDER_CHOICE

case "${PROVIDER_CHOICE}" in
  1)
    AI_PROVIDER="anthropic"
    SECRET_NAME="ANTHROPIC_API_KEY"
    DEFAULT_MODEL="claude-sonnet-5"
    ;;
  2)
    AI_PROVIDER="google"
    SECRET_NAME="GOOGLE_API_KEY"
    DEFAULT_MODEL="gemini-2.5-pro"
    ;;
  *)
    echo "沒有這個選項，離開。"
    exit 1
    ;;
esac

# -----------------------------------------------------------------------------
# 2. 輸入 model 名稱
# -----------------------------------------------------------------------------
read -r -p "要用哪個 model？(直接按 Enter 用預設值 ${DEFAULT_MODEL}): " AI_MODEL_INPUT
AI_MODEL="${AI_MODEL_INPUT:-${DEFAULT_MODEL}}"

# -----------------------------------------------------------------------------
# 3. 建立空的 secret 容器（已存在會略過，不算錯誤）
# -----------------------------------------------------------------------------
gcloud secrets create "${SECRET_NAME}" \
  --replication-policy="automatic" \
  --project="${PROJECT_ID}" \
  >/dev/null 2>&1 \
  && echo "已建立 secret 容器：${SECRET_NAME}" \
  || echo "secret ${SECRET_NAME} 已存在，略過建立"

# -----------------------------------------------------------------------------
# 4. 互動輸入金鑰值（不回顯在畫面上、不進 shell history、不落地成檔案），
#    直接在這裡寫入 Secret Manager。
# -----------------------------------------------------------------------------
echo
read -r -s -p "貼上 ${SECRET_NAME} 的實際金鑰值（輸入時不會顯示）: " API_KEY_VALUE
echo
if [[ -z "${API_KEY_VALUE}" ]]; then
  echo "沒有輸入任何內容，離開，不寫入 secret。"
  exit 1
fi

printf '%s' "${API_KEY_VALUE}" | gcloud secrets versions add "${SECRET_NAME}" \
  --data-file=- \
  --project="${PROJECT_ID}"
unset API_KEY_VALUE

echo "已寫入 ${SECRET_NAME} 的新版本。"
echo

# -----------------------------------------------------------------------------
# 5. 摘要 —— AI_PROVIDER/AI_MODEL 不是機密，不進 Secret Manager，
#    印出來給你貼回去給我，我會據此更新 deploy-cloudrun.yml。
# -----------------------------------------------------------------------------
echo "=============================================="
echo " 完成。請把下面這兩行貼給我，我會更新"
echo " .github/workflows/deploy-cloudrun.yml："
echo "=============================================="
echo
echo "   AI_PROVIDER=${AI_PROVIDER}"
echo "   AI_MODEL=${AI_MODEL}"
echo "   (secret: ${SECRET_NAME}=${SECRET_NAME}:latest)"
echo
echo "=============================================="
