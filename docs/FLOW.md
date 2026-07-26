# 业务识别闭环 — 完整流程

## 流程总览

```
┌─────────────────────────────────────────────────────────────────┐
│  准备阶段                                                        │
├─────────────────────────────────────────────────────────────────┤
│  docker compose up -d                                              │
│    → OctoBus(:9000) + agent-compose(:7410) + 前端(:8080)          │
│                                                                   │
│  docker exec octobus ... service import business-identification    │
│    → 打包源码 → 安装依赖 → 编译proto → 启动 instance bi-prod       │
│                                                                   │
│  Service 首次调用 → 自动灌入 813 条演示告警                        │
│    training: 24h前~现在 (575条) | testing: 48h~24h前 (238条)       │
│    数据写入 bi-store.db → bind mount 到 ./data/ → 宿主机可读           │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Agent 训练阶段                                                   │
├─────────────────────────────────────────────────────────────────┤
│  触发方式:                                                        │
│    - CLI:  agent-compose run business-identification-agent     │
│    - 前端: http://127.0.0.1:8080 → 选择 Agent → 输入 prompt      │
│    - 定时: agent-compose.yml 配置 schedule cron 表达式            │
│                                                                   │
│  Agent 自主执行的 7 步:                                            │
│                                                                   │
│  ① DiscoverCandidates                                             │
│     → 默认最近24小时, EXACT_GROUP 算法                             │
│     → 575条扫描 → 10个分组 → 2个 CANDIDATE 候选                    │
│                                                                   │
│  ② ListCandidates                                                 │
│     → 筛选 status=CANDIDATE 的候选                                 │
│                                                                   │
│  ③ GetCandidateContext × 2                                        │
│     → 每个候选: 统计摘要 + 5条代表样本 + 边界/风险样本              │
│                                                                   │
│  ④ LLM 分析 × 2 (DeepSeek V4 Flash)                               │
│     → 理解业务含义 → 提取证据 → 制定 must/veto 条件                │
│     → 输出中文四段式报告:                                          │
│        降噪规则 | 规则解读 | 判定依据 | 建议                        │
│     → 主动发现: 候选1(2xx)和候选2(3xx)是同一业务 → 建议合并        │
│                                                                   │
│  ⑤ SaveCandidateAnalysis × 2                                      │
│     → 提交规则: MUST 6条 + VETO 3条                                │
│     → 白名单校验(字段+操作符)通过才入库                             │
│     → 写入 candidate_analyses 表                                   │
│                                                                   │
│  ⑥ RunReplay × 2                                                  │
│     → 独立测试窗口 238条验证 (与训练窗口不重叠)                     │
│     → 系统永久否决 16条 → 210 matched                              │
│     → Precision=1.00, Recall=0.876 (2xx) + 0.124 (3xx)           │
│     → 合并后 Recall=1.00                                           │
│     → 写入 replay_results 表                                       │
│                                                                   │
│  ⑦ 输出汇总报告                                                    │
│     | 候选ID | 业务名称 | 告警数 | Precision | Recall | 建议 |     │
│     | xxx    | xxx      | xxx    | 1.00      | 1.00   | 合并 |     │
│                                                                   │
│  Agent 权限边界:                                                   │
│    ✅ 可调用: DiscoverCandidates, ListCandidates,                   │
│              GetCandidateContext, SaveCandidateAnalysis, RunReplay │
│    ❌ 禁调用: ResetDemo, PublishPattern, MatchIncomingAlerts       │
│             (归人工操作)                                            │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  人工审批阶段                                                     │
├─────────────────────────────────────────────────────────────────┤
│  人查看 Agent 分析报告 (前端 UI 或 CLI logs) → 决定发布/驳回       │
│                                                                   │
│  PublishPattern(candidate_id, approved_by, comment)               │
│     ↓                                                             │
│  前置校验(6项):                                                   │
│    ① 候选存在  ② 分析存在且通过校验                               │
│    ③ 回放存在且 passed  ④ 未重复发布                              │
│    ⑤ approved_by 非空  ⑥ 系统否决条件未绕过                       │
│     ↓                                                             │
│  ✅ 通过 → 写入 business_patterns 表, status=ACTIVE               │
│  ❌ 驳回 → 返回原因, 不写入                                        │
│                                                                   │
│  发布后, 宿主机 DB 立即可见:                                       │
│    ./data/bi-store.db → business_patterns 表                       │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  效果验证阶段                                                     │
├─────────────────────────────────────────────────────────────────┤
│  MatchIncomingAlerts(tenant_id, time_window)                      │
│     ↓                                                             │
│  逐条处理 813 条全量告警:                                         │
│                                                                   │
│    第一步: 系统永久否决 (6条硬规则)                                │
│      is_confirmed_attack=true → KEEP_ALERT                        │
│      risk_level=HIGH           → KEEP_ALERT                       │
│      source_reputation=malicious → KEEP_ALERT                     │
│      has_path_traversal=true   → KEEP_ALERT                       │
│      has_dangerous_extension=true → KEEP_ALERT                    │
│      extraction_failed=true    → KEEP_ALERT                       │
│                                                                   │
│    第二步: 匹配 ACTIVE 规则 (must 条件全过 + veto 条件全不过)       │
│      匹配 → SUGGEST_SUPPRESS                                      │
│      不匹配 → KEEP_ALERT                                           │
│                                                                   │
│  结果:                                                            │
│    813 条扫描                                                     │
│    ├── 730 条 SUGGEST_SUPPRESS (89.8%)                            │
│    │   └── 全部来自 GET /api/orders/{num}/payment-status          │
│    └── 83 条 KEEP_ALERT                                           │
│        ├── 37 条 无匹配模式 (POST方法/不同URL)                     │
│        ├── 35 条 risk_level=HIGH                                   │
│        ├── 16 条 has_path_traversal=true                           │
│        ├──  7 条 is_confirmed_attack=true                          │
│        ├──  7 条 source_reputation=malicious                       │
│        ├──  6 条 has_dangerous_extension=true                      │
│        └──  4 条 extraction_failed=true                             │
│                                                                   │
│  写入 match_results 表 (每条告警的决策和原因)                      │
└─────────────────────────────────────────────────────────────────┘
```

