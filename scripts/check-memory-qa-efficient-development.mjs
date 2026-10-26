import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { checkDevelopment } from './check-memory-public-development.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const questionsOf = report => report.documents.flatMap(p => p.questions.map(q => ({ ...q, paperId: p.id })));
export const qaEfficientThresholds = Object.freeze({ retainedYesOrPartial: 15, desktopComplete: 11, connectorComplete: 13,
  desktopReferencesSufficient: 15, connectorReferencesSufficient: 15, desktopCorrectAbstention: 1, connectorCorrectAbstention: 1,
  desktopPairedNetImprovement: 1, connectorPairedNetImprovement: 0, combinedPairedNetImprovement: 2,
  maxQaProtocolErrors: 0, maxSupplementProtocolFailures: 1, minQaTokenReductionFraction: 0.15, maxCombinedQaTokens: 439346 });
const protocolCode = code => /GROUNDING|SCHEMA|CLAIM_BINDING|MODEL_(?:JSON|RESPONSE|OUTPUT|INCOMPLETE|TOOLS)/.test(code ?? '');

export function checkQaEfficientDevelopment(report, integrity, regression, registration, baseline) {
  const gate = checkDevelopment(report, integrity, regression);
  const add = (name, passed, actual, required) => gate.checks.push({ name, passed: !!passed, actual, required });
  add('qa_efficient_registered_thresholds', registration.version === 'memory-qa-efficient-preregistration-v1' && stable(registration.thresholds) === stable(qaEfficientThresholds), registration.thresholds, qaEfficientThresholds);
  add('registration_and_tests_before_development', [registration.registeredAt, regression.finishedAt, report.startedAt].every(t => Number.isFinite(Date.parse(t)))
    && Date.parse(registration.registeredAt) <= Date.parse(report.startedAt) && Date.parse(regression.finishedAt) <= Date.parse(report.startedAt),
  { registration: registration.registeredAt, tests: regression.finishedAt, live: report.startedAt }, 'registration and passing deterministic checks precede fresh development');
  add('registered_dataset_model_and_previous_baseline', report.datasetSha256 === registration.datasetSha256 && report.datasetSha256 === baseline.datasetSha256
    && report.model === baseline.model && !!report.baseline?.file && path.resolve(root, report.baseline.file) === path.resolve(root, registration.baselineDevelopment.file)
    && report.baseline.workspace === baseline.workspace && report.baseline.binarySha256 === baseline.binarySha256,
  report.baseline, 'same frozen dataset/model, paired exactly against the registered previous retrieval-dev-v2 artifact');
  const old = new Map(questionsOf(baseline).map(q => [q.id, q])), questions = questionsOf(report);
  add('same_twenty_development_questions', old.size === 20 && questions.length === 20 && new Set(questions.map(q => q.id)).size === 20 && questions.every(q => {
    const before = old.get(q.id); return before && q.paperId === before.paperId && q.question === before.question && q.answerable === before.answerable;
  }), questions.map(q => q.id), 'same 20 IDs, paper ownership, text and answerability');
  add('extraction_sources_unchanged', ['ai.rs', 'extraction_store.rs'].every(file => !!baseline.productionSha256?.[file]
    && report.productionSha256?.[file] === baseline.productionSha256[file]), report.productionSha256, 'extraction frozen; QA, target diversity/navigation, context assembly and output format may change');
  add('tested_source_binary_and_evaluation_match', report.evaluationUnchanged === true && stable(regression.productionSha256) === stable(report.productionSha256)
    && regression.binarySha256 === report.binarySha256 && !!regression.evaluationSha256 && stable(regression.evaluationSha256) === stable(report.evaluationSha256)
    && !!report.evaluationSha256?.['scripts/check-memory-qa-efficient-development.mjs'] && !!report.evaluationSha256?.['docs/memory-qa-efficient-preregistration.json'],
  { binary: report.binarySha256, evaluation: report.evaluationSha256 }, 'exact passing test source/binary/new-round evaluation manifest; unchanged during development');
  const judges = new Map(report.judgments.filter(j => !j.error).map(j => [j.id, j])), positive = questions.filter(q => q.answerable), negative = questions.filter(q => !q.answerable);
  let netTotal = 0;
  for (const entry of ['desktop', 'connector']) {
    const actualValid = q => !!q.entries?.[entry]?.result && !q.entries[entry].error;
    const correct = positive.filter(q => actualValid(q) && judges.get(q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    const paired = positive.filter(q => !old.get(q.id)?.entries?.[entry]?.error && judges.get(q.id)?.baselineEntries?.[entry]?.answerCorrect === 'yes').length;
    const reference = positive.filter(q => judges.get(q.id)?.entries?.[entry]?.retrievalSufficiency === 'yes').length;
    const abstain = negative.filter(q => actualValid(q) && judges.get(q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    const pairedCoverage = questions.filter(q => ['yes', 'partial', 'no', 'uncertain'].includes(judges.get(q.id)?.baselineEntries?.[entry]?.answerCorrect)).length;
    add(`${entry}_complete_answer_floor`, correct >= qaEfficientThresholds[`${entry}Complete`], correct, `>=${qaEfficientThresholds[`${entry}Complete`]}/19; previous original ${entry === 'desktop' ? 9 : 13}/19`);
    add(`${entry}_references_preserved`, reference >= qaEfficientThresholds[`${entry}ReferencesSufficient`], reference, '>=15/19; previous original 16/19');
    add(`${entry}_correct_refusal`, abstain === 1, abstain, '1/1; small-sample guard, not general refusal reliability');
    add(`${entry}_all_twenty_anonymously_paired`, pairedCoverage === 20, pairedCoverage, '20/20 paired previous/current answers');
    add(`${entry}_paired_correctness_guard`, correct - paired >= qaEfficientThresholds[`${entry}PairedNetImprovement`], { current: correct, previousPaired: paired, net: correct - paired },
      `net>=${qaEfficientThresholds[`${entry}PairedNetImprovement`]}`);
    netTotal += correct - paired;
  }
  add('combined_paired_improvement', netTotal >= 2, netTotal, '>=2 net additional correct entry-answers vs same-call paired baseline');
  const values = questions.flatMap(q => ['desktop', 'connector'].map(e => q.entries?.[e]));
  add('all_forty_production_entries', values.length === 40 && values.every(v => !!v && (!!v.result || !!v.error)), values.filter(Boolean).length, '40 real production entry results retained; no skipped questions');
  const protocolErrors = values.filter(v => v?.error && protocolCode(v.errorCode)).length;
  const supplementFailures = values.filter(v => protocolCode(v?.result?.queryTrace?.supplementStatus)).length;
  add('no_top_level_qa_protocol_errors', protocolErrors === 0, protocolErrors, '0; errors cannot lower token cost by avoiding valid answers');
  add('supplement_protocol_failures_not_worse', supplementFailures <= 1, supplementFailures, '<=1 previous-development supplemental binding/schema failure; safe fallbacks still counted');
  const qa = report.receipts.filter(r => r.phase === 'qa'), previousQa = baseline.receipts.filter(r => r.phase === 'qa');
  const completeUsage = qa.length > 0 && qa.every(r => Number.isFinite(r.usage?.total_tokens) && r.usage.total_tokens >= 0);
  const previousCompleteUsage = previousQa.length > 0 && previousQa.every(r => Number.isFinite(r.usage?.total_tokens) && r.usage.total_tokens >= 0);
  const tokens = qa.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0), previousTokens = previousQa.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0);
  add('qa_token_usage_complete', completeUsage && previousCompleteUsage, { requests: qa.length, currentComplete: completeUsage, baselineComplete: previousCompleteUsage }, 'actual provider usage for every QA request, including failed attempts; no zero-cost imputation');
  add('qa_cost_baseline_is_registered_previous_development', previousTokens === registration.qaCostBaseline?.combined && previousTokens === 516878,
    previousTokens, '516878 actual QA tokens from previous 20-question development run');
  add('combined_qa_tokens_at_least_fifteen_percent_lower', completeUsage && tokens <= 439346 && tokens <= Math.floor(previousTokens * .85),
    { previousTokens, currentTokens: tokens, reductionFraction: previousTokens ? 1 - tokens / previousTokens : null }, '<=439346 QA tokens, >=15% less than the same previous 20-question development baseline');
  const priorRequests = report.priorRun?.requests ?? 0, priorTokens = report.priorRun?.totalTokens ?? 0;
  const observedTokens = report.receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0), limits = registration.limits?.development;
  add('shared_registered_development_budget', Number.isSafeInteger(priorRequests) && priorRequests >= 0 && Number.isSafeInteger(priorTokens) && priorTokens >= 0
    && Number.isSafeInteger(report.limits?.requests) && Number.isSafeInteger(report.limits?.observedTotalTokens)
    && report.limits.requests + priorRequests <= limits?.maxRequests && report.limits.observedTotalTokens + priorTokens <= limits?.maxTokens
    && report.receipts.length + priorRequests <= limits?.maxRequests && observedTokens + priorTokens <= limits?.maxTokens,
  { currentRequests: report.receipts.length, priorRequests, currentTokens: observedTokens, priorTokens, declaredLimits: report.limits }, 'all current and declared prior pilot usage fits registered 600 requests / 3000000 tokens; no expanded replacement budget');
  gate.version = 'memory-qa-efficient-development-gate-v1'; gate.passed = gate.checks.every(c => c.passed); gate.evaluationSha256 = report.evaluationSha256;
  gate.registration = { registeredAt: registration.registeredAt, thresholds: registration.thresholds, baselineDevelopment: registration.baselineDevelopment };
  return gate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [reportFile, integrityFile, regressionFile, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: node check-memory-qa-efficient-development.mjs REPORT INTEGRITY REGRESSIONS OUTPUT');
  const bytes = await readFile(path.join(root, 'docs/memory-qa-efficient-preregistration.json')), registration = JSON.parse(bytes);
  const baselineFile = path.resolve(root, registration.baselineDevelopment.file);
  if (hash(await readFile(baselineFile)) !== registration.baselineDevelopment.sha256) throw new Error('Previous development baseline fingerprint changed');
  const result = checkQaEfficientDevelopment(await readPublicLiveReport(path.resolve(reportFile)), JSON.parse(await readFile(integrityFile)), JSON.parse(await readFile(regressionFile)), registration, await readPublicLiveReport(baselineFile));
  result.report = path.relative(root, path.resolve(reportFile)); result.registration.sha256 = hash(bytes);
  await writeFile(outputFile, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
