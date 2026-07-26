#!/usr/bin/env bash
#
# OctoBus 初始化脚本（在 octobus 容器内执行）。
# 作用：导入业务识别 Service -> 创建实例 -> 创建能力集(capset) -> 关联实例 -> 下发访问令牌。
# 幂等：已存在则跳过对应步骤。
#
# 运行方式（在宿主机 deploy-octobus-agentcompose 目录）：
#   docker compose exec -e OCTOBUS_BI_CAPSET_TOKEN="$OCTOBUS_BI_CAPSET_TOKEN" octobus bash /opt/octobus-init.sh
# 或：docker compose run --rm --entrypoint bash octobus -c "source /opt/octobus-init.env && bash /opt/octobus-init.sh"
#
set -euo pipefail

# octobus CLI 需要 http:// 前缀的 admin 地址；守护进程自己的监听地址不带前缀。
export OCTOBUS_ADDR="${OCTOBUS_ADDR:-http://127.0.0.1:9000}"

# 读取演示变量（capset token 等）。宿主机已通过 .env 挂载到容器内此路径。
if [ -f /opt/octobus-init.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /opt/octobus-init.env
  set +a
fi

SERVICE_ID="business-identification"
SERVICE_DIR="/opt/services/business-identification"
INSTANCE_ID="bi-prod"
CAPSET_ID="business-identification"
TOKEN_ID="bi-mcp-token"
CAPSET_TOKEN="${OCTOBUS_BI_CAPSET_TOKEN:-bi-capset-demo-token-0001}"

oc() { octobus "$@"; }
log() { echo "[init-octobus] $*"; }

# ---------- 1. 导入 Service ----------
if oc service get "$SERVICE_ID" >/dev/null 2>&1; then
  log "service '$SERVICE_ID' 已存在，跳过导入"
else
  log "导入 service '$SERVICE_ID' from $SERVICE_DIR ..."
  oc service import "$SERVICE_ID" "$SERVICE_DIR" --name "Business Identification"
fi

# ---------- 2. 创建实例 ----------
if oc instance get "$INSTANCE_ID" >/dev/null 2>&1; then
  log "instance '$INSTANCE_ID' 已存在，跳过创建"
else
  log "创建 instance '$INSTANCE_ID' (service=$SERVICE_ID) ..."
  oc instance create "$INSTANCE_ID" --service "$SERVICE_ID" --name "BI Prod"
fi

# ---------- 3. 创建 capset ----------
if oc capset get "$CAPSET_ID" >/dev/null 2>&1; then
  log "capset '$CAPSET_ID' 已存在，跳过创建"
else
  log "创建 capset '$CAPSET_ID' ..."
  oc capset create "$CAPSET_ID" --name "Business Identification" --description "业务识别确定性引擎（候选发现/分析/回放/发布/匹配）"
fi

# ---------- 4. 关联实例到 capset（默认全量方法）----------
if oc capset list-instances "$CAPSET_ID" 2>/dev/null | grep -q "\"$INSTANCE_ID\""; then
  log "instance '$INSTANCE_ID' 已在 capset 中，跳过"
else
  log "关联 instance '$INSTANCE_ID' -> capset '$CAPSET_ID' ..."
  oc capset add-instance "$CAPSET_ID" "$INSTANCE_ID"
fi

# ---------- 5. 下发 capset 访问令牌（MCP 端点鉴权）----------
if oc capset list-tokens "$CAPSET_ID" 2>/dev/null | grep -q "\"$TOKEN_ID\""; then
  log "capset token '$TOKEN_ID' 已存在，跳过"
else
  log "下发 capset token '$TOKEN_ID' ..."
  oc capset add-token "$CAPSET_ID" "$TOKEN_ID" --token "$CAPSET_TOKEN"
fi

# ---------- 6. 等待实例进入 running ----------
log "等待 instance '$INSTANCE_ID' 进入 running（npm install 可能耗时数十秒）..."
for i in $(seq 1 60); do
  status=$(oc instance get "$INSTANCE_ID" 2>/dev/null | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/')
  if [ "$status" = "running" ]; then
    log "instance '$INSTANCE_ID' 状态: running"
    break
  fi
  if [ "$i" -eq 60 ]; then
    log "WARNING: 实例未在预期时间内 running（当前: ${status:-unknown}）。可用 'docker compose logs octobus' 排查。"
  fi
  sleep 3
done

echo
log "初始化完成。"
log "MCP 端点: ${OCTOBUS_ADDR%*/}/capsets/${CAPSET_ID}/mcp"
log "Connect 端点示例: ${OCTOBUS_ADDR%*/}/capsets/${CAPSET_ID}/connect/${INSTANCE_ID}/businessidentification.v1.BusinessIdentificationService/ResetDemo"
log "MCP 鉴权: Authorization: Bearer ${CAPSET_TOKEN}"
