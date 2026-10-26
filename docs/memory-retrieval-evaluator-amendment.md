# 检索评测器协议修订：只补匿名系统外层字段

本修订发生于首轮 `retrieval-dev` 真实20题试运行结束后、新的 `retrieval-dev-v2` 真实调用开始前。修改评分输出解析及审计，不修改生产 Rust、模型评分提示词、标签含义、数据或预注册数值门槛。

## 原始失败及保留方式

首轮 `retrieval-dev` 的生产提取与问答已完成，但评分器在两道题的answer阶段返回合法JSON，最外层直接是 `system1`、`system2`，缺少schema要求的 `systems` 包装。原始收据238、246和显式格式重评后的271均为该样式；其中271仍失败，不能再次调用模型重评该题。

首轮最终记录271次真实调用、1420745个已报告token，`complete=false`。初次评分失败工件保留于 `memory-public-live-retrieval-dev-before-judge-repair-results.json`；显式一次格式重评及其先前判断、收据也保留于原运行。**不通过本修订回填或改写该试运行分数，不把它判为通过，不重复调用失败题。** 新一轮完整执行提取、组织、生产问答和评分，作为 `retrieval-dev-v2` 独立工件。

## 精确允许的无损规范化

只在answer阶段、provider `finish_reason=stop`、原文已经是合法JSON时允许：

```json
{"system1":{"desktop":{"answerCorrect":"yes","reason":"..."},"connector":{"answerCorrect":"no","reason":"..."}},"system2":{"desktop":{"answerCorrect":"partial","reason":"..."},"connector":{"answerCorrect":"uncertain","reason":"..."}}}
```

规范化为 `{"systems": 原对象}`。原对象最外层必须精确为两个key；每个system必须精确含desktop/connector；每个grade必须精确含answerCorrect/reason。四个标签必须原样存在且属于既定四选一，reason必须原样为非空字符串。系统顺序、匿名映射、标签、理由一律不修改。

不补缺失分数、理由、system或entry，不接受额外key，不重命名字段，不变更大小写，不转换分数。其他评分阶段不适用；截断响应不适用；不能与缺末尾括号的语法修复叠加来恢复同一响应。标准 `systems` 包装的正常响应保持原有路径。

## 审计与下一轮顺序

原始模型收据不变。`evaluationEnvelopeNormalizations`记录题号、paper、阶段、收据ID、规范化种类、仅新增的字段、原始响应SHA256和规范JSON SHA256，声明额外模型调用为0。完整性验证重新读取原始收据，检查精确输入形状、四项原始值、双SHA及已保存阶段判断一致。

新增单测覆盖无损映射、错误字段、缺项、无理由、非法分数、截断、跨阶段误用及语法/外层修复叠加。完整确定性回归重新通过后，冻结包含此说明的评分规则指纹，再启动新的 `retrieval-dev-v2` 20题。仍须通过原数值门槛及同次匿名配对净增要求，才可用相同Rust和评分规则进入完整100题。

原注册文件的数值门槛、登记时间及旧基线指纹保持不变。本修订改变了协议接纳规则，因此首轮试运行和修订后的正式运行须分开报告；不能宣称整个开发过程从未调整评分器。所有真实调用及失败成本纳入本轮总成本。

新的20题通过 `--prior-run docs/memory-public-live-retrieval-dev-results.json` 与首轮共享注册开发总预算600次请求/300万报告token。首轮已用271次/1420745token，因此新运行剩余上限329次/1579255token；如不足则停止并保留未完成工件，不通过扩大预算绕过注册限制。完整100题仍须开发门槛通过后另行启动，继续与上一轮 `optimized-full` 配对比较。
