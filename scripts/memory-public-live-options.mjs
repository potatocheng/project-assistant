import path from 'node:path';

export function publicLiveOptions(args, root) {
  const flags = args.filter(a => a.startsWith('--'));
  const allowed = new Set(['--split', '--output-tag', '--judge-mode', '--max-requests', '--max-tokens', '--workers', '--resume', '--baseline', '--require-gate', '--paragraph-control', '--prior-run', '--repair-failed-judges', '--budget-addendum']);
  if (new Set(flags).size !== flags.length) throw new Error('Duplicate option');
  if (flags.some(f => !allowed.has(f))) throw new Error('Unknown option');
  const value = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`); return args[i + 1]; };
  const integer = (name, fallback, max) => { const n = Number(value(name, fallback)); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1..${max}`); return n; };
  const split = value('--split', 'all');
  if (!['all', 'development', 'holdout'].includes(split)) throw new Error('Invalid --split');
  const tag = value('--output-tag', null);
  if (tag && !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) throw new Error('Invalid --output-tag');
  if (!tag && !args.includes('--resume')) throw new Error('A new run requires --output-tag, preserving previous reports');
  const judges = value('--judge-mode', 'memory-answer');
  if (!['answers', 'memory-answer', 'separated'].includes(judges)) throw new Error('Invalid --judge-mode');
  const repairFailedJudges = args.includes('--repair-failed-judges');
  if (repairFailedJudges && !args.includes('--resume')) throw new Error('--repair-failed-judges requires --resume');
  return { split, tag, judges, maxRequests: integer('--max-requests', split === 'development' ? 500 : 1400, 5000),
    maxTokens: integer('--max-tokens', split === 'development' ? 2000000 : 8000000, 30000000),
    workers: integer('--workers', 3, 4), resume: value('--resume', null),
    baseline: path.resolve(root, value('--baseline', 'docs/memory-public-live-results.json')),
    requiredGate: value('--require-gate', null), repairFailedJudges,
    budgetAddendum: value('--budget-addendum', null) ? path.resolve(root, value('--budget-addendum', null)) : null };
}

export function isJudgeProtocolFailure(stage) {
  if (!stage?.error) return false;
  if (stage.errorKind) return stage.errorKind === 'protocol';
  // Legacy runs stored only the exception text. Recognize JSON parser and
  // explicit judge-schema errors, never transport, limits or semantic grades.
  return /^(?:Answer judge schema|Memory judge schema\/ID whitelist|Retrieval judge schema)$/.test(stage.error)
    || /^(?:Unexpected (?:token|end of JSON input|non-whitespace character)|Expected |Unterminated string|Bad (?:control character|escaped character|Unicode escape))/.test(stage.error)
      && /JSON/.test(stage.error);
}

export function failedJudgeRepairPlan(report, documents) {
  if (report.documents.length !== documents.length || report.documents.some(d => d.complete !== true)) throw new Error('Judge repair requires all production documents complete');
  for (const doc of documents) {
    const paper = report.documents.find(d => d.id === doc.id);
    if (!paper || paper.questions.length !== doc.queries.length || doc.queries.some(q => !paper.questions.some(a => a.id === q.id && a.entries?.desktop && a.entries?.connector))) throw new Error('Judge repair requires completed production questions');
  }
  const plan = [];
  for (const judgment of report.judgments) {
    const phases = Object.entries(judgment.stages ?? {}).filter(([, stage]) => isJudgeProtocolFailure(stage)).map(([phase]) => phase);
    if (!phases.length) continue;
    if (phases.some(p => !['answer', 'memory', 'retrieval'].includes(p))) throw new Error('Unknown failed judge phase');
    if (report.evaluationRepairs?.some(r => r.questionId === judgment.id)) throw new Error(`Judge repair was already attempted for ${judgment.id}`);
    if (!documents.some(d => d.id === judgment.paperId && d.queries.some(q => q.id === judgment.id))) throw new Error('Failed judgment does not belong to the frozen selection');
    plan.push({ questionId: judgment.id, paperId: judgment.paperId, phases });
  }
  return plan;
}

export function beginJudgeRepair(report, item, requestedAt = new Date().toISOString()) {
  if (report.evaluationRepairs?.some(r => r.questionId === item.questionId)) throw new Error('Judge repair was already attempted');
  const judgment = report.judgments.find(j => j.id === item.questionId);
  if (!judgment || !item.phases.length || new Set(item.phases).size !== item.phases.length || item.phases.some(p => !['answer', 'memory', 'retrieval'].includes(p) || !isJudgeProtocolFailure(judgment.stages?.[p]))) throw new Error('Only failed parser/schema judge phases can be repaired');
  const repair = { questionId: item.questionId, paperId: item.paperId, previousJudgment: structuredClone(judgment), phases: [...item.phases], requestedAt, newReceiptIds: [] };
  (report.evaluationRepairs ||= []).push(repair);
  return repair;
}

export function selectPublicDocuments(fixture, split) {
  const documents = fixture.documents.filter(d => split === 'all' || d.split === split);
  return { documents, questionCount: documents.reduce((n, d) => n + d.queries.length, 0), paragraphCount: documents.reduce((n, d) => n + d.paragraphs.length, 0) };
}

export function publicReportPath(root, report) {
  const tag = report.outputTag;
  if (tag && !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) throw new Error('Invalid report outputTag');
  return path.join(root, tag ? `docs/memory-public-live-${tag}-results.json` : report.paragraphControl ? 'docs/memory-public-live-control-results.json' : 'docs/memory-public-live-results.json');
}

export function assertNoProductionGold(input) {
  if (['humanAnswers', 'goldParagraphs', 'humanEvidenceAlternatives', 'acceptableEvidenceSets', 'expectedAnswers'].some(k => Object.hasOwn(input, k))) throw new Error('Gold appeared in production input');
}
