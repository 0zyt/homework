# 业务识别闭环 - 演示操作手册

## 架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  OctoBus     │     │ agent-compose│     │ DeepSeek LLM │
│  (gRPC服务)   │←───→│ (Agent调度)  │←───→│ (在线分析)    │
│  :9000       │     │  :7410       │     │              │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
       ├── business-identification (service)
       └── bi-prod (instance, 自动监听端口)
```

**时间**: 2026-07-25
**数据**: 813 条模拟告警 (正常业务 + 边界样本 + 风险样本)
**Agent**: DeepSeek V4 Flash

---

## 演示流程总览

```
  [自动] 数据预加载 (813条) 
     ↓
  [人工] 触发 Agent 训练
     ↓
  [Agent] Discover -> Analyze -> Replay -> 中文分析报告
     ↓
  [人工] 审批发布
     ↓
  [验证] 降噪效果验证
```

---

## 第一步：启动环境

```bash
cd d:/projs/ct_homework/deploy-octobus-agentcompose
docker compose up -d
```

启动后：
- OctoBus 在 `127.0.0.1:9000`
- agent-compose 在 `127.0.0.1:7410`

---

## 第二步：导入 Service

```bash
docker exec octobus sh -c "octobus service import business-identification /opt/services/business-identification"
```

OctoBus 自动执行：npm pack -> npm install -> 编译 proto -> 创建 instance -> 启动

---

## 第三步：配置 Agent 提示词

Agent 的行为由 `agent-compose.yml` 中的 `system_prompt` 控制。提示词要求 Agent 输出结构化中文报告，每个候选包含四段：

```
### 候选规则：[一句话业务名称]

**降噪规则：**
  必须条件 (MUST)：[逐条列出]
  否决条件 (VETO)：[逐条列出]

**规则解读：**
  [捕获什么：具体描述被降噪的告警长什么样、对应的真实业务操作]
  [区分什么：为什么边界样本不会被误降噪]
  [放过什么：哪些维度变化不影响匹配，体现泛化能力]
  [候选间关系：如果有配对候选，说明组合逻辑]

**判定依据：**
  [数据基础：告警数、天数、来源IP数、网段分布]
  [稳定性：连续天数、告警量波动、成功率趋势]
  [安全性：确认攻击/恶意来源/提取失败等均为0则说明安全]
  [每条must条件覆盖率及选择理由]
  [每条veto条件的必要性分析]

**建议：** [发布 / 不发布 / 合并后发布]
```

完整配置见 `agent-compose.yml`。

---

## 第四步：触发 Agent 在线训练

```bash
docker exec agent-compose sh -c "
  agent-compose up --file /data/work/agent-compose.yml &&
  agent-compose run business-identification-agent \
    --file /data/work/agent-compose.yml \
    -d \
    --prompt '请执行在线训练流程：发现候选 -> 分析 -> 回放验证 -> 输出中文分析报告。数据窗口：最近24小时。'
"
```

查看日志：

```bash
docker exec agent-compose sh -c "agent-compose --file /data/work/agent-compose.yml logs --run <run-id>"
```

Agent 自主执行的操作：

| 步骤 | RPC | 操作 |
|---|---|---|
| 1 | DiscoverCandidates | 从最近 24 小时训练数据发现可降噪模式 |
| 2 | ListCandidates | 筛选 status=CANDIDATE 的候选 |
| 3 | GetCandidateContext | 获取摘要 + 样本告警 |
| 4 | LLM 分析 | 理解业务、证据、制定 must/veto 条件 |
| 5 | SaveCandidateAnalysis | 提交分析（白名单自动校验） |
| 6 | RunReplay | 独立窗口验证规则 |
| 7 | 报告 | 中文四段式分析报告 + 汇总表 |

**Agent 输出示例：**

```
### 候选规则：订单支付状态查询（成功响应）

**降噪规则：**
  必须条件 (MUST)：
  - rule_id = RULE_ORDER
  - service_key = order-service
  - http_method = GET
  - url_pattern starts_with /api/orders/
  - request_body_type = empty
  - response_status_class = 2xx
  否决条件 (VETO)：
  - is_confirmed_attack = true
  - risk_level != LOW

