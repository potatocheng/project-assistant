# 公开数据完整链路优化前后对比

Same frozen questions. Current and baseline final answers are graded anonymously in the same isolated answer-judge call when pairedGrade is true. Legacy grades remain visible for scoring-drift audit. All answerable questions remain in denominators, errors and missing judgments never count as correct. Memory retention judge does not see retrieval or answers and sees only formal content, never provenance quotes. Automatic same-model estimates; no independent human review. Prior 80 held-out questions are now fixed regression cases, not unseen blind evaluation.

| 集合/入口 | 优化前完整正确 | 优化后完整正确 | 新增成功 | 退化 |
|---|---:|---:|---:|---:|
| all:desktop | 0/19 | 2/19 | 2 | 0 |
| all:connector | 0/19 | 2/19 | 2 | 0 |
| development:desktop | 0/19 | 2/19 | 2 | 0 |
| development:connector | 0/19 | 2/19 | 2 | 0 |

## 提取

```json
{
  "before": {
    "papers": 6,
    "statuses": {
      "succeeded": 1,
      "failed": 5
    },
    "formalMemories": 0,
    "drafts": {},
    "requests": 13,
    "tokens": 90198
  },
  "after": {
    "papers": 6,
    "statuses": {
      "succeeded": 6
    },
    "formalMemories": 765,
    "drafts": {
      "ready": 773,
      "needs_review": 228
    },
    "requests": 100,
    "tokens": 408868
  }
}
```

逐题变化、协议错误和使用量见同名JSON。