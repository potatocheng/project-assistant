// Offline, syntax-only recovery. Never submits a model request or changes a grade.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPublicLiveReport, savePublicLiveReport } from './memory-public-live-io.mjs';
import { isolatedJudgeTasks, combineIsolatedJudgments, parseIsolatedJudgeResponse } from './memory-public-live-judges.mjs';
import { isJudgeProtocolFailure } from './memory-public-live-options.mjs';
const root = path.resolve(import.meta.dirname, '..');
const input = process.argv[2];
if (!input) throw new Error('Usage: node recover-memory-public-judge-json.mjs REPORT');
const report = await readPublicLiveReport(path.resolve(input));
if (report.haltReason || report.fatalError || !report.documents.every(d => d.complete)) throw new Error('Production must be complete without a transport or budget failure');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
const bytes = await readFile(path.resolve(root, manifest.fixture));
if (createHash('sha256').update(bytes).digest('hex') !== report.datasetSha256) throw new Error('Frozen fixture mismatch');
const fixture = JSON.parse(bytes), baseline = await readPublicLiveReport(path.resolve(root, report.baseline.file));
const raw = (await readFile(path.join(root, report.workspace, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const recovered = [];
for (let index = 0; index < report.judgments.length; index++) {
  const previous = report.judgments[index];
  if (!previous.error) continue;
  const paper = report.documents.find(d => d.id === previous.paperId);
  const doc = fixture.documents.find(d => d.id === previous.paperId);
  const question = doc.queries.find(q => q.id === previous.id);
  const tasks = isolatedJudgeTasks({ doc, paper, question, actual: paper.questions.find(q => q.id === question.id),
    baselineActual: baseline.documents.find(d => d.id === doc.id).questions.find(q => q.id === question.id), mode: report.judgeMode });
  const values = structuredClone(previous.stages);
  for (const task of tasks) {
    if (!values[task.phase]?.error) continue;
    if (!isJudgeProtocolFailure(values[task.phase])) throw new Error('Only judge syntax/schema failures may be examined');
    if (report.evaluationSyntaxRepairs?.some(r => r.questionId === question.id && r.phase === task.phase)) throw new Error('Syntax recovery already recorded for this phase');
    const receipt = raw.filter(r => r.questionId === question.id && r.judgeStage === task.phase && previous.receiptIds.includes(r.index)).at(-1);
    if (!receipt) throw new Error('Missing original judge receipt');
    const text = JSON.parse(receipt.responseText).choices[0].message.content;
    const parsed = parseIsolatedJudgeResponse(text, task, new Set(paper.memories.map(m => m.id)), receipt.finishReason);
    if (!parsed.repair) throw new Error('Failure cannot be recovered by appending exactly one terminal object brace');
    values[task.phase] = parsed.value;
    const event = { questionId: question.id, paperId: doc.id, phase: task.phase, receiptId: receipt.index,
      recoveredAt: new Date().toISOString(), ...parsed.repair, previousJudgment: structuredClone(previous), modelRequests: 0 };
    (report.evaluationSyntaxRepairs ||= []).push(event); recovered.push({ questionId: question.id, phase: task.phase, receiptId: receipt.index, kind: parsed.repair.kind });
  }
  const { error, ...unchanged } = previous;
  report.judgments[index] = { ...unchanged, ...combineIsolatedJudgments(tasks, values) };
}
if (!recovered.length) throw new Error('No recoverable failed judge phase');
report.complete = report.documents.every(d => d.complete) && report.judgments.length === report.expectedQuestions && report.judgments.every(j => !j.error);
report.scoringRecoveredAt = new Date().toISOString();
const serialized = JSON.stringify(report);
if (process.env.DEEPSEEK_API_KEY && serialized.includes(process.env.DEEPSEEK_API_KEY)) throw new Error('Credential guard');
await writeFile(path.join(root, report.workspace, 'progress.json'), serialized);
await savePublicLiveReport(report);
console.log(JSON.stringify({ complete: report.complete, recovered, modelRequests: 0, totalRequests: report.receipts.length, totalTokens: report.usage.total_tokens }));
if (!report.complete) process.exitCode = 1;
