// Retrieval-round gate: registered before model calls, never fit to new scores.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { checkDevelopment } from './check-memory-public-development.mjs';

const root = path.resolve(import.meta.dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const retrievalThresholds = Object.freeze({ retainedYesOrPartial: 15, desktopComplete: 9, connectorComplete: 9,
  desktopReferencesSufficient: 11, connectorReferencesSufficient: 9, desktopCorrectAbstention: 1, connectorCorrectAbstention: 1,
  desktopPairedNetImprovement: 1, connectorPairedNetImprovement: 1 });
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const questionsOf = report => (report.documents ?? []).flatMap(p => (p.questions ?? []).map(q => ({ ...q, paperId: p.id })));

export function checkRetrievalDevelopment(report, integrity, regression, registration, baseline) {
  const gate = checkDevelopment(report, integrity, regression);
  const add = (name, passed, actual, required) => gate.checks.push({ name, passed: !!passed, actual, required });
  add('pre_registered_thresholds', registration.version === 'memory-retrieval-preregistration-v1' && stable(registration.thresholds) === stable(retrievalThresholds), registration.thresholds, retrievalThresholds);
  const timing = [registration.registeredAt, regression.finishedAt, report.startedAt].map(Date.parse);
  add('registration_and_tests_precede_live_run', timing.every(Number.isFinite) && timing[0] <= timing[2] && timing[1] <= timing[2],
    { registeredAt: registration.registeredAt, testsFinishedAt: regression.finishedAt, liveStartedAt: report.startedAt }, 'registration and successful deterministic checks before live development starts');
  add('same_frozen_dataset_and_model', report.datasetSha256 === registration.datasetSha256 && report.datasetSha256 === baseline.datasetSha256 && report.model === baseline.model,
    { datasetSha256: report.datasetSha256, model: report.model }, 'same frozen dataset fingerprint and generating model as previous round');
  add('paired_baseline_is_previous_development', !!report.baseline?.file && path.resolve(root, report.baseline.file) === path.resolve(root, registration.baselineDevelopment.file)
      && report.baseline.workspace === baseline.workspace && report.baseline.binarySha256 === baseline.binarySha256,
    report.baseline, 'anonymous paired baseline is exactly the registered previous optimized development artifact, workspace and binary');
  const oldQuestions = new Map(questionsOf(baseline).map(q => [q.id, q]));
  const questions = questionsOf(report);
  add('same_development_questions', oldQuestions.size === 20 && questions.length === 20 && new Set(questions.map(q => q.id)).size === 20 && questions.every(q => {
    const old = oldQuestions.get(q.id); return old && old.paperId === q.paperId && old.question === q.question && old.answerable === q.answerable;
  }), questions.map(q => q.id), 'exactly the previous 20 development question IDs, texts, answerability and paper ownership');
  const extractionFiles = ['ai.rs', 'extraction_store.rs'];
  add('extraction_implementation_unchanged', extractionFiles.every(f => !!baseline.productionSha256?.[f] && report.productionSha256?.[f] === baseline.productionSha256[f]),
    Object.fromEntries(extractionFiles.map(f => [f, report.productionSha256?.[f]])), 'same extraction prompt/budget/core and persistence implementation hashes as previous round');
  const testsMatch = !!regression.productionSha256 && stable(regression.productionSha256) === stable(report.productionSha256) && regression.binarySha256 === report.binarySha256;
  add('tested_source_and_binary_match', testsMatch, { sourceMatch: stable(regression.productionSha256) === stable(report.productionSha256), binaryMatch: regression.binarySha256 === report.binarySha256 }, 'successful deterministic evidence fingerprints exactly this live source and binary');
  add('tested_evaluation_rules_match', !!regression.evaluationSha256 && report.evaluationUnchanged === true && stable(regression.evaluationSha256) === stable(report.evaluationSha256),
    report.evaluationSha256, 'same pre-registration, harness, judge, scorer and gate fingerprints as deterministic checks; unchanged during live run');
  const judgments = new Map((report.judgments ?? []).filter(j => !j.error).map(j => [j.id, j]));
  const positive = questions.filter(q => q.answerable), negative = questions.filter(q => !q.answerable);
  for (const entry of ['desktop', 'connector']) {
    const valid = q => !q.entries?.[entry]?.error && !!q.entries?.[entry];
    const fullyCorrect = positive.filter(q => valid(q) && judgments.get(q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    const referencesSufficient = positive.filter(q => valid(q) && judgments.get(q.id)?.entries?.[entry]?.retrievalSufficiency === 'yes').length;
    const abstention = negative.filter(q => valid(q) && judgments.get(q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    const pairedCoverage = questions.filter(q => ['yes', 'partial', 'no', 'uncertain'].includes(judgments.get(q.id)?.baselineEntries?.[entry]?.answerCorrect)).length;
    const oldPairedCorrect = positive.filter(q => !oldQuestions.get(q.id)?.entries?.[entry]?.error && judgments.get(q.id)?.baselineEntries?.[entry]?.answerCorrect === 'yes').length;
    add(`${entry}_improved_complete_answers`, fullyCorrect >= retrievalThresholds[`${entry}Complete`], fullyCorrect, `at least ${retrievalThresholds[`${entry}Complete`]}/19; previous original score 7/19`);
    add(`${entry}_improved_reference_sufficiency`, referencesSufficient >= retrievalThresholds[`${entry}ReferencesSufficient`], referencesSufficient, `at least ${retrievalThresholds[`${entry}ReferencesSufficient`]}/19; previous original ${entry === 'desktop' ? 9 : 7}/19`);
    add(`${entry}_refusal_regression_guard`, abstention === retrievalThresholds[`${entry}CorrectAbstention`], abstention, '1/1; small-sample regression guard only');
    add(`${entry}_all_answers_paired`, pairedCoverage === 20, pairedCoverage, '20/20 current and previous answers graded anonymously together; original baseline grades also retained');
    add(`${entry}_paired_net_improvement`, fullyCorrect - oldPairedCorrect >= retrievalThresholds[`${entry}PairedNetImprovement`],
      { newComplete: fullyCorrect, pairedPreviousComplete: oldPairedCorrect, netImprovement: fullyCorrect - oldPairedCorrect }, 'at least one net additional fully correct answer vs same-call paired previous baseline; errors never count as correct');
  }
  gate.version = 'memory-retrieval-development-gate-v1';
  gate.evaluationSha256 = report.evaluationSha256;
  gate.passed = gate.checks.every(c => c.passed);
  gate.registration = { registeredAt: registration.registeredAt, thresholds: registration.thresholds, baselineDevelopment: registration.baselineDevelopment };
  return gate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [reportFile, integrityFile, regressionFile, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: node check-memory-retrieval-development.mjs REPORT INTEGRITY REGRESSION OUTPUT');
  const registrationFile = path.join(root, 'docs/memory-retrieval-preregistration.json');
  const registrationBytes = await readFile(registrationFile);
  const registration = JSON.parse(registrationBytes);
  const baselineFile = path.resolve(root, registration.baselineDevelopment.file);
  if (digest(await readFile(baselineFile)) !== registration.baselineDevelopment.sha256) throw new Error('Frozen previous development artifact changed');
  const result = checkRetrievalDevelopment(await readPublicLiveReport(path.resolve(reportFile)), JSON.parse(await readFile(integrityFile)), JSON.parse(await readFile(regressionFile)), registration, await readPublicLiveReport(baselineFile));
  result.report = path.relative(root, path.resolve(reportFile));
  result.registration.sha256 = digest(registrationBytes);
  // Gate provenance is immutable. A failed pilot must use a new output filename.
  await writeFile(outputFile, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
