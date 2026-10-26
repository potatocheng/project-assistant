import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { checkDevelopment } from './check-memory-public-development.mjs';
import { verifyQaStructuredRecordedBudget } from './memory-qa-structured-budget.mjs';
import { targetedReviewMappings, targetedSupplementProtocolFailure } from './memory-qa-structured-review-mapping.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const questionsOf = report => report.documents.flatMap(p => p.questions.map(q => ({ ...q, paperId: p.id })));
export const qaStructuredThresholds = Object.freeze({"retainedYesOrPartial":18,"desktopComplete":14,"connectorComplete":16,"desktopReferencesSufficient":17,"connectorReferencesSufficient":17,"desktopCorrectAbstention":1,"connectorCorrectAbstention":1,"desktopPairedNetImprovement":0,"connectorPairedNetImprovement":0,"combinedPairedNetImprovement":1,"maxQaProtocolErrors":0,"maxSupplementProtocolFailures":0,"maxQaTokenGrowthFraction":0.1,"maxCombinedQaTokens":288410});
const protocolCode = code => /SEARCH_PLAN|CONTEXT_SELECTION|GROUNDING|SCHEMA|CLAIM_BINDING|MODEL_(?:JSON|RESPONSE|OUTPUT|INCOMPLETE|TOOLS)/.test(code ?? '');

