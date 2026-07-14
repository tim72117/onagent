#!/usr/bin/env bash
# =============================================================================
# onagent — 每晚 23:00 自動關閉 Cloud SQL（onagent-db），省下閒置時段的費用
#
# 不會自動重新開機 —— 這是刻意的設計：早期流量小、使用時間不固定，隔天要用
# 時自己手動執行：
#
#     gcloud sql instances patch onagent-db --project=onagent-prod --activation-policy=ALWAYS
#
# 這支腳本本身是 idempotent 的 setup 腳本，不是排程本體 —— 排程本體是它建立
# 的 Cloud Scheduler job（沒有本機/GitHub Actions 依賴，由 Google 的排程服務
# 在雲端直接呼叫 Cloud SQL Admin API，不需要任何機器在背景常駐執行）。重複
# 執行這支腳本是安全的：service account/IAM/scheduler job 已存在時會直接
# 略過，不會報錯或建立重複資源。
#
#     用法：bash deploy/setup-nightly-sql-shutdown.sh
# =============================================================================

set -euo pipefail

PROJECT_ID="onagent-prod"
INSTANCE="onagent-db"
SA_NAME="cloudsql-nightly-stop"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_NAME="nightly-stop-onagent-db"
SCHEDULE="0 23 * * *"       # 每天 23:00
TIME_ZONE="Asia/Taipei"

echo "=============================================="
echo " onagent Cloud SQL 夜間關閉排程設定"
echo " PROJECT_ID = ${PROJECT_ID}"
echo " INSTANCE   = ${INSTANCE}"
echo " SCHEDULE   = 每天 23:00 (${TIME_ZONE})，不會自動重開"
echo "=============================================="
echo

# -----------------------------------------------------------------------------
# 1. 啟用 Cloud Scheduler API（已啟用會直接略過，不算錯誤）
# -----------------------------------------------------------------------------
gcloud services enable cloudscheduler.googleapis.com --project="${PROJECT_ID}" \
  && echo "Cloud Scheduler API 已啟用"

# -----------------------------------------------------------------------------
# 2. 建立專用 service account（已存在會略過建立，不算錯誤）
#
#    只給它 roles/cloudsql.editor —— Cloud SQL 不支援 per-instance 的 IAM
#    binding（gcloud sql instances 沒有 add-iam-policy-binding 這個子指令），
#    所以這個角色是專案層級授權，會涵蓋這個專案底下所有 Cloud SQL instance，
#    不只 onagent-db。cloudsql.editor 比單純「開關機」需要的權限更廣（也含
#    databases.create/update 等），但這是 Google 預建角色裡最貼近的選項，
#    换取不用自己維護 custom role 的定義與更新。
# -----------------------------------------------------------------------------
gcloud iam service-accounts create "${SA_NAME}" \
  --project="${PROJECT_ID}" \
  --display-name="Cloud Scheduler: nightly Cloud SQL shutdown" \
  >/dev/null 2>&1 \
  && echo "已建立 service account：${SA_EMAIL}" \
  || echo "service account ${SA_EMAIL} 已存在，略過建立"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudsql.editor" \
  --condition=None \
  >/dev/null \
  && echo "已確認 ${SA_EMAIL} 具備 roles/cloudsql.editor"

# -----------------------------------------------------------------------------
# 3. 建立（或更新）Cloud Scheduler job
#
#    直接呼叫 Cloud SQL Admin API 的 instances.patch，把 activationPolicy
#    設成 NEVER（= 關機，Cloud SQL 這邊的說法不是 STOP 而是「永不自動啟
#    動」，效果等同關閉）。用 OAuth（不是 OIDC）—— gcloud scheduler 本身的
#    說明寫得很明確：目標是 *.googleapis.com 這類 Google API 時必須用
#    OAuth，OIDC 是給你自己架的 HTTP endpoint（例如 Cloud Run/Functions）
#    用的，兩者不能混用。
# -----------------------------------------------------------------------------
SQL_ADMIN_URL="https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT_ID}/instances/${INSTANCE}"
PATCH_BODY='{"settings":{"activationPolicy":"NEVER"}}'

if gcloud scheduler jobs describe "${JOB_NAME}" --project="${PROJECT_ID}" --location=asia-east1 >/dev/null 2>&1; then
  echo "scheduler job ${JOB_NAME} 已存在，這支腳本不會覆蓋既有排程設定 —— 如需調整時間，請自行執行 gcloud scheduler jobs update。"
else
  # Cloud Scheduler 的 --http-method 只接受 delete/get/head/post/put，沒有
  # patch —— Cloud SQL Admin API 的 instances.patch 端點本身認得 Google
  # API 慣用的 method-override 慣例：用 PUT 發送、外加
  # X-HTTP-Method-Override: PATCH 這個 header，效果等同真正的 PATCH（實測
  # 驗證過，回傳的是正常的 UPDATE operation，不是整個物件被 PUT 覆寫）。
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location=asia-east1 \
    --schedule="${SCHEDULE}" \
    --time-zone="${TIME_ZONE}" \
    --uri="${SQL_ADMIN_URL}" \
    --http-method=PUT \
    --message-body="${PATCH_BODY}" \
    --headers="Content-Type=application/json,X-HTTP-Method-Override=PATCH" \
    --oauth-service-account-email="${SA_EMAIL}" \
    --oauth-token-scope="https://www.googleapis.com/auth/sqlservice.admin"
  echo "已建立 scheduler job：${JOB_NAME}"
fi

echo
echo "=============================================="
echo " 完成。之後每天 23:00 (${TIME_ZONE}) 會自動關閉 ${INSTANCE}。"
echo " 隔天要用時，手動執行："
echo
echo "   gcloud sql instances patch ${INSTANCE} \\"
echo "     --project=${PROJECT_ID} --activation-policy=ALWAYS"
echo
echo " 也可以手動立即測試這個排程（不用等到 23:00）："
echo
echo "   gcloud scheduler jobs run ${JOB_NAME} --project=${PROJECT_ID} --location=asia-east1"
echo "=============================================="
