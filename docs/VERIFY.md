# 部署状态验证命令

SSH 登录后可通过以下命令核验运行状态。

## agent-compose

```bash
# 查看版本
docker exec agent-compose agent-compose --file /data/work/agent-compose.yml version

# 查看项目
docker exec agent-compose sh -c "agent-compose inspect project --file /data/work/agent-compose.yml"

# 查看定时任务触发器
docker exec agent-compose agent-compose --file /data/work/agent-compose.yml scheduler ls

# 查看 Agent 运行日志
docker exec agent-compose agent-compose --file /data/work/agent-compose.yml logs --run <run-id>
```

## OctoBus

```bash
# 查看状态
docker exec octobus octobus instance list

# 查看能力集
docker exec octobus octobus capset get business-identification

# 列出能力集中的方法
curl -s http://127.0.0.1:9000/admin/v1/instances | python3 -m json.tool | grep -A1 '"ListenAddr"'
```

## WebUI

```bash
# 业务识别审批台
http://127.0.0.1:3456

# agent-compose 管理前端
# http://127.0.0.1:8080
# 账号: admin / 密码: bi-demo-2026
```

## 演示流程（WebUI）

1. 打开 `http://127.0.0.1:3456` → 演示控制台
2. 设置告警数 → 点击"生成训练数据"
3. 点击"触发 Agent 研判"
4. 切换到"待审核规则" → 查看分析报告 → 批准或驳回
5. 切换到"效果验证" → 查看降噪效果
