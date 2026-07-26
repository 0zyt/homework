#!/bin/sh
# Daily online training trigger for business-identification agent.
# Run this via cron or systemd timer every 24 hours.
#
# Cron example (runs at 2:00 AM daily):
#   0 2 * * * /opt/deploy-octobus-agentcompose/scripts/daily-training.sh >> /var/log/bi-training.log 2>&1
#
# Manual: sh scripts/daily-training.sh

docker exec agent-compose sh -c "
  agent-compose run business-identification-agent \
    --file /data/work/agent-compose.yml \
    -d \
    --prompt '请执行完整的在线训练流程：发现候选 -> 分析 -> 保存(含report_json) -> 回放验证。'
" 2>&1
