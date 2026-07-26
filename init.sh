#!/usr/bin/env bash
#
# 宿主机包装：在 octobus 容器内执行初始化（import/instance/capset/token）。
# 等价手动命令：
#   docker compose exec -e OCTOBUS_ADDR=http://127.0.0.1:9000 \
#     -e OCTOBUS_BI_CAPSET_TOKEN="$(grep OCTOBUS_BI_CAPSET_TOKEN .env|cut -d= -f2)" \
#     octobus bash /opt/octobus-init.sh
#
set -euo pipefail
cd "$(dirname "$0")"
docker compose exec \
  -e OCTOBUS_ADDR=http://127.0.0.1:9000 \
  -e OCTOBUS_BI_CAPSET_TOKEN="$(grep OCTOBUS_BI_CAPSET_TOKEN .env | cut -d= -f2)" \
  octobus bash /opt/octobus-init.sh

# 配置 agent-compose 的能力网关（capset 数据面）。容器重启后需重新播种，
# 因此放进 init 流程，确保 `docker compose up` 后开箱即用。
echo "== 配置 agent-compose 能力网关 =="
"$(dirname "$0")/configure-agent-compose.sh"
