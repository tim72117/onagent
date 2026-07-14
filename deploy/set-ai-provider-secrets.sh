#!/usr/bin/env bash
# =============================================================================
# onagent — 互動式設定 AI_PROVIDER 相關的 Secret Manager secret
#
# 這支腳本會問你要用哪個 provider、要用哪個 model、要不要換金鑰，
# 直接在這支腳本裡完成 Secret Manager 的寫入 —— 不會印出金鑰本身、
# 不會把金鑰寫進任何檔案，金鑰只在這次執行的記憶體中短暫存在。
#
# 支援部分更新：model 那一步直接按 Enter 就完全略過 —— 不印出任何 AI_MODEL
# 建議值，deploy-cloudrun.yml 裡現有的設定維持不變；金鑰那一步會先問要不要
# 更新，選否就完全跳過輸入，不會動到 Secret Manager 裡現有的版本。
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
echo "  1) claude（Anthropic Claude，需要 ANTHROPIC_API_KEY）"
echo "  2) googleapis（Google Gemini，需要 GOOGLE_API_KEY）"
read -r -p "輸入 1 或 2: " PROVIDER_CHOICE

# 這兩個字串必須跟 want/orchestrator/init.go 的 InitializeWithConfig switch
# case 完全一致（"claude" / "googleapis"，不是更直覺的 "anthropic" / "google"）
# —— 打錯字不會在這支腳本被發現，是部署後的 Cloud Run 容器啟動時才會炸：
# "不支援的提供者: xxx"，所以這裡故意寫死成 want 認得的值，不留使用者自訂空間。
case "${PROVIDER_CHOICE}" in
  1)
    AI_PROVIDER="claude"
    SECRET_NAME="ANTHROPIC_API_KEY"
    DEFAULT_MODEL="claude-sonnet-5"
    ;;
  2)
    AI_PROVIDER="googleapis"
    SECRET_NAME="GOOGLE_API_KEY"
    DEFAULT_MODEL="gemini-2.5-pro"
    ;;
  *)
    echo "沒有這個選項，離開。"
    exit 1
    ;;
esac

# -----------------------------------------------------------------------------
# 2. 輸入 model 名稱 —— 留空真正代表「不變」：這支腳本不知道
#    deploy-cloudrun.yml 裡現在實際設定的是哪個 model，所以留空時不套用任何
#    值（包括下面的 DEFAULT_MODEL），只在你真的想指定新 model 時才印出來，
#    讓摘要不會意外覆蓋你已經在用、腳本並不知情的設定。
# -----------------------------------------------------------------------------
read -r -p "要用哪個 model？(直接按 Enter 表示不變，或輸入新值，例如 ${DEFAULT_MODEL}): " AI_MODEL
if [[ -z "${AI_MODEL}" ]]; then
  echo "略過 model 設定 —— deploy-cloudrun.yml 裡現有的 AI_MODEL 沿用不變。"
fi

# -----------------------------------------------------------------------------
# 3. 是否要更新金鑰值 —— 選否就完全跳過第 4 步，Secret Manager 裡現有的版本
#    原封不動，只有下面第 5 步的 AI_PROVIDER/AI_MODEL 摘要會印出來給你。
# -----------------------------------------------------------------------------
echo
read -r -p "要更新 ${SECRET_NAME} 的金鑰值嗎？(y/N，只是換 provider/model 不換金鑰請輸入 N): " UPDATE_KEY_CHOICE

if [[ "${UPDATE_KEY_CHOICE}" =~ ^[Yy]$ ]]; then
  # -----------------------------------------------------------------------------
  # 3a. 建立空的 secret 容器（已存在會略過，不算錯誤）—— 只有真的要寫入金鑰
  #     時才需要確保容器存在，跳過金鑰更新時沒有必要碰這步。
  # -----------------------------------------------------------------------------
  gcloud secrets create "${SECRET_NAME}" \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}" \
    >/dev/null 2>&1 \
    && echo "已建立 secret 容器：${SECRET_NAME}" \
    || echo "secret ${SECRET_NAME} 已存在，略過建立"

  # -----------------------------------------------------------------------------
  # 3b. 互動輸入金鑰值（不回顯在畫面上、不進 shell history、不落地成檔案），
  #     直接在這裡寫入 Secret Manager。
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
else
  echo "略過金鑰更新 —— ${SECRET_NAME} 沿用 Secret Manager 裡現有的版本。"
fi
echo

# -----------------------------------------------------------------------------
# 5. 摘要 —— AI_PROVIDER/AI_MODEL 不是機密，不進 Secret Manager，
#    印出來給你貼回去給我，我會據此更新 deploy-cloudrun.yml。AI_MODEL 只在
#    你第 2 步真的有輸入時才印出來；留空代表「不變」，這裡就不印，避免你
#    誤把它當成「要改成某個值」貼給我，結果覆蓋掉現有設定。
# -----------------------------------------------------------------------------
echo "=============================================="
echo " 完成。請把下面這幾行貼給我，我會更新"
echo " .github/workflows/deploy-cloudrun.yml："
echo "=============================================="
echo
echo "   AI_PROVIDER=${AI_PROVIDER}"
if [[ -n "${AI_MODEL}" ]]; then
  echo "   AI_MODEL=${AI_MODEL}"
else
  echo "   AI_MODEL=（不變，沿用 workflow 裡現有的值）"
fi
echo "   (secret: ${SECRET_NAME}=${SECRET_NAME}:latest)"
echo
echo "=============================================="
