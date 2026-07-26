# 注入领域知识说明（Knowledge Foundation）

本文档说明业务识别告警降噪系统中注入的领域知识——每条知识的内容、来源、选择依据和失效场景。这是 Agent 工程师考核评定中"知识实质性"部分的核心参考。

---

## 1. 系统永久否决规则（6 条）

代码位置：`business-identification-js/src/system-veto.js`

Agent 制定的 should/veto 条件运行之前，系统先执行一套不可绕过的硬否决。这 6 条规则来自安全运营一线的共识——它们在演示数据中有明确的验证样例，每条被否决的告警都可以被追溯到具体原因。

### 1.1 确认攻击 (`is_confirmed_attack = true`)

**内容**：安全产品已明确标记为"确认攻击"的告警，无论业务模式多匹配都必须保留。

**来源**：WAF 和 SIEM 产品的告警分类中，确认攻击代表安全分析师已经判定为真实攻击或已经造成实际危害的告警。这类告警即使表现出正常业务行为的统计特征（高频、稳定 URL 模式），也不能降噪——因为攻击者完全可能利用正常接口发起攻击。

**失效场景**：如果不设此规则，攻击者构造出和正常业务一模一样的请求（比如用 `/api/orders/{num}/payment-status` 做 SQL 注入并返回 200），系统会误将其识别为"订单支付状态查询"并建议降噪，导致安全团队错过真实攻击。

**演示验证**：`demo-data.js` 中 `RISK_TEMPLATES` 第一项生成了 `is_confirmed_attack: true` 的告警，回放验证时被系统否决拦截。

### 1.2 高风险等级 (`risk_level = HIGH`)

**内容**：任何被上游安全产品评为 HIGH 风险等级的告警，无论是否匹配业务模式，一律保留。

**来源**：security products 的风险等级通常对应告警的可信度和危害程度。HIGH 代表产品已经有较高置信度认为这是一个值得关注的告警。将其降噪等同于"无视安全产品的判断"。

**失效场景**：当业务接口被高频扫描器探测时，可能产生大量 HIGH 风险告警。如果不否决，这些告警会被标记为业务行为而降噪，导致扫描行为被隐藏。

### 1.3 恶意 IP (`source_reputation = malicious`)

**内容**：请求来源 IP 已被威胁情报标记为恶意的，必须保留告警。

**来源**：恶意 IP 的请求即使 URL 和方法完全正常，其意图可能不是正常业务操作。例如，恶意 IP 可能对 `/api/orders/{num}/payment-status` 做信息枚举或越权测试。

**失效场景**：恶意 IP 发起的请求如果在统计上与正常业务完全相同，不设此规则会将其降噪，导致安全团队无法追踪该 IP 的行为模式。

### 1.4 路径穿越 (`has_path_traversal = true`)

**内容**：URL 中包含 `/../` 等路径穿越特征的告警，无论业务匹配度如何，强制保留。

**来源**：路径穿越是典型的攻击模式，即使目标是合法的业务接口（如 `/static/../../etc/passwd`），行为本身已经暴露了攻击意图。

### 1.5 危险扩展名 (`has_dangerous_extension = true`)

**内容**：URL 中请求了可执行文件类型（`.php`、`.jsp` 等）的告警，禁止降噪。

**来源**：正常业务通常不涉及上传或请求可执行脚本文件。即使该行为在统计上看似"重复出现"，也不能将其自动化降噪。

### 1.6 画像提取失败 (`extraction_failed = true`)

**内容**：安全产品无法正常解析请求特征（URL 无法归一化、HTTP 方法异常等）的告警，保留给人工判断。

**来源**：画像提取失败的告警通常是格式异常或绕过攻击的产物。系统无法可靠判断其业务含义时，保守保留是唯一安全选择。

---

## 2. 八字段精确分组策略

代码位置：`business-identification-js/src/candidate.js` (`exactGroupKey` 函数)

### 选择的 8 个分组字段

```
tenant_id + rule_id + service_key + protocol + http_method + 
url_pattern + request_body_type + response_status_class
```