## 数据流向

```
                      alerts (813条)
                           │
                    DiscoverCandidates
                           │
                    pattern_candidates
                           │
                    Agent 分析 → candidate_analyses
                           │
                    RunReplay → replay_results
                           │
                    人工审批 → PublishPattern
                           │
                    business_patterns (ACTIVE)
                           │
                    MatchIncomingAlerts
                           │
                    match_results
```

## 所有可查看的端点

| 谁看 | 方式 |
|---|---|
| Agent 分析报告 | 前端 UI `http://127.0.0.1:8080` 或 `agent-compose logs` |
| DB 原始数据 | `./data/bi-store.db` → DB Browser for SQLite |
| gRPC API | `curl` 调 `:9000/capsets/business-identification/connect/bi-prod/...` |

## 9 张表说明

| 表 | 写入者 | 内容 |
|---|---|---|
| `alerts` | Service 自动加载 | 813 条原始告警 |
| `meta` | Service | 窗口边界、样本ID |
| `pattern_candidates` | DiscoverCandidates | 发现的候选分组 |
| `discovery_runs` | DiscoverCandidates | 每次发现的运行记录 |
| `candidate_analyses` | Agent (SaveCandidateAnalysis) | 业务名、must/veto条件、置信度 |
| `replay_results` | Agent (RunReplay) | precision/recall/pass |
| `business_patterns` | 人工 (PublishPattern) | 已发布的降噪规则 |
| `match_results` | 人工 (MatchIncomingAlerts) | 每条告警的匹配决策 |
| `seq` | Service | ID 计数器 |

## 核心原则

