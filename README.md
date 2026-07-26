# 业务识别告警降噪系统[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=for-the-badge&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/0zyt/homework)

## 项目概述

这是一个基于 Agent 循环工程（loop engineering）的 WAF/SIEM 告警降噪系统。核心思路是：利用 Agent + crontab 定时自主执行「发现→分析→回放→提交审核」的完整训练 pipeline，从海量告警中自动发现可被安全降噪的重复业务模式，由 LLM 生成业务解释和边界条件，在独立验证集上验证规则质量，经人工审批后发布执行。

## 系统架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   OctoBus    │     │agent-compose │     │  DeepSeek V4 │
│  (能力网关)   │←───→│ (Agent 平台)  │←───→│  (LLM 模型)   │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
  ┌────┴────┐
  │ Web UI  │  ← 人工审批台 + 演示控制台 (:3456)
  └─────────┘
```

**OctoBus** — 能力网关。托管业务识别 Service，管理 instance 生命周期（启动、端口分配、健康检查），通过能力集（capset）控制谁可以调用哪些方法，所有调用带 Bearer Token 鉴权。Agent 不直接访问后端接口，必须经过 OctoBus。

**agent-compose** — Agent 平台。管理 Agent 的沙箱运行环境，调度 LLM 任务，内置定时触发（cron）。Agent 发出的 gRPC 请求通过 capproxy 注入令牌后转发到 OctoBus。前端 `:8080` 提供 Agent 管理界面（账号密码登录）。

**Web UI** — 业务识别审批台 (`:3456`)。三个功能标签页：待审核规则（查看 Agent 分析报告，批准或驳回）、已发布规则、效果验证（执行降噪效果并查看统计）。另有演示控制台可手动生成训练数据和触发 Agent 研判。

**business-identification-js** — 核心引擎（OctoBus Service）。实现 8 个 RPC：ResetDemo、DiscoverCandidates、ListCandidates、GetCandidateContext、SaveCandidateAnalysis、RunReplay、PublishPattern、MatchIncomingAlerts。SQLite 持久化，`./data/bi-store.db` 宿主机可直接读取。

## 快速开始

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env：填入 ANTHROPIC_API_KEY、AUTH_PASSWORD 等

# 2. 启动全部服务
docker compose up -d

# 3. 初始化 OctoBus（导入服务、创建实例、配置能力集）
docker exec octobus bash /opt/octobus-init.sh

# 4. 配置 agent-compose 网关
bash configure-agent-compose.sh

# 5. 打开 WebUI → http://127.0.0.1:3456
```

**演示流程**：演示控制台 → 生成训练数据 → 触发 Agent 研判 → 待审核规则（审批）→ 效果验证。

## 目录结构

```
homework/
├── agent-compose.yml             # Agent 声明 + 系统提示词 + 定时任务
├── docker-compose.yml            # 容器编排
├── .env / .env.example           # 环境变量 / 模板
├── configure-agent-compose.sh    # agent-compose 网关配置
├── init.sh / init-octobus.sh     # 初始化脚本
├── verify.sh / verify.mjs        # 端到端验证
├── business-identification-js/   # Service 源码
│   ├── src/
│   │   ├── handlers.js           # 8 个 RPC 处理器
│   │   ├── store.js              # SQLite 持久层
│   │   ├── candidate.js          # 聚类与候选发现
│   │   ├── demo-data.js          # 演示数据生成（含验证集）
│   │   ├── normalizer.js         # 告警画像归一化
│   │   ├── analysis-validator.js # 字段白名单与操作符校验
│   │   ├── condition-evaluator.js# must/veto 条件评估
│   │   └── system-veto.js       # 6 条系统永久否决规则
│   ├── bin/ / proto/ / test/ / scripts/
│   └── package.json
├── webui/                        # Web 审批台
│   ├── server.mjs / Dockerfile
│   └── public/ (index.html, style.css)
├── docs/                         # 文档
│   ├── SECURITY-OPS.md           # 安全运营视角：判定链路详解
│   ├── FLOW.md                   # 完整流程图
│   └── VERIFY.md                 # 部署状态验证命令
│   ├── KNOWLEDGE.md              # 注入的领域知识说明
└── README.md                     # 本文件
```

## 设计说明

### 为什么选择 agent-compose

1. **LLM 调度器** — 管理 Agent 生命周期，支持定时触发（cron）。每个 Agent 运行在独立 Docker 沙箱中。
2. **gRPC 代理（capproxy）** — Agent 发出的 gRPC 请求通过 capproxy 注入能力集令牌后转发到 OctoBus。Agent 沙箱不需要知道 OctoBus 的地址或凭据，只需 `CAP_GRPC_TARGET` 和 `CAP_TOKEN` 两个环境变量。
3. **沙箱隔离** — Agent 的所有工具调用限定在 guest 容器内，不影响宿主。

### 为什么 Agent 不能绕过 OctoBus

- **认证统一**：Agent 不需要管理多套凭据，能力集令牌统一鉴权
- **审计完整**：OctoBus 记录所有调用——谁、何时、调了什么方法、参数是什么
- **权限可控**：能力集提供方法级权限控制，Agent 只能调用授权的方法
- **实例管理**：OctoBus 管理 instance 生命周期，Agent 无需感知

### LLM 与代码的职责划分

| 角色 | 负责 |
|---|---|
| **确定性代码** | 告警画像归一化、分组聚类、系统否决规则、条件评估、白名单校验 |
| **LLM（Agent）** | 业务含义理解、must/veto 条件制定、证据提取、中文报告生成 |

## 定时任务

`agent-compose.yml` 内置 scheduler，每天凌晨 2:00 自动触发：

```yaml
scheduler:
  enabled: true
  triggers:
    - name: daily-training
      cron: "0 2 * * *"
      prompt: "请执行完整的在线训练流程..."
```

## 安全与鉴权

| 组件 | 端口 | 防护方式 |
|---|---|---|
| agent-compose daemon | 7410 | `127.0.0.1` 绑定，仅本地可访问 |
| OctoBus | 9000 | `127.0.0.1` 绑定 + Bearer Token 鉴权 |
| agent-compose 前端 | 8080 | 公网可达，账号密码登录 |
| WebUI | 3456 | 公网可达 |

能力集令牌通过 `.env` 引用，不在 compose 文件中明文存储。

## 技术栈

| 组件 | 技术 |
|---|---|
| Service 运行时 | Node.js 22 |
| 数据存储 | sql.js (SQLite WASM) 1.12 |
| Agent 平台 | agent-compose v2607.10 |
| LLM | DeepSeek V4 Flash (Anthropic API) |
| WebUI 后端 | Express.js 4.21 |
| 容器化 | Docker Compose |
| Service 宿主 | OctoBus (commit 25badd7) |

## 文档索引

- [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md) — 注入的领域知识详解：每条判据的来源、失效场景、取舍理由
- [`docs/SECURITY-OPS.md`](docs/SECURITY-OPS.md) — 安全运营视角的完整判定链路
- [`docs/VERIFY.md`](docs/VERIFY.md) — 部署状态验证命令
- [`docs/FLOW.md`](docs/FLOW.md) — 完整流程图