**规则解读：**
  该规则会匹配 order-service 服务下 GET 方式查询订单支付状态、
  服务端返回 2xx 的告警。所有统计指标安全
  （零确认攻击、零恶意来源、零提取失败）。

**判定依据：**
  | 指标 | 数值 |
  |------|------|
  | 告警总数 | 422 条 |
  | 活跃天数 | 2 天 |
  | 来源数 | 3 个 |
  | 成功率 | 100% |
  | 确认攻击 | 0 |
  | 恶意来源 | 0 |
  | 提取失败 | 0 |
  每条 must 条件覆盖 100% 告警。

**预期效果：**
  - 回放扫描：238 条独立告警
  - 预计降噪：131 条（占扫描量 55%）
  - Precision: 1.00 | Recall: 0.876
  - 误降噪风险：无（Precision=1.00）
  - 漏检风险：19 条未被捕获，由候选 2（3xx）互补覆盖

**建议：需调整后发布 ← 与候选 2 合并**

---

### 候选规则：订单支付状态查询（缓存响应）

**降噪规则：**
  必须条件 (MUST)：（同上，response_status_class=3xx）
  否决条件 (VETO)：is_confirmed_attack=true, risk_level!=LOW

**规则解读：**
  与候选 1 配对，唯一差异是 3xx（304 Not Modified）。
  代表客户端缓存命中的场景。

**判定依据：**
  告警总数 87 | 活跃 2 天 | 来源 3 个 | 成功率 100%
  确认攻击 0 | 恶意来源 0 | 提取失败 0

**预期效果：**
  Precision: 1.00 | Recall: 0.124
  误降噪风险：无
  漏检风险：无（与候选 1 联合完全覆盖）

---

### 合并方案（Agent 主动建议）

  将 response_status_class 改为 in ["2xx", "3xx"]：

  | 字段 | 条件 |
  |------|------|
  | rule_id | = RULE_ORDER |
  | service_key | = order-service |
  | http_method | = GET |
  | url_pattern | starts_with /api/orders/ |
  | request_body_type | = empty |
  | response_status_class | in ["2xx", "3xx"] |

  联合 Precision=1.00，联合 Recall=1.00
  一条规则覆盖全部场景，推荐发布 ✅

---

### 发现汇总

