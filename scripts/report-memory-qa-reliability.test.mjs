import test from 'node:test';
import assert from 'node:assert/strict';
import {answerStageJudgment, buildReliabilityMetrics, parseReliabilityArgs, reliabilityCosts, reliabilityMarkdown} from './report-memory-qa-reliability.mjs';

const entries = ['desktop', 'connector'];
function fixtureReport(tag, labels = ['yes', 'partial', 'no', 'uncertain', undefined]) {
  const questions = [...labels.map((_, i) => ({id:`q${i}`, answerable:true})), {id:'negative', answerable:false}].map(q => ({...q,
    question:`Question ${q.id}?`, entries:Object.fromEntries(entries.map(entry => [entry, {generations:[], result:{answer:`${tag} ${entry} answer for ${q.id}`, status:'answered', claims:[], unknowns:[], queryTrace:{}}}]))}));
  return {version:'qasper-production-live-v2', outputTag:tag, split:'development', datasetSha256:'same-dataset', workspace:`workspace-${tag}`,
    model:'fixture-model', binarySha256:`binary-${tag}`, productionSha256:{'qa.rs':`source-${tag}`}, evaluationSha256:{judge:'judge-hash'},
    preLiveEvidence:{finishedAt:'before-live'}, complete:true, receipts:[], usage:{total_tokens:0},
    documents:[{id:'paper', split:'development', memories:[], segments:[], qaReadOnly:true, extraction:{job:{status:'succeeded'}}, questions}],
    judgments:questions.map((q, i) => ({id:q.id, answerable:q.answerable, memorySufficiency:labels[i],
      anonymousOrder:['baseline', 'current'], entries:Object.fromEntries(entries.map(entry => [entry, {answerCorrect:'yes', retrievalSufficiency:'yes', reason:'WRONG RETRIEVAL OVERWRITE'}])),
      baselineEntries:Object.fromEntries(entries.map(entry => [entry, {answerCorrect:'partial', reason:'untrusted flattened reason'}])),
      stages:{answer:{systems:{system1:Object.fromEntries(entries.map(entry => [entry, {answerCorrect:'partial', reason:`${tag} paired old ${entry} reason`}])) ,
        system2:Object.fromEntries(entries.map(entry => [entry, {answerCorrect:'yes', reason:`${tag} current ${entry} reason`}]))}},
      memory:{reason:`${tag} memory reason`}, retrieval:{entries:Object.fromEntries(entries.map(entry => [entry, {reason:`${tag} retrieval reason`}]))}}})),
  };
}

test('answer reasons map each anonymous order without using overwritten entry reasons', () => {
  const judgment = fixtureReport('new').judgments[0];
  assert.equal(answerStageJudgment(judgment, 'current', 'desktop').reason, 'new current desktop reason');
  assert.equal(answerStageJudgment(judgment, 'baseline', 'desktop').reason, 'new paired old desktop reason');
  judgment.anonymousOrder.reverse();
  assert.equal(answerStageJudgment(judgment, 'current', 'desktop').reason, 'new paired old desktop reason');
  delete judgment.stages.answer;
  assert.equal(answerStageJudgment(judgment, 'current', 'desktop').reason, null);
  assert.equal(answerStageJudgment(judgment, 'current', 'desktop').source, 'missing_answer_stage');
});

test('phase costs count failures, preserve missing usage and never double count cache', () => {
  const report = {receipts:[
    {phase:'qa', status:200, usage:{prompt_tokens:10, completion_tokens:3, total_tokens:13, prompt_cache_hit_tokens:4, prompt_tokens_details:{cached_tokens:4}}},
    {phase:'qa', status:500, error:'failed'},
    {phase:'judge', status:200, usage:{input_tokens:7, output_tokens:2, total_tokens:9, input_tokens_details:{cached_tokens:0}}},
    {phase:'extraction', status:200, usage:{prompt_tokens:5, completion_tokens:1, total_tokens:6}},
  ]};
  const cost = reliabilityCosts(report);
  assert.equal(cost.all.requests, 4); assert.equal(cost.all.totalTokens, 28); assert.equal(cost.all.inputTokens, 22);
  assert.equal(cost.all.outputTokens, 6); assert.equal(cost.all.cachedInputTokens, 4); assert.equal(cost.all.failedRequests, 1);
  assert.equal(cost.qa.requests, 2); assert.equal(cost.qa.totalTokens, 13); assert.equal(cost.qa.missingUsage, 1);
  assert.deepEqual(cost.all.missingByField, {totalTokens:1, inputTokens:1, outputTokens:1, cachedInputTokens:2});
  assert.equal(cost.judge.missingByField.cachedInputTokens, 0);
  assert.equal(cost.extraction.missingByField.cachedInputTokens, 1);
});

test('memory labels count each answerable question once and keep strict yes separate from partial', () => {
  const before = fixtureReport('old'), after = fixtureReport('qa-reliability-dev');
  const metrics = buildReliabilityMetrics(after, before);
  assert.deepEqual(metrics.memory.current.distribution, {yes:1, partial:1, no:1, uncertain:1, missing:1});
  assert.deepEqual(metrics.memory.current.yes, {count:1, denominator:5, rate:0.2});
  assert.deepEqual(metrics.memory.current.yesOrPartial, {count:2, denominator:5, rate:0.4});
  assert.equal(metrics.currentSummary.summary['all:desktop'].fullyCorrectAnswerable.denominator, 5);
  assert.equal(metrics.currentSummary.summary['all:desktop'].correctAbstention.denominator, 1);
  assert.equal(metrics.scope.full100Executed, false);
});

