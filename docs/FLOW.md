# 业务识别闭环 — 完整流程

## 流程总览

```
┌─────────────────────────────────────────────────────────────────┐
│  准备阶段                                                        │
├─────────────────────────────────────────────────────────────────┤
│  docker compose up -d                                              │
│    → OctoBus(:9000) + agent-compose(:7410) + 前端(:8080)          │
│                                                                   │
│  Service 首次调用 → 自动灌入演示告警                                │
│    training: 最近24h  | testing: 独立验证集                         │
│    数据写入 bi-store.db → bind mount 到 ./data/                     │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Agent 训练阶段                                                   │
├─────────────────────────────────────────────────────────────────┤
│  触发方式:                                                        │
│    - 定时: agent-compose scheduler, cron "0 2 * * *"               │
│    - CLI:  agent-compose run business-identification-agent     │
│    - 前端: http://127.0.0.1:8080 → 选择 Agent → 输入 prompt      │
│                                                                   │
│  Agent 自主执行的流程:                                              │
│                                                                   │
│  ① DiscoverCandidates                                             │
│     → 从最近24h训练数据中发现可降噪模式                             │
│                                                                   │
│  ② ListCandidates                                                 │
│     → 筛选 CANDIDATE 状态的候选                                    │
│                                                                   │
│  ③ GetCandidateContext                                            │
│     → 获取每个候选的统计摘要和样本告警                              │
│                                                                   │
│  ④ LLM 分析 (DeepSeek V4 Flash)                                   │
│     → 理解业务含义 → 制定 must/veto 条件                           │
│     → 输出中文四段式报告:                                          │
│        降噪规则 | 规则解读 | 判定依据 | 建议                        │
│                                                                   │
│  ⑤ SaveCandidateAnalysis                                          │
│     → 提交规则，白名单校验通过才入库                                │
│     → 写入 candidate_analyses 表                                   │
│                                                                   │
│  ⑥ RunReplay                                                      │
│     → 独立验证集回放，系统否决 + must/veto 评估                    │
│     → 计算 Precision/Recall，写入 replay_results 表                │
│                                                                   │
│  Agent 权限边界:                                                   │
│    ✅ DiscoverCandidates, ListCandidates, GetCandidateContext,     │
│       SaveCandidateAnalysis, RunReplay                            │
│    ❌ ResetDemo, PublishPattern, MatchIncomingAlerts (归人工)      │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  人工审批阶段                                                     │
├─────────────────────────────────────────────────────────────────┤
│  人查看 Agent 分析报告 (WebUI) → 决定发布/驳回                     │
│                                                                   │
│  PublishPattern → 6项前置校验通过 → 写入 business_patterns         │
│  发布后宿主机 DB 立即可见: ./data/bi-store.db                       │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  效果验证阶段                                                     │
├─────────────────────────────────────────────────────────────────┤
│  MatchIncomingAlerts → 逐条检查告警                               │
│                                                                   │
│    第一步: 系统永久否决 (6条硬规则)                                │
│      命中 → KEEP_ALERT                                            │
│                                                                   │
│    第二步: 匹配 ACTIVE 规则 (must 全过 + veto 全不过)              │
│      匹配 → SUGGEST_SUPPRESS         不匹配 → KEEP_ALERT            │
│                                                                   │
│  不修改真实告警标签，仅输出建议。                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 数据流向

```
                      alerts
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
                    SUGGEST_SUPPRESS / KEEP_ALERT
```

## 查看方式

| 谁看 | 方式 |
|---|---|
| Agent 分析报告 | WebUI `http://127.0.0.1:3456` |
| DB 原始数据 | `./data/bi-store.db` → 任意 SQLite 工具 |
| Agent 运行日志 | `docker exec agent-compose ... logs --run <runId>` |

## 核心原则

**程序发现、Agent 解释、程序验证、人工发布、在线保守执行**
