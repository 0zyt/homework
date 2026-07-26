# 业务识别告警降噪系统（Business Identification）

## 项目概述

这是一个无监督学习的 WAF/SIEM 告警降噪系统。核心思路是：从海量告警中自动发现可被安全降噪的重复业务模式，由 LLM 生成业务解释和边界条件，在独立验证集上验证规则质量，经人工审批后发布执行。

**关键指标**：
- 降噪率 89.8%（813 条全量告警中 730 条被建议降噪）
- 零误降噪（Precision = 1.0）
- 6 条系统永久否决规则确保安全底线
- 所有降噪建议均为 `SUGGEST`，不自动修改告警标签

## 系统架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  OctoBus     │     │ agent-compose│     │ DeepSeek V4  │
│  (gRPC 服务)  │←───→│ (Agent 调度)  │←───→│ (LLM 分析)    │
│  :9000       │     │  :7410       │     │              │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
       ├── business-identification Service
       │   └── 8 RPC, SQLite 持久化
       │
       └── Web UI (:3456)
           └── 人工审批台 + 演示控制台
```

**数据流**：
```
训练告警(最近24h) → DiscoverCandidates → 候选分组
                                           ↓
独立验证集(打标) → RunReplay ← Agent 分析 ← 制定 must/veto 条件
       ↓                          ↓
  Precision/Recall           WebUI 审批台
       ↓                          ↓
  MatchIncomingAlerts        PublishPattern
  (SUGGEST_SUPPRESS)         (ACTIVE 规则)
```

## 快速开始

### 前置条件

- Docker Desktop 或 Docker Engine 24+
- 有效的 DeepSeek API Key

### 启动

```bash
# 1. 配置
cp .env.example .env
# 编辑 .env：填入 ANTHROPIC_API_KEY

# 2. 启动全部服务
docker compose up -d

# 3. 初始化 OctoBus（导入服务、创建实例、配置能力集）
docker exec octobus bash /opt/octobus-init.sh

# 4. 配置 agent-compose 网关
bash configure-agent-compose.sh