| 候选ID | 业务名称 | 告警数 | Precision | Recall | 通过 | 建议 |
|--------|----------|--------|-----------|--------|------|------|
| candidate-0041 | 订单支付状态查询（2xx） | 422 | 1.00 | 0.876 | ✅ | 合并后发布 |
| candidate-0042 | 订单支付状态查询（3xx） | 87 | 1.00 | 0.124 | ✅ | 合并后发布 |
| 合并规则 | 订单支付状态查询 | 509 | 1.00 | 1.00 | ✅ | 推荐发布 |
```

---

## 第五步：人工审批发布

```bash
docker exec octobus sh -c "
export NODE_PATH=/var/lib/octobus/artifacts/services/business-identification/runtime/node_modules
node -e \"
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const pkgDef = loader.loadSync('/opt/services/business-identification/proto/business_identification.proto', {keepCase:true,longs:String,enums:String,defaults:true,oneofs:true});
const proto = grpc.loadPackageDefinition(pkgDef);
const svc = proto.businessidentification.v1.BusinessIdentificationService;
const PORT = require('child_process').execSync('curl -sf http://127.0.0.1:9000/admin/v1/instances | grep -o 127.0.0.1:[0-9]* | head -1 | cut -d: -f2').toString().trim();
const client = new svc('127.0.0.1:' + PORT, grpc.credentials.createInsecure());
const call = (m, r) => new Promise((rs, rj) => client[m](r, (err, res) => err ? rj(err) : rs(res)));
(async () => {
  const list = await call('ListCandidates', {tenant_id:'tenant-a'});
  for (const c of list.candidates) {
    try {
      const pub = await call('PublishPattern', {
        candidate_id: c.id,
        approved_by: 'demo-operator',
        approved_comment: 'Approved - replay passed with 100% precision'
      });
      console.log(pub.published ? 'P' + c.id + ' -> ' + pub.pattern_id : 'X ' + c.id + ': ' + pub.errors.join(', '));
    } catch(e) { console.log('X ' + c.id + ': ' + (e.details || e.message)); }
  }
  client.close();
})();
\"
```

---

## 第六步：验证降噪效果

```bash
docker exec octobus sh -c "
export NODE_PATH=/var/lib/octobus/artifacts/services/business-identification/runtime/node_modules
node -e \"
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const pkgDef = loader.loadSync('/opt/services/business-identification/proto/business_identification.proto', {keepCase:true,longs:String,enums:String,defaults:true,oneofs:true});
const proto = grpc.loadPackageDefinition(pkgDef);
const svc = proto.businessidentification.v1.BusinessIdentificationService;
const PORT = require('child_process').execSync('curl -sf http://127.0.0.1:9000/admin/v1/instances | grep -o 127.0.0.1:[0-9]* | head -1 | cut -d: -f2').toString().trim();
const client = new svc('127.0.0.1:' + PORT, grpc.credentials.createInsecure());
const call = (m, r) => new Promise((rs, rj) => client[m](r, (err, res) => err ? rj(err) : rs(res)));
(async () => {
  const match = await call('MatchIncomingAlerts', {
    tenant_id: 'tenant-a',
    incoming_start: new Date(Date.now() - 72*3600000).toISOString(),
    incoming_end: new Date().toISOString()
  });
  const supp = match.results.filter(r => r.decision === 'SUGGEST_SUPPRESS').length;
  const keep = match.results.filter(r => r.decision === 'KEEP_ALERT').length;
  console.log('全量告警: ' + match.scanned_count);
  console.log('降噪: ' + supp + ' (' + (supp/match.scanned_count*100).toFixed(1) + '%)');
  console.log('保留: ' + keep);
  const reasons = {};
  match.results.filter(r => r.decision === 'KEEP_ALERT').forEach(r => {
    try { (JSON.parse(r.reason_json).systemVeto||[]).forEach(v => reasons[v]=(reasons[v]||0)+1); }
    catch {}
  });
  console.log('\\n保留原因:');
  Object.entries(reasons).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  ' + k + ': ' + v));
  client.close();
})();
\"
```

预期输出：

```
全量告警: 813
降噪: 730 (89.8%)
保留: 83

保留原因:
  risk_level=HIGH: 35
  has_path_traversal=true: 16
  is_confirmed_attack=true: 7
  source_reputation=malicious: 7
  has_dangerous_extension=true: 6
  extraction_failed=true: 4
```

---

## 一键重置并全流程演示

```bash
docker exec octobus sh -c "rm -f /var/lib/octobus/instances/bi-prod/data/bi-store.db*"
docker exec octobus octobus instance restart bi-prod
sleep 3
docker exec octobus sh /opt/services/business-identification/test/demo.sh
```

---

## 总结

```
                     训练数据 (813条，自动预加载)
                           ↓
┌──────────────────────────────────────────────────────┐
│  Agent 自主执行 (agent-compose + DeepSeek LLM)         │
│                                                      │
│  DiscoverCandidates -> 2 个候选                       │
│   ├── "订单支付状态查询（2xx）" 422 alerts              │
│   └── "订单支付状态查询（3xx）" 87 alerts               │
│                                                      │
│  GetCandidateContext -> 样本告警                      │
│  LLM 分析 -> 中文四段式报告                            │
│  SaveCandidateAnalysis -> 规则入库                    │
│  RunReplay -> precision=1.00, recall=1.00 (合并后)    │
│                                                      │
│  Agent 主动建议：合并 2xx+3xx 为一条规则               │
│                                                      │
│  -> 等待人工审批                                       │
└───────────────────────┬──────────────────────────────┘
                        ↓
                  人工审批发布
              PublishPattern x N
                        ↓
                  降噪效果验证
              MatchIncomingAlerts
              730 降噪 / 83 保留
              降噪率 89.8%, 零误降噪
```

核心原则：**程序发现、Agent 解释、程序验证、人工发布、在线保守执行**。
