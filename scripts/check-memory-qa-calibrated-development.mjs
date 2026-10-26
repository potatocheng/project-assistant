import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { checkDevelopment } from './check-memory-public-development.mjs';
import { verifyRecordedBudget, budgetCanonical, budgetHash } from './memory-public-live-budget.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const questionsOf = report => report.documents.flatMap(p => p.questions.map(q => ({ ...q, paperId: p.id })));
export const qaCalibratedThresholds = Object.freeze({"retainedYesOrPartial":18,"desktopComplete":13,"connectorComplete":14,"desktopReferencesSufficient":16,"connectorReferencesSufficient":16,"desktopCorrectAbstention":1,"connectorCorrectAbstention":1,"desktopPairedNetImprovement":0,"connectorPairedNetImprovement":0,"combinedPairedNetImprovement":1,"maxQaProtocolErrors":0,"maxSupplementProtocolFailures":0,"maxQaTokenGrowthFraction":0.1,"maxCombinedQaTokens":288410});
const protocolCode = code => /GROUNDING|SCHEMA|CLAIM_BINDING|MODEL_(?:JSON|RESPONSE|OUTPUT|INCOMPLETE|TOOLS)/.test(code ?? '');

export function checkQaCalibratedDevelopment(report, integrity, regression, registration, baseline, budgetEvidence = null) {
  const gate = checkDevelopment(report, integrity, regression);
  const add = (name, passed, actual, required) => gate.checks.push({ name, passed: !!passed, actual, required });
  add('qa_calibrated_registered_thresholds', registration.version === 'memory-qa-calibrated-preregistration-v1' && stable(registration.thresholds) === stable(qaCalibratedThresholds), registration.thresholds, qaCalibratedThresholds);
  add('registration_and_tests_before_development', [registration.registeredAt, regression.finishedAt, report.startedAt].every(t => Number.isFinite(Date.parse(t)))
    && Date.parse(registration.registeredAt) <= Date.parse(report.startedAt) && Date.parse(regression.finishedAt) <= Date.parse(report.startedAt),
  { registration: registration.registeredAt, tests: regression.finishedAt, live: report.startedAt }, 'registration and passing deterministic checks precede fresh development');
  add('registered_dataset_model_and_previous_baseline', report.datasetSha256 === registration.datasetSha256 && report.datasetSha256 === baseline.datasetSha256
    && report.model === baseline.model && report.model === registration.model && !!report.baseline?.file && path.resolve(root, report.baseline.file) === path.resolve(root, registration.baselineDevelopment.file)
    && report.baseline.workspace === baseline.workspace && report.baseline.binarySha256 === baseline.binarySha256,
  report.baseline, 'same frozen dataset/model, paired exactly against the registered previous qa-efficient-dev-v2 artifact');
  const old = new Map(questionsOf(baseline).map(q => [q.id, q])), questions = questionsOf(report);
  add('same_twenty_development_questions', old.size === 20 && questions.length === 20 && new Set(questions.map(q => q.id)).size === 20 && questions.every(q => {
    const before = old.get(q.id); return before && q.paperId === before.paperId && q.question === before.question && q.answerable === before.answerable;
  }), questions.map(q => q.id), 'same 20 IDs, paper ownership, text and answerability');
  add('extraction_sources_unchanged', ['ai.rs', 'extraction_store.rs'].every(file => !!baseline.productionSha256?.[file]
    && report.productionSha256?.[file] === baseline.productionSha256[file]), report.productionSha256, 'extraction frozen; QA, target diversity/navigation, context assembly and output format may change');
  add('tested_source_binary_and_evaluation_match', report.evaluationUnchanged === true && stable(regression.productionSha256) === stable(report.productionSha256)
    && regression.binarySha256 === report.binarySha256 && !!regression.evaluationSha256 && stable(regression.evaluationSha256) === stable(report.evaluationSha256)
    && !!report.evaluationSha256?.['scripts/check-memory-qa-calibrated-development.mjs'] && !!report.evaluationSha256?.['docs/memory-qa-calibrated-preregistration.json'],
  { binary: report.binarySha256, evaluation: report.evaluationSha256 }, 'exact passing test source/binary/new-round evaluation manifest; unchanged during development');
  const judges = new Map(report.judgments.filter(j => !j.error).map(j => [j.id, j])), positive = questions.filter(q => q.answerable), negative = questions.filter(q => !q.answerable);
  const retained = positive.filter(q => ['yes', 'partial'].includes(judges.get(q.id)?.memorySufficiency)).length;
  add('retained_memory_floor', retained >= 18, retained, '>=18/19 answerable memory content yes or partial');
  let netTotal = 0;
  for (const entry of ['desktop', 'connector']) {
    const actualValid = q => !!q.entries?.[entry]?.result && !q.entries[entry].error;
    const correct = positive.filter(q => actualValid(q) && judges.get(q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    const paired = positive.filter(q => !old.get(q.id)?.entries?.[entry]?.error && judges.get(q.id)?.baselineEntries?.[entry]?.answerCorrect === 'yes').length;
    const reference = positive.filter(q => judges.get(q.id)?.entries?.[entry]?.retrievalSufficiency === 'yes').length;
    const abstain = negative.filter(q => actualValid(q) && judges.get(q.id)?.entries?.[entry]?.answerCorrect === 'yes').length;
    const pairedCoverage = questions.filter(q => ['yes', 'partial', 'no', 'uncertain'].includes(judges.get(q.id)?.baselineEntries?.[entry]?.answerCorrect)).length;
    add(`${entry}_complete_answer_floor`, correct >= qaCalibratedThresholds[`${entry}Complete`], correct, `>=${qaCalibratedThresholds[`${entry}Complete`]}/19; previous original ${entry === 'desktop' ? 13 : 14}/19`);
    add(`${entry}_references_preserved`, reference >= qaCalibratedThresholds[`${entry}ReferencesSufficient`], reference, '>=16/19; previous original 16/19');
    add(`${entry}_correct_refusal`, abstain === 1, abstain, '1/1; small-sample guard, not general refusal reliability');
    add(`${entry}_all_twenty_anonymously_paired`, pairedCoverage === 20, pairedCoverage, '20/20 paired previous/current answers');
    add(`${entry}_paired_correctness_guard`, correct - paired >= qaCalibratedThresholds[`${entry}PairedNetImprovement`], { current: correct, previousPaired: paired, net: correct - paired },
      `net>=${qaCalibratedThresholds[`${entry}PairedNetImprovement`]}`);
    netTotal += correct - paired;
  }
  add('combined_paired_improvement', netTotal >= 1, netTotal, '>=1 net additional correct entry-answers vs same-call paired baseline');
  const values = questions.flatMap(q => ['desktop', 'connector'].map(e => q.entries?.[e]));
  add('all_forty_production_entries', values.length === 40 && values.every(v => !!v && (!!v.result || !!v.error)), values.filter(Boolean).length, '40 real production entry results retained; no skipped questions');
  add('registered_production_caps_observed', values.every(value => {
    const trace = value?.result?.queryTrace;
    return trace?.maxModelCalls === 5 && trace.maxInputChars === 180000 && trace.focusedContextMaxReferences === 24
      && trace.focusedContextMaxModelChars === 36000 && Number.isSafeInteger(trace.modelCalls) && trace.modelCalls >= 0 && trace.modelCalls <= 5
      && Number.isSafeInteger(trace.inputChars) && trace.inputChars >= 0 && trace.inputChars <= 180000;
  }), values.map(value => value?.result?.queryTrace ?? null), 'all40 real traces:5calls/180000inputchars/24references/36000referencechars; actual consumption within limits');
  const protocolErrors = values.filter(v => v?.error && protocolCode(v.errorCode)).length;
  const reviewFailures = values.filter(value => value?.result?.queryTrace?.reviews?.some(review => review?.status === 'unavailable' && protocolCode(review.errorCode)));
  const supplementFailures = values.filter(value => {
    const trace = value?.result?.queryTrace;
    return protocolCode(trace?.supplementStatus) || trace?.reviews?.some((review, round) => round >= 1
      && review?.status === 'unavailable' && protocolCode(review.errorCode));
  }).length;
  add('no_top_level_qa_protocol_errors', protocolErrors === 0, protocolErrors, '0; errors cannot lower token cost by avoiding valid answers');
  add('no_review_protocol_failures', reviewFailures.length === 0, reviewFailures.length,
    '0 entries with unavailable protocol/schema/JSON review in any retrieval round, including safe fallbacks');
  add('supplement_protocol_failures_not_worse', supplementFailures === 0, supplementFailures, '0 supplemental binding/schema/protocol failures; safe fallbacks still counted');
  const qa = report.receipts.filter(r => r.phase === 'qa'), previousQa = baseline.receipts.filter(r => r.phase === 'qa');
  const completeUsage = qa.length > 0 && qa.every(r => Number.isFinite(r.usage?.total_tokens) && r.usage.total_tokens >= 0);
  const previousCompleteUsage = previousQa.length > 0 && previousQa.every(r => Number.isFinite(r.usage?.total_tokens) && r.usage.total_tokens >= 0);
  const tokens = qa.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0), previousTokens = previousQa.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0);
  add('qa_token_usage_complete', completeUsage && previousCompleteUsage, { requests: qa.length, currentComplete: completeUsage, baselineComplete: previousCompleteUsage }, 'actual provider usage for every QA request, including failed attempts; no zero-cost imputation');
  add('qa_cost_baseline_is_registered_previous_development', previousTokens === registration.qaCostBaseline?.combined && previousTokens === 262191,
    previousTokens, '262191 actual QA tokens from previous 20-question development run');
  add('combined_qa_tokens_within_ten_percent_growth', completeUsage && tokens <= 288410 && tokens <= Math.floor(previousTokens * 1.10),
    { previousTokens, currentTokens: tokens, reductionFraction: previousTokens ? 1 - tokens / previousTokens : null }, '<=288410 QA tokens, <=10% above the same previous 20-question development baseline');
  const authorization = budgetEvidence?.authorization;
  const recordedLedger = report.priorBudgetLedger;
  add('cumulative_prior_ledger_verified', !recordedLedger && !(report.priorRun && report.evaluationSha256?.['scripts/memory-public-live-budget.mjs'])
    || !!recordedLedger && !!budgetEvidence?.ledger && stable(recordedLedger) === stable(budgetEvidence.ledger),
    recordedLedger ?? null, 'every prior workspace/compact/detail/transcript/provider usage recursively verified without omission or duplicate billing');
  add('original_budget_registration_unchanged', stable(registration.limits?.development) === stable({ maxRequests: 600, maxTokens: 3000000 }),
    registration.limits?.development, 'original600requests/3000000tokens registration remains immutable');
  if (report.budgetAuthorization) add('one_time_budget_extension_registered_before_tests_and_live', !!authorization
    && stable(report.budgetAuthorization) === stable(authorization) && !!recordedLedger
    && authorization.baseRegistrationSha256 === report.evaluationSha256?.['docs/memory-qa-calibrated-preregistration.json']
    && authorization.baseThresholdsSha256 === budgetHash(budgetCanonical(registration.thresholds))
    && authorization.sha256 === report.evaluationSha256?.['docs/memory-qa-calibrated-budget-addendum-1.json']
    && !!report.evaluationSha256?.['scripts/memory-public-live-budget.mjs']
    && Date.parse(authorization.registeredAt) <= Date.parse(regression.finishedAt) && Date.parse(authorization.registeredAt) < Date.parse(report.startedAt),
  report.budgetAuthorization, 'same original quality thresholds; unique900requests/4500000tokens addendum and full verified prior chain frozen before new tests/live');
  else add('no_undeclared_budget_extension', !authorization, authorization ?? null, 'no hidden budget authorization');
  const priorRequests = recordedLedger?.requests ?? report.priorRun?.requests ?? 0, priorTokens = recordedLedger?.totalTokens ?? report.priorRun?.totalTokens ?? 0;
  const observedTokens = report.receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0), limits = authorization?.effectiveDevelopmentLimits ?? registration.limits?.development;
  add('shared_registered_development_budget', Number.isSafeInteger(priorRequests) && priorRequests >= 0 && Number.isSafeInteger(priorTokens) && priorTokens >= 0
    && Number.isSafeInteger(report.limits?.requests) && Number.isSafeInteger(report.limits?.observedTotalTokens)
    && report.limits.requests + priorRequests <= limits?.maxRequests && report.limits.observedTotalTokens + priorTokens <= limits?.maxTokens
    && report.receipts.length + priorRequests <= limits?.maxRequests && observedTokens + priorTokens <= limits?.maxTokens,
  { currentRequests: report.receipts.length, priorRequests, currentTokens: observedTokens, priorTokens, declaredLimits: report.limits, effectiveTotalLimits: limits },
  `all current plus every cumulative prior provider cost fits authorized ${limits?.maxRequests} requests / ${limits?.maxTokens} tokens; no reset`);
  gate.version = 'memory-qa-calibrated-development-gate-v1'; gate.passed = gate.checks.every(c => c.passed); gate.evaluationSha256 = report.evaluationSha256;
  gate.registration = { registeredAt: registration.registeredAt, thresholds: registration.thresholds, baselineDevelopment: registration.baselineDevelopment };
  if (authorization) { gate.budgetAuthorization = authorization; gate.priorBudgetLedger = recordedLedger; }
  return gate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [reportFile, integrityFile, regressionFile, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: node check-memory-qa-calibrated-development.mjs REPORT INTEGRITY REGRESSIONS OUTPUT');
  const bytes = await readFile(path.join(root, 'docs/memory-qa-calibrated-preregistration.json')), registration = JSON.parse(bytes);
  const baselineFile = path.resolve(root, registration.baselineDevelopment.file);
  if (hash(await readFile(baselineFile)) !== registration.baselineDevelopment.sha256) throw new Error('Previous development baseline fingerprint changed');
  const report = await readPublicLiveReport(path.resolve(reportFile));
  const result = checkQaCalibratedDevelopment(report, JSON.parse(await readFile(integrityFile)), JSON.parse(await readFile(regressionFile)), registration,
    await readPublicLiveReport(baselineFile), await verifyRecordedBudget(root, report));
  result.report = path.relative(root, path.resolve(reportFile)); result.registration.sha256 = hash(bytes);
  await writeFile(outputFile, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
