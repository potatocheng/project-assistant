# QA高效轮评测：引用输入格式适配

本轮沿用原来的隔离answer/memory/retrieval评分提示词、评分标签和标准。新的生产模型引用可用数字引用/片段索引降低输出格式错误；实际生产包仍保留稳定id/memoryId、referenceIndex和完整当前正文。

生产输入的旧格式是 `content: "完整正文"`。新格式是 `content: [{spanIndex: 1, text: "精确连续片段"}, ...]`，spanIndex必须正整数连续1至N，所有片段按数组顺序覆盖同一正文，无重复。评测捕获仅将新格式中的text按实际数组顺序精确连接，作为隔离检索评分所需的正文字符串；保留稳定引用ID，不添加事实、分隔符、摘要或原文证据。

该转换发生在请求已真实发送、原始收据已按原始请求保存之后，仅用于诊断与评分视图。原始请求、hash、gold隔离、生产输出解析和引用校验不因评测转换而改变。非法片段形状、重复片段编号等直接失败，不推断或补正文。

格式捕获适配和round-manifest选择会使本轮harness指纹与上一轮不同；旧工件及其快照保持不变。新manifest包含本说明、新预注册、新gate及捕获适配代码。新开发与100题必须在同一批评分指纹下完成，禁止通过评测器变化回填上一轮结果。

## 已核验部分答案回退的实际上下文

生产流程可在一次补查失败或新答案未通过审查时，返回初次已经严格引用校验且review通过的partial。实际生成尝试仍按真实收据先后全部保留；不复制、不重排，也不为评测产生新模型调用。

这时 `queryTrace.answerGenerationIndex=0` 且 `reviewedPartialFallback=true`。选择器要求一至两次真实generation、索引0、最终grounded partial、初次原始输出grounded、初次review同时supported和answersQuestion；补查被预算拒绝而未发送时，允许只有一次真实generation，不伪造第二次调用。真实generation收据ID须唯一、顺序递增且属于该问答全部收据；非法、越界、任意回退直接失败。普通回答只能选择最后一次实际generation；没有marker的历史工件继续沿用最后一次，零generation的结构化字段回答保持空模型参考。

隔离retrieval评分及正文覆盖统计使用实际返回答案对应的generation参考。这修正的是新增回退路径的上下文归属，不改变评分提示词、标签或正确性标准。历史scorer的 `lastGeneration*` 字段名为兼容保留，在有显式回退时表示producer选择的generation；新增 `selectedGenerationIndex`、`generationSelection`及 `lastAttempt*` 同时保留最后尝试的覆盖，防止误称初次生成是最后尝试。

任务阶段分类优先读取旧JSON-object请求中的user.schema；该字段不存在时读取provider的response_format.json_schema.schema或Ollama format对象。仅定位真实schema来区分generation/rewrite/review，不向请求添加重复schema，不修改评分任务内容。
