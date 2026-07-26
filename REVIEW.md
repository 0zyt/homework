# 面试考核对照检查清单

## 一、交付物

| 要求 | 状态 | 说明 |
|---|---|---|
| ① GitHub 公开仓库 | ✅ | 已有 |
| README.md（部署说明+设计说明+问题记录） | ⚠️ | 已有基础版本，缺少：设计说明、实施问题及处理方式、Agent 知识依据说明 |
| Agent 源代码与配置 | ✅ | business-identification-js + agent-compose.yml + docker-compose.yml |
| Agent 所用的知识与规则文件 | ❌ | **缺失**。需要单独文档说明注入的 6 条系统否决规则、21 字段白名单、7 操作符限制的来源和依据 |
| 仓库不含明文密钥 | ✅ | .env 已 gitignored |
| ② 运行环境（云端+SSH） | ❌ | 当前在本地 Windows Docker Desktop，需迁移至公有云 Ubuntu |
| 考官公钥写入 | ❌ | 待服务器就绪后操作 |
| README 注明登录信息 | ❌ | 同上 |
| ③ 面试讨论准备 | ⚠️ | 需提前准备三个主题的讲稿 |

## 二、环境与部署

| 要求 | 状态 | 说明 |
|---|---|---|
| 3.1 云端服务器 Ubuntu 22.04+ | ❌ | 本地 Windows，需迁移 |
| Docker + docker compose | ⚠️ | 本地已有，云端需安装 |
| 3.2 agent-compose 常驻+自动恢复 | ✅ | docker-compose restart: unless-stopped |
| CLI 可查版本与项目列表 | ✅ | `agent-compose agent ls` 等 |
| 至少 1 个自建项目 | ✅ | business-identification |
| 定时或事件触发 | ✅ | scheduler cron "0 2 * * *" |
| 模型凭据已配置 | ✅ | ANTHROPIC_API_KEY + DeepSeek |
| 控制面不对公网开放 | ✅ | 127.0.0.1:7410 绑定 |
| 3.3 OctoBus 常驻 | ✅ | docker-compose restart: unless-stopped |
| service→instance→capset 三层链路 | ✅ | init-octobus.sh 完整实现 |
| 显式选择暴露的方法 | ⚠️ | 当前是所有方法，需确认符合"显式选择"要求 |
| Agent 经 OctoBus 调用 | ✅ | Connect RPC 经 port 9000 |
| 审计日志 | ⚠️ | agent-compose 有运行日志，需确认格式满足"调用审计" |
| 不对公网开放 | ✅ | 127.0.0.1:9000 |
| 3.4 重启后自动恢复 | ⚠️ | 需在云端实际验证 |
| 考官可 SSH 登录 | ❌ | 待部署 |

## 三、Agent 设计要求

| 要求 | 状态 | 说明 |
|---|---|---|
| 5.1 业务闭环完整 | ✅ | 触发→取数→判定→产出→留痕 |
| LLM 与脚本分工合理 | ✅ | 数据生成/统计/校验=代码, 业务理解/条件制定=LLM |
| 至少一处经 OctoBus 调用 | ✅ | 5 个 RPC 全经 OctoBus |
| 结论有证据支撑 | ✅ | report_json 含 statistics，回放验证结果可查 |
| 5.2 知识实质性 | ⚠️ | **此为评定重点，需重点补强** |

## 四、知识实质性详细分析（重点）

当前注入的知识：

### 已具备的部分

| 知识 | 实质程度 | 说明 |
|---|---|---|
| 6 条系统永久否决规则 | 中 | is_confirmed_attack, risk_level=HIGH 等，属于 WAF 通用规则，但阈值选择（哪些字段必须否决）需说明依据 |
| 8 字段精确分组策略 | 高 | tenant+rule+service+protocol+method+urlPattern+bodyType+statusClass 的组合来自真实安全运营经验——不同 status_class 的告警是不同业务语义 |
| 21 字段白名单 + 7 操作符限制 | 高 | 限定 Agent 只能使用安全可解释的字段，防止 LLM 编造不存在的字段 |
| 训练/验证分离设计 | 高 | 防止数据泄漏，Precision 虚高的实际教训 |
| 系统否决优先于 Agent 条件 | 高 | 安全底线不可绕过，来自安全运营真实约束 |

### 缺失的部分

| 知识 | 需要补充 |
|---|---|
| 判据的来源与实践依据 | 需说明每条否决规则的来源（历史工单统计/安全策略规范/误报分析），而非仅说"这是规则" |
| 失效与误判经验 | 需说明什么情况下系统会产生误降噪（例如 Agent 选了过于宽松的 must 条件）、什么情况下会漏报 |
| 非显然的取舍 | 需解释为什么 Precision=100% 优先级高于 Recall，为什么宁可漏过不降噪也绝不误降噪 |
| 知识文件 | 需要一个独立的 `KNOWLEDGE.md` 文档，结构化列出所有注入的领域知识及其实践依据 |

## 五、行动清单

### 高优先级（必须做）

1. **迁移到云端 Ubuntu**
2. **编写 KNOWLEDGE.md** — 结构化注入知识，逐一说明判据来源、失效场景、取舍理由
3. **补充 README.md** — 加入设计说明、架构图、实施问题及处理方式
4. **部署验证** — 服务器重启后自动恢复测试
5. **SSH 配置** — 考官公钥、登录信息
6. **准备面试讲稿** — 三个主题的讲解材料

### 中优先级（建议做）

7. 确认 capset 的"显式选择方法"要求是否满足
8. 准备调用审计日志样例
9. 云端运行一轮，保留日志

### 低优先级（锦上添花）

10. 补充 agent-compose 版本号和 OctoBus 版本号信息
11. UI 展示效果录屏
