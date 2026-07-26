# 业务识别闭环 — 无监督告警降噪系统

## 架构

```
Docker Compose Stack
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  OctoBus     │     │ agent-compose│     │ DeepSeek LLM │
│  (gRPC服务)   │←───→│ (Agent调度)  │←───→│ (在线分析)    │
│  :9000       │     │  :7410       │     │              │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
       ├── business-identification (service)
       └── bi-prod (instance)
              │
       ┌──────┴──────┐
       │  Web UI     │  :3456  人工审批台
       └─────────────┘
```

## 快速开始

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY 等

# 2. 启动全部服务
docker compose up -d

# 3. 初始化 OctoBus + agent-compose
docker exec octobus bash /opt/octobus-init.sh
bash configure-agent-compose.sh

# 4. 打开 WebUI
open http://127.0.0.1:3456
```

## 目录结构

```
deploy-octobus-agentcompose/
├── agent-compose.yml             # Agent 提示词 + 定时任务配置
├── business-identification-js/   # Service 源码 (OctoBus 插件)
│   ├── src/                      # 核心逻辑
│   │   ├── handlers.js           # 8 个 RPC 处理器
│   │   ├── store.js              # SQLite 持久层
│   │   ├── demo-data.js          # 演示数据生成
│   │   ├── candidate.js          # 候选发现算法
│   │   └── ...
│   ├── webui/                    # 人工审批台
│   │   ├── server.mjs            # Express 服务
│   │   └── public/               # 前端页面
│   ├── scripts/                  # 工具脚本
│   ├── proto/                    # gRPC 接口定义
│   └── test/                     # 测试与演示脚本
├── docker-compose.yml            # 容器编排
├── configure-agent-compose.sh    # agent-compose 网关配置
├── init.sh / init-octobus.sh     # 初始化脚本
├── verify.sh / verify.mjs        # 端到端验证
└── docs/                         # 文档
    ├── DEMO.md                   # 演示操作手册
    └── FLOW.md                   # 完整流程图
```

## 工作流程

1. **数据生成** — Service 启动时自动灌入训练告警 + 独立验证集
2. **Agent 训练** — 手动触发或定时执行，Agent 自主完成：
   - DiscoverCandidates → 发现可降噪模式
   - LLM 分析 → 生成业务解释和 must/veto 条件
   - RunReplay → 验证集上计算 Precision/Recall
3. **人工审批** — WebUI 查看报告，批准/驳回规则
4. **效果验证** — 全量告警匹配，降噪效果可视化

## 技术栈

| 组件 | 技术 |
|---|---|
| Service | Node.js + sql.js (SQLite) |
| Agent 调度 | agent-compose (Claude/Anthropic API) |
| LLM | DeepSeek V4 Flash |
| 前端 | Vanilla HTML/JS + Express.js |
| 数据存储 | SQLite (bind mount, 宿主机可读) |
| 容器化 | Docker Compose |

## 许可证

内部项目，演示用途。