### 选择依据

**为什么选这些字段**：

| 字段 | 选择理由 |
|---|---|
| `tenant_id` | 多租户隔离，不同租户的相同 URL 不是同一业务 |
| `rule_id` | 同一 URL 可能触发不同 WAF 规则，规则决定了告警的本质 |
| `service_key` | 同一 URL 模式可能被不同服务使用，混合分组会丢失服务边界 |
| `protocol` | HTTP/HTTPS 可能有不同的业务处理路径 |
| `http_method` | GET 和 POST 到同一 URL 通常是不同操作，必须分开 |
| `url_pattern` | 归一化后的 URL 模式，去掉了参数化部分，是业务接口的标识 |
| `request_body_type` | 带 JSON body 和空 body 的请求行为可能完全不同 |
| `response_status_class` | 2xx（成功）、3xx（缓存/重定向）、5xx（服务端错误）代表不同的系统状态，必须分组 |

### 有意不选的字段

| 不选的字段 | 原因 |
|---|---|
| 具体 URL（含订单号等参数） | 会让每条告警各成一组，无法发现重复模式 |
| source_ip | 同一业务可能来自多个 IP，按 IP 分组会拆散正常业务 |
| response_status（精确值） | 200 和 201 在语义上属于同一类"成功响应"，不应分开 |
| occur_at | 时间戳没有业务意义，不能作为分组维度 |

### 失效场景

如果按 `url_pattern + http_method` 两字段分组（忽略 `response_status_class`），会导致 2xx 正常响应和 5xx 错误响应被归入同一组。系统可能将"偶发的服务端错误"也标记为降噪，而这些 503 错误可能代表真实的服务故障或攻击尝试。

---

## 3. 字段白名单与操作符限制

代码位置：`business-identification-js/src/analysis-validator.js`

### 21 字段白名单

系统只允许 Agent 在 21 个字段上设定 must/veto 条件，这些字段全部来自告警的安全画像，每个都有明确的业务含义。

### 排除的关键字段

| 排除的字段 | 原因 |
|---|---|
| 具体 URL（未经归一化） | Agent 可能选择精确匹配某条 URL，导致规则泛化能力为零 |
| source_ip | Agent 可能按 IP 条件匹配，导致规则只能匹配特定 IP（例如"内部 IP 才降噪"），但攻击也可能来自内部 IP |
| occur_at 时间戳 | 时间戳不具备可复用性，今天学到的条件明天就失效 |
| 告警原始 body | 攻击 payload 可能在 body 中，但不具备可复用的特征 |

### 7 操作符限制

仅开放 `eq / neq / in / not_in / contains / not_contains / starts_with`。

**为什么不开 {eq, regex, gt, lt, between}**：

| 操作符 | 不开的原因 |
|---|---|
| regex | Agent 可能生成无法验证正确性的正则，且可能过度匹配或匹配不到 |
| gt / lt / between | 数值比较（如 `response_status > 400`）可能在安全运营中产生非预期行为——将 401（未授权）和 500（服务器错误）等同处理 |
| 自定义函数 | LLM 可能编造不存在的函数名 |

### 失效场景

如果开放全部操作符和字段，Agent 可能自由生成类似 `source_ip eq "10.0.1.1"` 的条件。该规则在测试集上 Precision = 100%（因为测试集恰好也是这个 IP），但上线后换了 IP 就完全失效。白名单和操作符限制防止了这种"死记硬背"式的规则。

---

## 4. 训练数据与验证集分离

代码位置：`business-identification-js/src/handlers.js` (`runReplay` 函数)

### 核心设计

训练数据（最近 24h）和验证集（独立打标数据）完全隔离。验证集使用 `verif-` ID 前缀标识，由 `generateVerificationSet()` 独立生成。

### 为什么要分离

如果用同一批数据"发现模式"又"验证模式"，系统会进入"背答案"模式：

