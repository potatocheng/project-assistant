# 公开数据完整链路优化前后对比

Same frozen questions. Current and baseline final answers are graded anonymously in the same isolated answer-judge call when pairedGrade is true. Legacy grades remain visible for scoring-drift audit. All answerable questions remain in denominators, errors and missing judgments never count as correct. Memory retention judge does not see retrieval or answers and sees only formal content, never provenance quotes. Automatic same-model estimates; no independent human review. Prior 80 held-out questions are now fixed regression cases, not unseen blind evaluation.

| 集合/入口 | 优化前完整正确 | 优化后完整正确 | 新增成功 | 退化 |
|---|---:|---:|---:|---:|
| all:desktop | 0/91 | 31/91 | 31 | 0 |
| all:connector | 0/91 | 33/91 | 33 | 0 |
| development:desktop | 0/19 | 9/19 | 9 | 0 |
| development:connector | 0/19 | 7/19 | 7 | 0 |
| holdout:desktop | 0/72 | 22/72 | 22 | 0 |
| holdout:connector | 0/72 | 26/72 | 26 | 0 |

## 提取

```json
{
  "before": {
    "papers": 36,
    "statuses": {
      "succeeded": 7,
      "failed": 29
    },
    "formalMemories": 1,
    "drafts": {},
    "requests": 119,
    "tokens": 737206
  },
  "after": {
    "papers": 36,
    "statuses": {
      "succeeded": 36
    },
    "formalMemories": 4571,
    "drafts": {
      "ready": 4644,
      "needs_review": 20
    },
    "requests": 490,
    "tokens": 2026410
  }
}
```

逐题变化、协议错误和使用量见同名JSON。