**程序发现、Agent 解释、程序验证、人工发布、在线保守执行**

  ┌─────────────────────────────────────────────────────────────────┐
  │  准备阶段 (一次性的)                                              │
  ├─────────────────────────────────────────────────────────────────┤
  │  1. docker compose up -d                  启动 OctoBus + Agent   │
  │  2. docker exec octobus ... service import  导入 Service         │
  │  3. Service 启动 → 自动灌入 813 条演示告警                        │
  │     (training: 24h前~现在 / testing: 48h~24h前 / live: 空)      │
  │     数据写入 bi-store.db，挂载到宿主机 ./data/ 可直接查看          │
  └─────────────────────────────────────────────────────────────────┘
                            ↓
  ┌─────────────────────────────────────────────────────────────────┐
  │  Agent 训练阶段 (手动触发 / 定时触发)                              │
  ├─────────────────────────────────────────────────────────────────┤
  │  触发: agent-compose run business-identification-agent            │
  │         --prompt "请执行在线训练..."                               │
  │                                                                  │
  │  Agent 自主执行:                                                  │
  │  ┌───────────────────────────────────────────────────────────┐  │
  │  │ ① DiscoverCandidates(最近24h)                             │  │
  │  │    → 575条扫描, 10个分组, 2个CANDIDATE候选                  │  │
  │  │                                                            │  │
  │  │ ② ListCandidates                                          │  │
  │  │    → 筛选 CANDIDATE 状态的候选                              │  │
  │  │                                                            │  │
  │  │ ③ GetCandidateContext × 2                                 │  │
  │  │    → 每个候选: 统计摘要 + 5条代表样本 + 边界/风险样本        │  │
  │  │                                                            │  │
  │  │ ④ LLM 分析 × 2                                            │  │
  │  │    → 理解业务含义、提取证据、制定 must/veto 条件             │  │
  │  │    → 输出中文四段式报告(规则/解读/依据/建议)                  │  │
  │  │                                                            │  │
  │  │ ⑤ SaveCandidateAnalysis × 2                               │  │
  │  │    → 提交规则(MUST 6条 + VETO 3条)                          │  │
  │  │    → 白名单校验(字段+操作符)通过才入库 → candidate_analyses  │  │
  │  │                                                            │  │
  │  │ ⑥ RunReplay × 2                                           │  │
  │  │    → 独立测试窗口 238条验证                                  │  │
  │  │    → 系统否决 16条 → 210 matched → Precision 1.0           │  │
  │  │    → 结果写入 replay_results                               │  │
  │  │                                                            │  │
  │  │ ⑦ 输出汇总报告 + 建议                                       │  │
  │  │    → "建议合并为一条规则发布, Precision=1.00 Recall=1.00"    │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  Agent 不能做的事: ResetDemo, PublishPattern, MatchIncomingAlerts │
  └─────────────────────────────────────────────────────────────────┘
                            ↓
  ┌─────────────────────────────────────────────────────────────────┐
  │  人工审批阶段                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  │  人查看 Agent 分析报告 → 决定:                                    │
  │                                                                  │
  │  PublishPattern(candidate_id, approved_by, comment)              │
  │      ↓                                                           │
  │  前置校验(6项): 候选存在 + 分析存在且通过 + 回放存在且passed       │
  │               + 未重复发布 + approved_by 非空                     │
  │      ↓                                                           │
  │  通过 → 写入 business_patterns (ACTIVE)                          │
  │  拒绝 → 返回原因                                                  │
  │                                                                  │
  │  发布后宿主机 DB 立即可见:                                        │
  │    ./data/bi-store.db → business_patterns 表                     │
  └─────────────────────────────────────────────────────────────────┘
                            ↓
  ┌─────────────────────────────────────────────────────────────────┐
  │  效果验证阶段                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  │  MatchIncomingAlerts(tenant_id, time_window)                     │
  │      ↓                                                           │
  │  逐条检查 813 条告警:                                             │
  │    系统否决(6条硬规则) → 命中 → KEEP_ALERT                        │
  │    → must 条件全过 + veto 条件全不过 → SUGGEST_SUPPRESS           │
  │    → 否则 → KEEP_ALERT                                           │
  │      ↓                                                           │
  │  结果: 730 降噪 / 83 保留 / 降噪率 89.8% / 零误降噪               │
  └─────────────────────────────────────────────────────────────────┘
