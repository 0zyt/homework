#!/usr/bin/env bash
#
# 配置 agent-compose 的 OctoBus 能力网关（控制面），使 capset_ids 原生数据面生效。
# 网关地址使用 agent-compose 视角的 http://octobus:9000（容器间 DNS）。
# 配置持久化于 agent-compose 数据卷，重启后依然有效。
#
set -euo pipefail
cd "$(dirname "$0")"
AC="${AGENT_COMPOSE_ADDR:-http://127.0.0.1:7410}"
OCTO_ADDR="${OCTOBUS_ADDR_FOR_AGENT:-http://octobus:9000}"
# capproxy 转发到 OctoBus 时需携带 capset token 完成鉴权（详见 octobus_integration.md）。
OCTO_CAPSET_TOKEN="${OCTOBUS_BI_CAPSET_TOKEN:-bi-capset-demo-token-0001}"

echo "== 配置能力网关 -> $OCTO_ADDR (capset token=$OCTO_CAPSET_TOKEN) =="
curl -fsS -X POST "$AC/agentcompose.v2.SettingsService/UpdateCapabilityGatewayConfig" \
  -H "Content-Type: application/json" -d "{\"addr\":\"$OCTO_ADDR\",\"token\":\"$OCTO_CAPSET_TOKEN\"}"
echo
echo "== 列出能力集 =="
curl -fsS -X POST "$AC/agentcompose.v2.CapabilityService/ListCapabilitySets" \
  -H "Content-Type: application/json" -d '{}'
echo
echo "== 能力状态 =="
curl -fsS -X POST "$AC/agentcompose.v2.CapabilityService/GetCapabilityStatus" \
  -H "Content-Type: application/json" -d '{}'
echo