```
训练: 100% 的告警 method=GET → must 条件: http_method eq GET
验证: 同一批数据 → 当然全部 match → Precision=100%
```

这个 100% 不是规则有多好，而是验证集已经"泄露"了。

### 代码级防护

```javascript
// 如果时间窗口重叠，直接拒绝执行
if (candidate.discoveryTimeStart < replayEnd && 
    candidate.discoveryTimeEnd > replayStart) {
  throw grpcInvalidArgumentError("data leakage detected");
}
```

### 实践来源

在开发过程中，初始版本的训练和验证数据是同一批 813 条告警按时间窗口切分的。这导致回放 Precision 始终为 100%，无法区分"规则真的好"还是"规则只在训练集上背了答案"。改为独立生成验证集后，才出现 Recall < 100% 的情况（3xx 候选的 Recall 只有 12.4%），证实了分离的必要性。

---

## 5. 系统否决优先于 Agent 条件

代码位置：`business-identification-js/src/condition-evaluator.js` + `system-veto.js`

### 执行顺序

```
系统永久否决（6 条）→ Agent must 条件 → Agent veto 条件
```

Agent 不能删除或绕过系统否决规则。这体现了安全运营中的基本设计原则：**安全底线不可协商**。

### 为什么不信任 Agent

LLM 可能"理解"业务模式后忽略了安全风险。例如，Agent 分析了 `/api/admin/export` 返回 200 的重复模式后，可能认为"这是一个定期导出管理，可以降噪"。但如果这些请求来自外部 IP 且 `is_confirmed_attack=true`，降噪会导致安全团队失去对攻击行为的感知。

### 代码实现

系统否决在 `runReplay` 和 `matchIncomingAlerts` 中都是第一道检查。一旦命中，后续的 Agent 条件不再评估，直接输出 `KEEP_ALERT`。

---

## 6. 建议降噪而非自动降噪

代码位置：`business-identification-js/src/handlers.js` (`matchIncomingAlerts`)

### SUGGEST_SUPPRESS 的设计

`MatchIncomingAlerts` 对匹配规则的告警输出 `SUGGEST_SUPPRESS`（建议降噪），而不是直接修改告警标签。自动降噪的安全风险太高——任何误判都可能导致真实攻击被隐藏。

### 对比：如果选择自动降噪

| 场景 | SUGGEST_SUPPRESS（当前） | 自动降噪（如果实现） |
|---|---|---|
| 正常业务被识别 | 建议降噪，人可以看到并确认 | 直接降噪，可观察性降低 |
| 新型攻击模仿正常业务 | 建议降噪，告警仍然存在，人需要判断 | 直接降噪，攻击被隐藏 |

---

## 7. 精确率优先于召回率

### 核心权衡

在安全运营领域，**宁可漏掉一部分噪音不降噪，也绝不能让真实攻击被降噪**。这决定了 Precision 必须为 1.0。

### 具体体现

1. **边界样本设计**：`demo-data.js` 生成 POST 方法、503 错误等边界样本，它们的 `expected_pattern` 为空。如果规则过于宽松（例如只匹配 `url_pattern` 不匹配 `http_method`），这些边界样本就会被误降噪，导致 Precision < 1.0。

2. **回放验证设计**：`RunReplay` 的通过条件是 `matched >= 1 && suppression >= 1 && confirmedDemoted === 0`。任何确认攻击的误降噪都会导致回放不通过，规则无法发布。

3. **Agent 提示词设计**：`agent-compose.yml` 的 confidence 评分标准中，0.95 分的条件是"所有 must 覆盖率 100%、安全指标全 0、回放 precision=1.0"。

### 数据验证

从实际测试结果看，3xx 候选的 Recall 只有 12.4%（只覆盖了 304 响应的告警，漏掉了 200 响应的），但 Precision = 1.0。这证实了系统在宽松条件和严格条件之间选择了严格——宁愿漏掉也要保证准确。Agent 分析后主动建议"合并 2xx 和 3xx 为一条规则"，合并后 Recall = 1.0 同时 Precision 保持 1.0。
