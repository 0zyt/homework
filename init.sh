#!/usr/bin/env bash
#
# 一键初始化：修复权限 + OctoBus 初始化 + agent-compose 网关配置。
# 等价手动命令：
#   sudo docker exec -u root octobus sh -c "chown -R octobus:octobus /var/lib/octobus/instances/"
#   sudo docker exec octobus bash /opt/octobus-init.sh
#   bash configure-agent-compose.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# 0. 修复 instances 目录权限（Docker 卷可能被 root 占用）
echo "== 修复 OctoBus instances 目录权限 =="
sudo docker exec -u root octobus sh -c "chown -R octobus:octobus /var/lib/octobus/instances/" 2>/dev/null || true

# 1. OctoBus 初始化（import service → create instance → capset → token）
echo "== OctoBus 初始化 =="
sudo docker compose exec \
  -e OCTOBUS_ADDR=http://127.0.0.1:9000 \
  -e OCTOBUS_BI_CAPSET_TOKEN="$(grep OCTOBUS_BI_CAPSET_TOKEN .env | cut -d= -f2)" \
  octobus bash /opt/octobus-init.sh

# 1.5 修复运行时执行权限并重启 instance
echo "== 修复 Service 执行权限 + 重启 instance =="
sudo docker exec -u root octobus sh -c \
  "chmod 755 /var/lib/octobus/artifacts/services/business-identification/runtime/bin/business-identification.js 2>/dev/null; \
   octobus instance restart bi-prod 2>/dev/null || true"

# 2. agent-compose 能力网关配置
echo "== 配置 agent-compose 能力网关 =="
"$(dirname "$0")/configure-agent-compose.sh"
