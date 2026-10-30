import test from 'node:test';
import assert from 'node:assert/strict';
import { targetedReviewMappings, selectedTargetedReview, targetedSupplementProtocolFailure } from './memory-qa-targeted-capture.mjs';
import { reviewCalibrationMetrics, reviewUnknownDecisionMarkdown, retrievalOperationalMetrics, markdownObservation, summarizeDevelopmentBudget, distinctRetrievalRunUsage, observedScopeLimitation } from './report-memory-qa-targeted.mjs';
const review = () => ({ supported: true, answersQuestion: true, completeAnswer: true, unsupportedClaims: [], missingAspects: [], reason: 'derived',
  obligations: [{ target: 'asked', status: 'answered', claimIndices: [1] }], unknownDecisions: [{ unknownIndex: 1, disposition: 'unasked', claimIndices: [] }],
  rawProviderReview: { supported: true, unsupportedClaims: [], missingAspects: [], reason: 'provider', obligations: [{ target: 'asked', status: 'answered', claimIndices: [1] }], unknownDecisions: [{ unknownIndex: 1, disposition: 'unasked', claimIndices: [] }] },
  inputUnknowns:['original review-indexed unknown'],localTargetGuard:{preserved:true},
  derivedState: { answersQuestion: true, completeAnswer: true } });
function actual() { return { receiptIds: [10, 11], generations: [{ receiptId: 10, references: [{ id: 'memory:one', content: 'complete body' }], output: { grounded: true, unknowns: ['unasked detail'] } }],
  result: { grounded: true, status: 'answered', unknowns: [], queryTrace: { answerGenerationIndex: 0, reviews: [review()],
    reviewRounds: [{ reviewIndex: 0, generationIndex: 0, retrievalRound: 1, status: 'validated' }] } } }; }
function report(value = actual()) { return { outputTag: 'qa-targeted-dev', documents: [{ id: 'p', split: 'development', questions: [{ id: 'q', answerable: true, entries: { desktop: value, connector: structuredClone(value) } }] }],
  receipts: [{ index: 10, phase: 'qa', questionId: 'q', entry: 'desktop', task: 'generation', usage: { total_tokens: 100 } },
    { index: 11, phase: 'qa', questionId: 'q', entry: 'desktop', task: 'answer_review', usage: { total_tokens: 20 } }],
  judgments: [{ id: 'q', entries: { desktop: { answerCorrect: 'partial' }, connector: { answerCorrect: 'yes' } } }] }; }
test('first real generation after local retrieval uses explicit review mapping without rewrite calls', () => {
  const value = actual(); assert.equal(selectedTargetedReview(value).retrievalRound, 1);
  const metric = reviewCalibrationMetrics(report(value)).desktop;
  assert.equal(metric.validReviews, 1); assert.equal(metric.unknownsClearedCases[0].selectedReviewIndex, 0);
  assert.equal(metric.unknownsClearedCases[0].selectedRetrievalRound, 1); assert.equal(metric.unknownsClearedCases[0].reviewReceiptId, 11);
});
test('raw provider and derived summaries remain separate and automatic labels do not become human proof', () => {
  const value=actual(),metric=reviewCalibrationMetrics(report(value)).desktop;
  assert.equal(metric.rawProviderReviewPreservedReviews,1);assert.equal(metric.providerSummaryFieldsAbsentReviews,1);
  assert.equal(metric.selectedRawUnknownsCleared,1);assert.deepEqual(metric.selectedRawUnknownsClearedOutcomes,{partial:1});
  assert.deepEqual(metric.unknownsClearedCases[0].selectedRawReview,value.result.queryTrace.reviews[0].rawProviderReview);
  assert.deepEqual(metric.unknownsClearedCases[0].reviewInputUnknowns,['original review-indexed unknown']);assert.deepEqual(metric.unknownsClearedCases[0].selectedLocalTargetGuard,{preserved:true});
  assert.equal(metric.unknownsClearedCases[0].humanAssessment,null);
});

test('literal asked-gap guard reports effective retain separately from untouched provider unasked', () => {
  const value=actual(),v=value.result.queryTrace.reviews[0],raw=structuredClone(v.rawProviderReview);
  v.unknownDecisions[0].disposition='retain';v.completeAnswer=false;v.localQuestionGapGuard={decision:'retain-literal-asked-mechanism',unknownIndices:[1]};
  Object.assign(value.result,{status:'partial',unknowns:['original review-indexed unknown']});
  const metrics=reviewCalibrationMetrics(report(value)),metric=metrics.desktop;
  assert.deepEqual(metric.unknownDispositionCounts,{retain:1});assert.deepEqual(metric.selectedUnknownDispositionCounts,{retain:1});
  assert.deepEqual(metric.rawProviderUnknownDispositionCounts,{unasked:1});assert.deepEqual(metric.selectedRawProviderUnknownDispositionCounts,{unasked:1});
  assert.equal(metric.localQuestionGapGuardReviews,1);assert.equal(metric.localQuestionGapGuardQuestions,1);
  assert.equal(metric.selectedLocalQuestionGapGuardQuestions,1);assert.equal(metric.localQuestionGapGuardRetainedUnknownDecisions,1);
  assert.deepEqual(metric.selectedUnknownDecisionCases[0].selectedLocalQuestionGapGuard,v.localQuestionGapGuard);assert.deepEqual(v.rawProviderReview,raw);
  const text=reviewUnknownDecisionMarkdown(metrics);assert.match(text,/全部有效unknown处置/);assert.match(text,/选中review有效unknown处置/);
  assert.match(text,/provider原始unknown处置/);assert.match(text,/localQuestionGapGuard/);assert.doesNotMatch(text,/全部模型unknown处置|选中review的模型unknown处置/);
});

