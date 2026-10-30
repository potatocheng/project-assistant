import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';

const count = values => values.reduce((sum, value) => { sum[value] = (sum[value] || 0) + 1; return sum; }, {});
const accuracy = (n, d) => ({ count: n, denominator: d, rate: d ? n / d : null });
export function comparePublicLive(current, baseline) {
  if (current.datasetSha256 !== baseline.datasetSha256) throw new Error('Comparison fixture mismatch');
  const before = new Map(baseline.documents.flatMap(p => p.questions.map(q => [q.id, { ...q, paperId: p.id, split: p.split }])));
  const originalJudges = new Map(baseline.judgments.map(j => [j.id, j]));
  const rows = current.documents.flatMap(p => p.questions.flatMap(q => {
    const previous = before.get(q.id); if (!previous || previous.question !== q.question || previous.answerable !== q.answerable) throw new Error('Comparison question mismatch');
    const judge = current.judgments.find(j => j.id === q.id);
    return ['desktop', 'connector'].map(entry => {
      const paired = judge?.baselineEntries?.[entry], old = paired ?? originalJudges.get(q.id)?.entries?.[entry];
      const next = judge?.entries?.[entry];
      const oldCorrect = old?.answerCorrect === 'yes' && !previous.entries[entry]?.error;
      const newCorrect = next?.answerCorrect === 'yes' && !q.entries[entry]?.error;
      return { id: q.id, paperId: p.id, split: p.split, entry, answerable: q.answerable,
        before: old?.answerCorrect ?? 'not_judged', after: next?.answerCorrect ?? 'not_judged',
        baselineOriginalGrade: originalJudges.get(q.id)?.entries?.[entry]?.answerCorrect,
        pairedGrade: !!paired, beforeError: previous.entries[entry]?.errorCode, afterError: q.entries[entry]?.errorCode,
        oldCorrect, newCorrect, change: newCorrect ? oldCorrect ? 'retained_success' : 'new_success' : oldCorrect ? 'regression' : 'still_unsuccessful',
        memorySufficiency: judge?.memorySufficiency, retrievalSufficiency: next?.retrievalSufficiency };
    });
  }));
  const summary = {};
  for (const split of ['all', 'development', 'holdout']) for (const entry of ['desktop', 'connector']) {
    const selected = rows.filter(r => r.entry === entry && (split === 'all' || r.split === split));
    const answerable = selected.filter(r => r.answerable), unanswerable = selected.filter(r => !r.answerable);
    const old = answerable.filter(r => r.oldCorrect).length, next = answerable.filter(r => r.newCorrect).length;
    summary[`${split}:${entry}`] = { cases: selected.length, pairedJudged: selected.filter(r => r.pairedGrade).length,
      answerable: answerable.length, unanswerable: unanswerable.length,
      beforeFullyCorrect: accuracy(old, answerable.length), afterFullyCorrect: accuracy(next, answerable.length),
      absoluteImprovement: answerable.length ? (next - old) / answerable.length : null,
      answerableChanges: count(answerable.map(r => r.change)),
      beforeCorrectAbstention: accuracy(unanswerable.filter(r => r.oldCorrect).length, unanswerable.length),
      afterCorrectAbstention: accuracy(unanswerable.filter(r => r.newCorrect).length, unanswerable.length),
      retainedMemoryYes: accuracy(answerable.filter(r => r.memorySufficiency === 'yes').length, answerable.length),
      retainedMemoryYesOrPartial: accuracy(answerable.filter(r => ['yes', 'partial'].includes(r.memorySufficiency)).length, answerable.length),
      beforeProtocolErrors: count(selected.filter(r => r.beforeError).map(r => r.beforeError)),
      afterProtocolErrors: count(selected.filter(r => r.afterError).map(r => r.afterError)) };
  }
  const extraction = report => ({ papers: report.documents.length, statuses: count(report.documents.map(d => d.extraction?.job?.status ?? 'not_run')),
    formalMemories: report.documents.reduce((n, d) => n + d.memories.length, 0),
    drafts: count(report.documents.flatMap(d => (d.extractionDrafts ?? []).map(x => x.status ?? 'unknown'))),
    requests: report.receipts.filter(r => r.phase === 'extraction').length,
    tokens: report.receipts.filter(r => r.phase === 'extraction').reduce((n, r) => n + (r.usage?.total_tokens || 0), 0) });
  const matchingIds = new Set(current.documents.map(d => d.id));
  const baselineMatched = { ...baseline, documents: baseline.documents.filter(d => matchingIds.has(d.id)), receipts: baseline.receipts.filter(r => matchingIds.has(r.paperId)) };
  const downstreamFiles = ['qa.rs', 'assistant_qa.rs', 'answer_contract.rs', 'question_flow.rs', 'memory_query.rs'];
  return { version: 'qasper-production-comparison-v1', createdAt: new Date().toISOString(), datasetSha256: current.datasetSha256,
    current: { workspace: current.workspace, outputTag: current.outputTag, model: current.model, complete: current.complete },
    baseline: { workspace: baseline.workspace, model: baseline.model }, sameModel: current.model === baseline.model,
    downstreamCodeUnchanged: Object.fromEntries(downstreamFiles.map(f => [f, current.productionSha256[f] === baseline.productionSha256[f]])),
    methodology: 'Same frozen questions. Current and baseline final answers are graded anonymously in the same isolated answer-judge call when pairedGrade is true. Legacy grades remain visible for scoring-drift audit. All answerable questions remain in denominators, errors and missing judgments never count as correct. Memory retention judge does not see retrieval or answers and sees only formal content, never provenance quotes. Automatic same-model estimates; no independent human review. Prior 80 held-out questions are now fixed regression cases, not unseen blind evaluation.',
    summary, extraction: { before: extraction(baselineMatched), after: extraction(current) },
    usage: { beforeMatched: baselineMatched.receipts.reduce((n, r) => n + (r.usage?.total_tokens || 0), 0), after: current.usage, afterRequests: current.receipts.length }, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '..');
  const input = path.resolve(process.argv[2] || 'docs/memory-public-live-optimized-dev-results.json');
  const baseline = path.resolve(process.argv[3] || 'docs/memory-public-live-results.json');
  const output = path.resolve(process.argv[4] || input.replace(/-results\.json$/, '-comparison.json'));
  if (output === input || output === baseline) throw new Error('Comparison must not overwrite an input report');
  const comparison = comparePublicLive(await readPublicLiveReport(input), await readPublicLiveReport(baseline));
  await writeFile(output, JSON.stringify(comparison, null, 2));
  const lines = ['# 公开数据完整链路优化前后对比', '', comparison.methodology, '', '| 集合/入口 | 优化前完整正确 | 优化后完整正确 | 新增成功 | 退化 |', '|---|---:|---:|---:|---:|'];
  for (const [label, s] of Object.entries(comparison.summary).filter(([, s]) => s.cases)) lines.push(`| ${label} | ${s.beforeFullyCorrect.count}/${s.answerable} | ${s.afterFullyCorrect.count}/${s.answerable} | ${s.answerableChanges.new_success || 0} | ${s.answerableChanges.regression || 0} |`);
  lines.push('', '## 提取', '', '```json', JSON.stringify(comparison.extraction, null, 2), '```', '', '逐题变化、协议错误和使用量见同名JSON。');
  await writeFile(output.replace(/\.json$/, '.md'), lines.join('\n'));
  console.log(JSON.stringify({ output: path.relative(root, output), summary: comparison.summary, extraction: comparison.extraction }));
}