export function checkQaStructuredDevelopment(report, integrity, regression, registration, baseline, costReference, budgetEvidence = null) {
  const gate = checkDevelopment(report, integrity, regression);
  const add = (name, passed, actual, required) => gate.checks.push({ name, passed: !!passed, actual, required });
  add('qa_targeted_registered_thresholds', registration.version === 'memory-qa-structured-preregistration-v1' && stable(registration.thresholds) === stable(qaStructuredThresholds), registration.thresholds, qaStructuredThresholds);
  add('registration_and_tests_before_development', [registration.registeredAt, regression.finishedAt, report.startedAt].every(t => Number.isFinite(Date.parse(t)))
    && Date.parse(registration.registeredAt) <= Date.parse(report.startedAt) && Date.parse(regression.finishedAt) <= Date.parse(report.startedAt),
  { registration: registration.registeredAt, tests: regression.finishedAt, live: report.startedAt }, 'registration and passing deterministic checks precede fresh development');
  add('registered_dataset_model_and_previous_baseline', report.datasetSha256 === registration.datasetSha256 && report.datasetSha256 === baseline.datasetSha256
    && report.model === baseline.model && report.model === registration.model && !!report.baseline?.file && path.resolve(root, report.baseline.file) === path.resolve(root, registration.baselineDevelopment.file)
    && report.baseline.workspace === baseline.workspace && report.baseline.binarySha256 === baseline.binarySha256,
  report.baseline, 'same frozen dataset/model, paired exactly against the registered previous qa-targeted-dev-v4 quality artifact');
  const old = new Map(questionsOf(baseline).map(q => [q.id, q])), questions = questionsOf(report);
  add('same_twenty_development_questions', old.size === 20 && questions.length === 20 && new Set(questions.map(q => q.id)).size === 20 && questions.every(q => {
    const before = old.get(q.id); return before && q.paperId === before.paperId && q.question === before.question && q.answerable === before.answerable;
  }), questions.map(q => q.id), 'same 20 IDs, paper ownership, text and answerability');
  add('production_full_pipeline_and_separated_judges', report.paragraphControl === false && !report.diagnostic && report.judgeMode === 'separated'
    && ['answer', 'memory', 'retrieval'].every(stage => {
      const receipts = report.receipts.filter(r => r.phase === 'judge' && r.judgeStage === stage);
      const repaired = (report.evaluationRepairs ?? []).filter(repair => repair.phases?.includes(stage)).length;
      return receipts.length === 20 + repaired && new Set(receipts.map(receipt => receipt.questionId)).size === 20
        && questions.every(question => receipts.filter(receipt => receipt.questionId === question.id).length === 1
          + (report.evaluationRepairs ?? []).filter(repair => repair.questionId === question.id && repair.phases?.includes(stage)).length);
    }),
    { paragraphControl: report.paragraphControl, mode: report.judgeMode, stages: Object.fromEntries(['answer', 'memory', 'retrieval'].map(stage => [stage, report.receipts.filter(r => r.phase === 'judge' && r.judgeStage === stage).length])) },
    'fresh extraction, not paragraph control; all20 questions have answer/memory/retrieval calls; only explicitly journaled existing parser/schema judge repairs may add calls and all remain billed');
  add('grading_criteria_and_labels_unchanged', ['scripts/memory-public-live-judges.mjs', 'scripts/score-memory-public-live.mjs', 'scripts/compare-memory-public-live.mjs'].every(file => !!baseline.evaluationSha256?.[file]
    && report.evaluationSha256?.[file] === baseline.evaluationSha256[file]), report.evaluationSha256, 'old judge/scorer/compare source bytes unchanged; new structured adapter only selects actual producer contexts; frozen gold and labels unchanged');
  add('extraction_and_retrieval_sources_unchanged', ['ai.rs', 'extraction_store.rs'].every(file => !!baseline.productionSha256?.[file]
    && report.productionSha256?.[file] === baseline.productionSha256[file]), report.productionSha256, 'extraction source unchanged; memory/query/target/controller/context organization may change without gold');
  add('tested_source_binary_and_evaluation_match', report.evaluationUnchanged === true && stable(regression.productionSha256) === stable(report.productionSha256)
    && regression.binarySha256 === report.binarySha256 && !!regression.evaluationSha256 && stable(regression.evaluationSha256) === stable(report.evaluationSha256)
    && !!report.evaluationSha256?.['scripts/check-memory-qa-structured-development.mjs'] && !!report.evaluationSha256?.['docs/memory-qa-structured-preregistration.json'],
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
    add(`${entry}_complete_answer_floor`, correct >= qaStructuredThresholds[`${entry}Complete`], correct, `>=${qaStructuredThresholds[`${entry}Complete`]}/19; previous original ${entry === 'desktop' ? 13 : 15}/19`);
    add(`${entry}_references_preserved`, reference >= qaStructuredThresholds[`${entry}ReferencesSufficient`], reference, '>=17/19; previous original 15/19; restoration target remains17/19');
    add(`${entry}_correct_refusal`, abstain === 1, abstain, '1/1; small-sample guard, not general refusal reliability');
    add(`${entry}_all_twenty_anonymously_paired`, pairedCoverage === 20, pairedCoverage, '20/20 paired previous/current answers');
    add(`${entry}_paired_correctness_guard`, correct - paired >= qaStructuredThresholds[`${entry}PairedNetImprovement`], { current: correct, previousPaired: paired, net: correct - paired },
      `net>=${qaStructuredThresholds[`${entry}PairedNetImprovement`]}`);
    netTotal += correct - paired;
  }
  add('combined_paired_improvement', netTotal >= 1, netTotal, '>=1 net additional correct entry-answers vs same-call paired baseline');
  const values = questions.flatMap(q => ['desktop', 'connector'].map(e => q.entries?.[e]));
  add('targeted_explicit_review_provenance', values.every(value => { try { targetedReviewMappings(value); return true; } catch { return false; } }),
    values.map(value => value?.result?.queryTrace?.reviewRounds ?? null), 'every review has explicit actual generation index and retrieval round; no rewrite-count inference');
  add('all_forty_production_entries', values.length === 40 && values.every(v => !!v && (!!v.result || !!v.error)), values.filter(Boolean).length, '40 real production entry results retained; no skipped questions');
  add('registered_production_caps_observed', values.every(value => {
    const trace = value?.result?.queryTrace;
    return trace?.maxModelCalls === 5 && trace.maxInputChars === 180000 && trace.focusedContextMaxReferences === 24
      && trace.focusedContextMaxModelChars === 36000 && Number.isSafeInteger(trace.modelCalls) && trace.modelCalls >= 0 && trace.modelCalls <= 5
      && Number.isSafeInteger(trace.inputChars) && trace.inputChars >= 0 && trace.inputChars <= 180000;
  }), values.map(value => value?.result?.queryTrace ?? null), 'all40 real traces:5calls/180000inputchars/24references/36000referencechars; actual consumption within limits');
  const protocolErrors = values.filter(v => v?.error && protocolCode(v.errorCode)).length;
  const reviewFailures = values.filter(value => value?.result?.queryTrace?.reviews?.some(review => review?.status === 'unavailable' && protocolCode(review.errorCode)));
  const supplementFailures = values.filter(value => { try { return targetedSupplementProtocolFailure(value); } catch { return true; } }).length;
  const plannerFailures = values.filter(v => v?.result?.queryTrace?.supplementStatus && protocolCode(v.result.queryTrace.supplementStatus)).length;
  add('no_planner_protocol_failures', plannerFailures === 0, plannerFailures, '0; malformed SEARCH_PLAN remains a failure even when fallback is safe');
  add('all_final_claim_provenance_verified', values.every(v => !v.result || (v.producerProvenance && !v.provenanceFailure)), values.map(v=>v.producerProvenance??v.provenanceFailure??null), 'every final claim maps to raw selected generation and actual provided support spans');
  add('no_top_level_qa_protocol_errors', protocolErrors === 0, protocolErrors, '0; errors cannot lower token cost by avoiding valid answers');
  add('no_review_protocol_failures', reviewFailures.length === 0, reviewFailures.length,
    '0 entries with unavailable protocol/schema/JSON review in any retrieval round, including safe fallbacks');
  add('supplement_protocol_failures_not_worse', supplementFailures === 0, supplementFailures, '0 supplemental binding/schema/protocol failures; safe fallbacks still counted');
  const qa = report.receipts.filter(r => r.phase === 'qa'), previousQa = costReference.receipts.filter(r => r.phase === 'qa');
  const completeUsage = qa.length > 0 && qa.every(r => Number.isFinite(r.usage?.total_tokens) && r.usage.total_tokens >= 0);
  const previousCompleteUsage = previousQa.length > 0 && previousQa.every(r => Number.isFinite(r.usage?.total_tokens) && r.usage.total_tokens >= 0);
  const tokens = qa.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0), previousTokens = previousQa.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0);
  add('qa_token_usage_complete', completeUsage && previousCompleteUsage, { requests: qa.length, currentComplete: completeUsage, baselineComplete: previousCompleteUsage }, 'actual provider usage for every QA request, including failed attempts; no zero-cost imputation');
  add('qa_cost_baseline_is_registered_previous_development', previousTokens === registration.costReferenceDevelopment?.combinedQaTokens && previousTokens === 262191,
    previousTokens, '262191 actual QA tokens from separately registered qa-efficient-dev-v2 cost reference');
  add('cost_reference_dataset_and_model_unchanged', costReference.datasetSha256 === registration.datasetSha256 && costReference.model === registration.model,
    { dataset: costReference.datasetSha256, model: costReference.model }, 'cost recovery compares identical20/model to separate qa-efficient-dev-v2 reference');
  add('combined_qa_tokens_within_ten_percent_growth', completeUsage && tokens <= 288410 && tokens <= Math.floor(previousTokens * 1.10),
    { previousTokens, currentTokens: tokens, reductionFraction: previousTokens ? 1 - tokens / previousTokens : null }, '<=288410 QA tokens, <=10% above the same previous 20-question development baseline');
  const recordedLedger = report.priorBudgetLedger;
  const priorRequests = recordedLedger?.requests ?? 0, priorTokens = recordedLedger?.totalTokens ?? 0;
  add("cumulative_prior_ledger_verified", !!budgetEvidence && stable(recordedLedger ?? null) === stable(budgetEvidence.ledger ?? null)
    && stable(report.budgetRegistration) === stable(budgetEvidence.budgetRegistration) && !!report.priorRun === !!recordedLedger,
    { ledger: recordedLedger ?? null, registration: report.budgetRegistration }, "independent targeted round; every prior current-round run recursively verified; no old addendum");
  add("independent_budget_registration_frozen", stable(registration.limits.development) === stable({ maxRequests: 1200, maxTokens: 6000000, maxFreshAttempts: 3, maxDiagnosticPairs: 1 })
    && !report.budgetAuthorization && report.budgetRegistration?.sha256 === report.evaluationSha256?.["docs/memory-qa-structured-preregistration.json"]
    && Date.parse(registration.registeredAt) <= Date.parse(regression.startedAt)
    && !!report.evaluationSha256?.["scripts/memory-qa-structured-budget.mjs"], report.budgetRegistration,
    "new1200requests/6M, max3 fresh20 plus one frozen-memory diagnostic pair attempts registered before tests/live; no automatic extension; old829requests/3652548tokens remain historical");
  const observedTokens = report.receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0), limits = registration.limits.development;
  add("shared_registered_development_budget", Number.isSafeInteger(priorRequests) && priorRequests >= 0 && Number.isSafeInteger(priorTokens) && priorTokens >= 0
    && Number.isSafeInteger(report.limits?.requests) && Number.isSafeInteger(report.limits?.observedTotalTokens)
    && report.limits.requests + priorRequests <= limits.maxRequests && report.limits.observedTotalTokens + priorTokens <= limits.maxTokens
    && report.receipts.length + priorRequests <= limits.maxRequests && observedTokens + priorTokens <= limits.maxTokens
    && (recordedLedger?.entries.filter(e => /^qa-structured-dev(?:-|$)/.test(e.outputTag)).length ?? 0) < 3,
    { currentRequests: report.receipts.length, priorRequests, currentTokens: observedTokens, priorTokens, attempt: (recordedLedger?.entries.length ?? 0) + 1, limits },
    "all current plus cumulative prior current-round provider costs fit1200requests/6Mtokens and at most3fresh20 plus one diagnostic pair; no reset");
  gate.version = 'memory-qa-structured-development-gate-v1'; gate.passed = gate.checks.every(c => c.passed); gate.evaluationSha256 = report.evaluationSha256;
  gate.registration = { registeredAt: registration.registeredAt, thresholds: registration.thresholds, baselineDevelopment: registration.baselineDevelopment };
  gate.budgetRegistration = report.budgetRegistration; gate.priorBudgetLedger = recordedLedger ?? null;
  return gate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [reportFile, integrityFile, regressionFile, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: node check-memory-qa-structured-development.mjs REPORT INTEGRITY REGRESSIONS OUTPUT');
  const bytes = await readFile(path.join(root, 'docs/memory-qa-structured-preregistration.json')), registration = JSON.parse(bytes);
  const baselineFile = path.resolve(root, registration.baselineDevelopment.file);
  if (hash(await readFile(baselineFile)) !== registration.baselineDevelopment.sha256) throw new Error('Previous development baseline fingerprint changed');
  const report = await readPublicLiveReport(path.resolve(reportFile));
  const costReferenceFile = path.resolve(root, registration.costReferenceDevelopment.file);
  if (hash(await readFile(costReferenceFile)) !== registration.costReferenceDevelopment.sha256) throw new Error("Cost reference fingerprint changed");
  const result = checkQaStructuredDevelopment(report, JSON.parse(await readFile(integrityFile)), JSON.parse(await readFile(regressionFile)), registration,
    await readPublicLiveReport(baselineFile), await readPublicLiveReport(costReferenceFile), await verifyQaStructuredRecordedBudget(root, report));
  result.report = path.relative(root, path.resolve(reportFile)); result.registration.sha256 = hash(bytes);
  const integrity = JSON.parse(await readFile(integrityFile));
  const compactSha256 = hash(await readFile(reportFile));
  result.checks.push({ name: 'integrity_bound_to_this_compact_report', passed: integrity.results?.some(value => value.passed === true
    && path.resolve(root, value.file) === path.resolve(root, reportFile) && value.sha256 === compactSha256),
    actual: integrity.results?.map(value => ({ file: value.file, sha256: value.sha256 })), required: 'successful raw integrity evidence binds the exact current compact bytes' });
  result.passed = result.checks.every(check => check.passed);
  await writeFile(outputFile, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