test('guard review counts include earlier attempts while guard questions are deduplicated per entry', () => {
  const value=actual();value.receiptIds.push(12,13);value.generations.push({receiptId:12,references:[],output:{grounded:true,unknowns:[]}});
  const guarded=review();guarded.localQuestionGapGuard={decision:'retain-literal-asked-mechanism',unknownIndices:[1]};
  value.result.queryTrace.reviews=[guarded,review()];value.result.queryTrace.answerGenerationIndex=1;
  value.result.queryTrace.reviewRounds=[{reviewIndex:0,generationIndex:0,retrievalRound:0,status:'validated'},{reviewIndex:1,generationIndex:1,retrievalRound:2,status:'validated'}];
  const metric=reviewCalibrationMetrics(report(value)).desktop;
  assert.equal(metric.localQuestionGapGuardReviews,1);assert.equal(metric.localQuestionGapGuardQuestions,1);assert.equal(metric.selectedLocalQuestionGapGuardQuestions,0);
  assert.equal(metric.localTargetGuardReviews,2);assert.equal(metric.localTargetGuardQuestions,1);assert.equal(metric.selectedLocalTargetGuardQuestions,1);
});

test('missing raw unknown decisions are not fabricated from effective decisions or guards', () => {
  const value=actual();delete value.result.queryTrace.reviews[0].rawProviderReview;
  const metric=reviewCalibrationMetrics(report(value)).desktop;
  assert.deepEqual(metric.unknownDispositionCounts,{unasked:1});assert.deepEqual(metric.rawProviderUnknownDispositionCounts,{});
  assert.deepEqual(metric.selectedRawProviderUnknownDispositionCounts,{});assert.equal(metric.rawProviderUnknownDecisionReviewCount,0);
  assert.equal(metric.localQuestionGapGuardReviews,0);assert.equal(metric.localQuestionGapGuardQuestions,0);
});
test('fallback selects reviewed first generation while failed supplementary review is still counted', () => {
  const value=actual();value.receiptIds.push(12,13);value.generations.push({receiptId:12,references:[],output:{grounded:true,unknowns:[]}});
  Object.assign(value.result,{status:'partial',unknowns:['asked gap']});Object.assign(value.result.queryTrace,{reviewedPartialFallback:true,
    reviews:[review(),{status:'unavailable',errorCode:'QA_REVIEW_SCHEMA'}],reviewRounds:[{reviewIndex:0,generationIndex:0,retrievalRound:0,status:'validated'},{reviewIndex:1,generationIndex:1,retrievalRound:1,status:'unavailable'}]});
  assert.equal(selectedTargetedReview(value).generationIndex,0);assert.equal(targetedSupplementProtocolFailure(value),true);
  const metric=retrievalOperationalMetrics(report(value)).desktop;assert.equal(metric.supplementProtocolFailureQuestions,1);assert.equal(metric.reviewProtocolFailureQuestions,1);
});
test('invalid or missing explicit provenance fails instead of inferring review from rewrite counts', () => {
  for(const change of [v=>delete v.result.queryTrace.reviewRounds,v=>v.result.queryTrace.reviewRounds[0].generationIndex=1,v=>v.result.queryTrace.reviewRounds[0].reviewIndex=1,
    v=>v.result.queryTrace.reviewRounds[0].status='unavailable']){const value=actual();change(value);assert.throws(()=>targetedReviewMappings(value),/provenance/);}
});
test('a failed QA entry remains reportable without inventing review provenance',()=>{
  const value={error:'protocol failed',errorCode:'QA_GROUNDING',receiptIds:[],generations:[]};
  const calibration=reviewCalibrationMetrics(report(value)).desktop;assert.equal(calibration.validReviews,0);assert.equal(calibration.selectedRawUnknownsCleared,0);
  assert.equal(retrievalOperationalMetrics(report(value)).desktop.finalStatusCounts.error,1);assert.equal(selectedTargetedReview(value),null);
});
test('four-attempt costs and historical artifacts are not folded into an automatic budget extension', () => {
  const runs=[1,2,3,4].map(n=>({workspace:`new${n}`,usage:{requests:280,reportedTokens:1200000}}));
  const registry={limits:{development:{maxRequests:1200,maxTokens:6000000,maxFreshAttempts:4}}};
  const budget=summarizeDevelopmentBudget([...runs,runs[0]],registry,null);assert.equal(budget.distinctRuns,4);assert.equal(budget.requests,1120);assert.equal(budget.reportedTokens,4800000);
  assert.equal(budget.extensionUsed,false);assert.equal(budget.withinTokenLimit,true);assert.equal(distinctRetrievalRunUsage(runs).requests+829,1949);
});
test('Markdown retains bounded observations and no-full actual denominators', () => {
  const data={traces:Array.from({length:40},()=>({body:'large-body'.repeat(1000)}))},text=markdownObservation(data);
  assert.ok(text.length<=300);assert.equal(text.includes('large-body'),false);assert.match(text,/完整值见机器JSON/);
  const scope=observedScopeLimitation(false,{questions:20,answerable:19,unanswerable:1},4);assert.match(scope,/4次复测/);assert.match(scope,/9道无答案均尚未执行/);
});