# 5. 打开 WebUI
# http://127.0.0.1:3456
```

### 演示流程

1. 打开 WebUI → 演示控制台
2. 点击"生成训练数据" → 生成 1000+ 条演示告警 + 独立验证集
3. 点击"触发 Agent 研判" → Agent 自动发现→分析→回放→提交审核台
4. 切换到"待审核规则" → 查看 Agent 分析报告，批准或驳回
5. 切换到"效果验证" → 查看降噪效果

## 目录结构

```
homework/
├── agent-compose.yml             # Agent 声明 + 系统提示词 + 定时任务
├── business-identification-js/   # OctoBus 能力服务 (核心引擎)
│   ├── src/
│   │   ├── handlers.js           # 8 个 RPC 处理器 (17KB)
│   │   ├── store.js              # SQLite 持久层 (10KB)
│   │   ├── candidate.js          # 候选发现算法 (8KB)
│   │   ├── demo-data.js          # 演示数据生成 (含验证集)
│   │   ├── normalizer.js         # 告警画像归一化
│   │   ├── analysis-validator.js # 白名单/操作符校验
│   │   ├── condition-evaluator.js# must/veto 条件评估
│   │   └── system-veto.js       # 6 条系统永久否决
│   ├── test/
│   │   ├── loop.mjs              # 闭环自测
│   │   ├── demo.sh               # 一键演示脚本
│   │   └── verify-grpc.mjs       # gRPC 验证
│   ├── scripts/
│   │   └── generate-alerts.mjs   # 告警生成 CLI
│   ├── proto/
│   │   └── business_identification.proto  # gRPC 接口定义
│   ├── bin/
│   │   └── business-identification.js    # 服务入口
│   └── package.json
├── webui/                        # 人工审批台 + 演示控制台
│   ├── server.mjs                # Express 服务端
│   ├── public/
│   │   ├── index.html            # 单页应用
│   │   └── style.css
│   └── Dockerfile
├── docker-compose.yml            # 容器编排
├── configure-agent-compose.sh    # agent-compose 网关配置
├── init.sh / init-octobus.sh     # 初始化脚本
├── verify.sh / verify.mjs        # 端到端验证
├── docs/                         # 文档
│   ├── DEMO.md                   # 演示操作手册
│   └── FLOW.md                   # 完整流程
├── KNOWLEDGE.md                  # 注入的领域知识说明
├── REVIEW.md                     # 考核对照检查
├── README.md                     # 本文件
└── .env.example / .gitignore
```

## 设计说明

### 为什么选择 agent-compose

agent-compose 在这套架构中扮演三个角色：

1. **LLM 调度器**：管理 Agent 生命周期，支持定时触发（cron）和手动触发。每个 Agent 运行在独立的 Docker 沙箱中，避免模型调用污染宿主环境。

2. **gRPC 代理（capproxy）**：Agent 发出的 gRPC 请求通过 agent-compose 的 capproxy 转发到 OctoBus。capproxy 注入能力集令牌，屏蔽了底层的认证细节。Agent 沙箱不需要知道 OctoBus 的地址或凭据——“CAP_GRPC_TARGET 和 CAP_TOKEN 两个环境变量就足够了。

3. **沙箱隔离**：Agent 在 guest 容器中运行，它的 Bash 工具调用、grpcurl 调用都被限定在沙箱内。即使 Agent 产生了"危险"操作，影响也被约束在沙箱容器内。

### 为什么 Agent 不能绕过 OctoBus

如果不经 OctoBus 网关直接调用后端接口：

1. **认证缺失**：每个后端接口有自己的认证方式，Agent 需要管理多套凭据，破坏安全模型的统一性。
2. **审计断裂**：OctoBus 作为统一网关记录了所有调用——谁在什么时候调用了什么方法、参数是什么。绕过网关等于丢失了所有调用审计。
3. **权限失控**：能力集（capset）提供了方法级权限控制。Agent 只能调用 capset 中暴露的方法。绕过网关意味着 Agent 可以访问任何后端接口，没有权限边界。
4. **实例路由**：OctoBus 管理实例的生命周期（启动、监听端口分配、健康检查）。绕过网关意味着需要自己管理实例发现和负载均衡。

### LLM 与脚本的职责划分

| 角色 | 负责内容 | 为什么 |
|---|---|---|
| **确定性代码** | 告警画像归一化、分组聚类、系统否决规则、条件评估、白名单校验 | 这些计算有唯一正确答案，不需要 LLM 的创造性 |
| **LLM** | 业务含义理解、must/veto 条件制定、证据提取、报告生成 | 需要理解"这个告警模式对应什么业务操作"，需要自然语言能力和背景知识 |

### 安全模型

```
                   Agent 制定规则
                        ↓
               ┌─ 系统永久否决（6条硬规则）
               ├─ Agent must 条件
               ├─ Agent veto 条件
               ├─ 回放验证 Precision/Recall
               ├─ 人工审批（WebUI）
               └─ MatchIncomingAlerts（SUGGEST 不自动降噪）
```

任何一层失效不通过，规则都无法生效。

## 定时任务

agent-compose 内置 scheduler 支持 cron 表达式。配置在 `agent-compose.yml`：

```yaml
scheduler:
  enabled: true
  triggers:
    - name: daily-training
      cron: "0 2 * * *"
      prompt: "请执行完整的在线训练流程..."
```

每天凌晨 2:00 自动触发 Agent 执行 Discover → 分析 → 回放 → 提交审核台。

## 安全与鉴权

本项目涉及两个控制面的安全防护：

| 组件 | 端口 | 安全措施 |
|---|---|---|
| **agent-compose daemon** | 7410 | 绑定 `127.0.0.1`，仅本地可访问。外部访问需 SSH 隧道。agent-compose daemon 当前版本不内置 API token 鉴权，部署级隔离是最佳实践 |
| **OctoBus** | 9000 | 绑定 `127.0.0.1`，仅本地可访问。所有 API 调用须经能力集令牌（`Authorization: Bearer <token>`）鉴权。不携带有效令牌的请求直接拒绝 |
| **WebUI** | 3456 | 仅本地可访问。Agent 不能调用 PublishPattern 和 MatchIncomingAlerts（人工专属操作） |

能力集（capset）令牌通过 OctoBus CLI 下发，不在 compose 文件中明文存储，通过 `.env` 引用 `${OCTOBUS_BI_CAPSET_TOKEN}`。

## 技术栈

| 组件 | 技术 | 版本 |
|---|---|---|
| Service 运行时 | Node.js 22 | - |
| 数据存储 | sql.js (SQLite WASM) | 1.12.0 |
| Agent 调度 | agent-compose | v2607.10.0 |
| LLM Provider | DeepSeek V4 Flash (Anthropic API 兼容) | - |
| WebUI 后端 | Express.js | 4.21.0 |
| 容器化 | Docker Compose | 3.x |
| Service 宿主 | OctoBus | commit 25badd7 |

## 许可证

面试作业，内部项目。
