// Pre-registered development gate. No model calls and no threshold selection
// based on observed development answers. A pass is not independent human QA.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';

export function checkDevelopment(report, integrity, regression) {
  const papers = report.documents ?? [];
  const questions = papers.flatMap(p => p.questions ?? []);
  const positive = questions.filter(q => q.answerable);
  const negative = questions.filter(q => !q.answerable);
  const judgments = report.judgments ?? [];
  const checks = [];
  const check = (name, passed, actual, required) => checks.push({ name, passed: !!passed, actual, required });
  check('frozen_development_scope', papers.length === 6 && questions.length === 20 && positive.length === 19 && negative.length === 1 && papers.every(p => p.split === 'development'),
    { papers: papers.length, questions: questions.length, answerable: positive.length, unanswerable: negative.length }, '6 development papers / 20 questions / 19 answerable / 1 unanswerable');
  check('complete_run', report.complete && !report.haltReason && !report.fatalError, { complete: report.complete, haltReason: report.haltReason, fatalError: report.fatalError }, 'complete without halted budget/network or harness failure');
  const completed = papers.filter(p => p.extraction?.job?.status === 'succeeded').length;
  check('extraction_jobs_completed', completed === 6 && papers.every(p => !p.harnessError), completed, '6/6 succeeded; no unrecovered truncation or harness error');
  check('nonempty_confirmed_memory_per_paper', papers.every(p => p.memories?.length > 0), papers.map(p => ({ id: p.id, memories: p.memories?.length ?? 0 })), 'at least one actual extracted formal memory in every paper');
  const verificationPassed = integrity.results?.length > 0 && integrity.results.every(r => r.passed);
  check('integrity_verified', verificationPassed, integrity.results?.map(r => ({ file: r.file, passed: r.passed })) ?? [], 'source/binary/data hashes; source quotes; confirmation/facet/scope/gold isolation checks all pass');
  check('deterministic_regressions_passed', regression.passed === true && regression.commands?.length > 0 && regression.commands.every(c => c.exitCode === 0), regression.commands ?? [], 'all recorded test/build/lint/process-proof commands exited 0');
  const scoped = questions.flatMap(q => Object.values(q.entries ?? {})).filter(v => v.scopeViolation).length;
  check('no_cross_project_citations', scoped === 0, scoped, 0);
  const validJudgments = judgments.filter(j => !j.error && j.memorySufficiency && j.entries?.desktop && j.entries?.connector);
  check('all_isolated_judgments_available', judgments.length === 20 && validJudgments.length === 20 && new Set(judgments.map(j => j.id)).size === 20, validJudgments.length, '20/20; same-model automatic estimates, not independent human review');
  const relevant = validJudgments.filter(j => positive.some(q => q.id === j.id));
  const retained = relevant.filter(j => ['yes', 'partial'].includes(j.memorySufficiency)).length;
  check('question_information_retained', retained >= 15, retained, 'at least 15/19 yes or partial from isolated memory-only evaluation; citation provenance alone does not count');
  for (const entry of ['desktop', 'connector']) {
    const correct = positive.filter(q => !q.entries?.[entry]?.error && validJudgments.find(j => j.id === q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    check(`${entry}_complete_answers`, correct >= 5, correct, 'at least 5/19 (ceil(70% of previous 7/19 paragraph control))');
    const refused = negative.filter(q => !q.entries?.[entry]?.error && validJudgments.find(j => j.id === q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    check(`${entry}_correct_abstention`, refused === 1, refused, '1/1; limited sample, not a general abstention accuracy claim');
  }
  return { version: 'memory-development-gate-v1', passed: checks.every(c => c.passed),
    recordedAt: new Date().toISOString(), datasetSha256: report.datasetSha256, workspace: report.workspace,
    productionSha256: report.productionSha256, binarySha256: report.binarySha256,
    methodology: 'Thresholds registered before live development execution. Integrity plus regression evidence is mandatory. Semantic scores use isolated contexts but the same model and remain provisional.', checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [reportFile, integrityFile, regressionFile, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: node check-memory-public-development.mjs REPORT INTEGRITY REGRESSION OUTPUT');
  const result = checkDevelopment(await readPublicLiveReport(path.resolve(reportFile)), JSON.parse(await readFile(integrityFile)), JSON.parse(await readFile(regressionFile)));
  result.report = path.relative(path.resolve(import.meta.dirname, '..'), path.resolve(reportFile));
  await writeFile(outputFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