test('historical and same-call paired comparisons and all three original reasons stay separate', () => {
  const before = fixtureReport('old', ['yes']), after = fixtureReport('qa-reliability-dev', ['yes']);
  const snapshot = structuredClone({before, after});
  const metrics = buildReliabilityMetrics(after, before);
  const row = metrics.cases.find(r => r.id === 'q0' && r.entry === 'desktop');
  assert.equal(row.baselineOriginalGrade, 'yes'); assert.equal(row.baselinePairedGrade, 'partial'); assert.equal(row.currentGrade, 'yes');
  assert.equal(row.originalChange, 'retained_success'); assert.equal(row.pairedChange, 'new_success');
  assert.equal(row.reasons.baselineOriginal.reason, 'old current desktop reason');
  assert.equal(row.reasons.baselinePaired.reason, 'qa-reliability-dev paired old desktop reason');
  assert.equal(row.reasons.current.reason, 'qa-reliability-dev current desktop reason');
  assert.equal(metrics.comparisons.historicalOriginal.summary['all:desktop'].beforeFullyCorrect.count, 1);
  assert.equal(metrics.comparisons.strictAnonymousPaired.desktop.beforeFullyCorrect.count, 0);
  assert.deepEqual({before, after}, snapshot);
  after.productionSha256['qa.rs'] = 'changed-checkout';
  assert.equal(metrics.current.productionSha256['qa.rs'], 'source-qa-reliability-dev');
});

test('missing paired grades never silently borrow historical grades', () => {
  const before = fixtureReport('old', ['yes']), after = fixtureReport('qa-reliability-dev', ['yes']);
  delete after.judgments[0].baselineEntries;
  const metrics = buildReliabilityMetrics(after, before);
  assert.equal(metrics.comparisons.strictAnonymousPaired.desktop.beforeFullyCorrect.count, 0);
  assert.deepEqual(metrics.comparisons.strictAnonymousPaired.desktop.missingPaired, ['q0']);
  const row = metrics.cases.find(r => r.id === 'q0' && r.entry === 'desktop');
  assert.equal(row.baselinePairedGrade, 'not_judged'); assert.equal(row.pairedChange, 'not_paired');
});

test('protocol failures remain failures despite a yes grade and answerable denominator is unchanged', () => {
  const before = fixtureReport('old', ['yes']), after = fixtureReport('qa-reliability-dev', ['yes']);
  const value = after.documents[0].questions[0].entries.desktop;
  value.error = 'response unavailable'; value.errorCode = 'MODEL_USAGE_MISSING';
  value.result.queryTrace.reviews = [{status:'unavailable', errorCode:'MODEL_JSON'}];
  after.receipts.push({phase:'judge', index:4, status:500, error:'judge attempt failed', questionId:'q0'});
  const metrics = buildReliabilityMetrics(after, before);
  assert.equal(metrics.currentSummary.summary['all:desktop'].fullyCorrectAnswerable.count, 0);
  assert.equal(metrics.currentSummary.summary['all:desktop'].fullyCorrectAnswerable.denominator, 1);
  assert.deepEqual(metrics.protocol.current.answer.desktop, {MODEL_USAGE_MISSING:1});
  assert.deepEqual(metrics.protocol.current.review.desktop, {MODEL_JSON:1});
  assert.equal(metrics.protocol.current.failedJudgeRequests.length, 1);
});

test('markdown includes original answers and answer-stage reasons, escaped tables and explicit limits', () => {
  const before = fixtureReport('old', ['yes']), after = fixtureReport('qa-reliability-dev', ['partial']);
  after.documents[0].questions[0].entries.desktop.result.answer = 'First | fact\nSecond';
  const markdown = reliabilityMarkdown(buildReliabilityMetrics(after, before));
  assert.match(markdown, /First \\\| fact<br>Second/);
  assert.match(markdown, /old current desktop reason/);
  assert.match(markdown, /qa-reliability-dev paired old desktop reason/);
  assert.match(markdown, /qa-reliability-dev current desktop reason/);
  assert.doesNotMatch(markdown, /WRONG RETRIEVAL OVERWRITE|untrusted flattened reason/);
  assert.match(markdown, /yes \+ partial 不标为完整保留/); assert.match(markdown, /100题未执行/);
  assert.match(markdown, /没有新增盲测或人工复核/); assert.match(markdown, /不能据此声称完整性校验通过/);
  assert.match(markdown, /字段缺失\(total\/input\/output\/cache\)/);
});

test('CLI requires current input, defaults the historical baseline, and rejects ambiguous arguments', () => {
  assert.deepEqual(parseReliabilityArgs(['--current', 'new.json']), {current:'new.json', baseline:'docs/memory-public-live-qa-structured-dev-v3-results.json', integrity:null});
  assert.equal(parseReliabilityArgs(['--current', 'new.json', '--integrity', 'audit.json']).integrity, 'audit.json');
  for (const args of [[], ['--current'], ['--current', '--baseline'], ['--unknown', 'file'], ['--current', 'a', '--current', 'b'], ['--current', 'a', '--baseline', 'b', '--baseline', 'c']]) assert.throws(() => parseReliabilityArgs(args));
});
