#!/usr/bin/env bash
#
# 端到端验证编排（在宿主机执行）：
#   1) 等待 octobus 健康
#   2) 若业务识别 Service 尚未导入，则执行容器内初始化（import/instance/capset/token）
#   3) 经 OctoBus Connect RPC 跑通完整 8 步闭环（verify.mjs），断言 PASS
#
set -euo pipefail
cd "$(dirname "$0")"

OCTOBUS_BI_CAPSET_TOKEN="${OCTOBUS_BI_CAPSET_TOKEN:-bi-capset-demo-token-0001}"

echo "== [等待] octobus 健康检查 =="
ok=0
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9000/admin/v1/status >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "ERROR: octobus 未就绪，先执行 'docker compose up -d octobus'"
  exit 1
fi
echo "   octobus 就绪"

# 幂等初始化：仅当 service 尚不存在时执行
if docker compose exec -T -e OCTOBUS_ADDR=http://127.0.0.1:9000 octobus octobus service get business-identification >/dev/null 2>&1; then
  echo "== [跳过] service 已存在，无需初始化 =="
else
  echo "== [初始化] 导入 Service 并创建 instance/capset/token =="
  docker compose exec \
    -e OCTOBUS_ADDR=http://127.0.0.1:9000 \
    -e OCTOBUS_BI_CAPSET_TOKEN="$OCTOBUS_BI_CAPSET_TOKEN" \
    octobus bash /opt/octobus-init.sh
fi

echo "== [验证] 运行 8 步闭环（verify.mjs, 经 OctoBus Connect RPC）=="
OCTOBUS_ADDR=http://127.0.0.1:9000 \
CAPSET_ID=business-identification \
INSTANCE_ID=bi-prod \
OCTOBUS_BI_CAPSET_TOKEN="$OCTOBUS_BI_CAPSET_TOKEN" \
  node verify.mjs
