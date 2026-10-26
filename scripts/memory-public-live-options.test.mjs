import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { publicLiveOptions, selectPublicDocuments, publicReportPath, assertNoProductionGold, isJudgeProtocolFailure, failedJudgeRepairPlan, beginJudgeRepair } from './memory-public-live-options.mjs';
import { isolatedJudgeTasks, validateIsolatedJudgment, combineIsolatedJudgments, parseIsolatedJudgeResponse } from './memory-public-live-judges.mjs';
import { comparePublicLive } from './compare-memory-public-live.mjs';

test('new runs require unique tagged output and finite budgets', () => {
  assert.throws(() => publicLiveOptions([], process.cwd()), /output-tag/);
  for (const [flag, bad] of [['--max-requests', '0'], ['--max-tokens', 'Infinity'], ['--workers', '5'], ['--output-tag', '../baseline']]) assert.throws(() => publicLiveOptions(['--output-tag', 'dev', flag, bad], process.cwd()));
  const o = publicLiveOptions(['--split', 'development', '--output-tag', 'dev'], process.cwd());
  assert.equal(o.maxRequests, 500); assert.equal(o.maxTokens, 2000000); assert.equal(o.judges, 'memory-answer');
  assert.match(publicReportPath(process.cwd(), { outputTag: 'dev' }), /memory-public-live-dev-results\.json$/);
});

test('an explicit budget addendum path is parsed without changing score or retry settings', () => {
  const o = publicLiveOptions(['--split', 'development', '--output-tag', 'qa-calibrated-dev-v3', '--max-requests', '900',
    '--max-tokens', '4500000', '--budget-addendum', 'docs/memory-qa-calibrated-budget-addendum-1.json'], process.cwd());
  assert.equal(o.maxRequests, 900); assert.equal(o.maxTokens, 4500000); assert.equal(o.repairFailedJudges, false);
  assert.equal(o.budgetAddendum, path.resolve(process.cwd(), 'docs/memory-qa-calibrated-budget-addendum-1.json'));
});
test('split selects full documents and counts their questions', () => {
  const f = { documents: [{ split: 'development', queries: [{}, {}], paragraphs: [{}] }, { split: 'holdout', queries: [{}], paragraphs: [{}, {}] }] };
  const s = selectPublicDocuments(f, 'development');
  assert.equal(s.documents.length, 1); assert.equal(s.questionCount, 2); assert.equal(s.paragraphCount, 1);
});
test('gold envelopes stop before forwarding production requests', () => {
  for (const name of ['humanAnswers', 'goldParagraphs', 'humanEvidenceAlternatives', 'acceptableEvidenceSets', 'expectedAnswers']) assert.throws(() => assertNoProductionGold({ [name]: [] }), /Gold/);
  assert.doesNotThrow(() => assertNoProductionGold({ question: 'What does humanAnswers mean?', segments: [] }));
});

const actual = { entries: { desktop: { result: { answer: 'final secret', grounded: true }, generations: [{ references: [{ id: 'memory:m', content: 'retrieved secret', evidence: [{ quote: 'source quote secret' }] }] }] }, connector: { errorCode: 'FAILED', generations: [] } } };
const question = { id: 'q', question: 'Question', answerable: true, expectedAnswers: [{ freeForm: 'gold secret' }], acceptableEvidenceSets: [[['paragraph']]] };
const input = { doc: { paragraphs: [{ id: 'paragraph', content: 'gold passage' }] }, paper: { memories: [{ id: 'm', content: 'formal secret', quotes: [{ quote: 'source quote secret' }] }] }, question, actual, baselineActual: actual, mode: 'separated' };
test('judge views separate memory content, retrieved content and answers', () => {
  const tasks = isolatedJudgeTasks(input);
  const memory = JSON.stringify(tasks.find(t => t.phase === 'memory').input);
  assert.ok(memory.includes('formal secret')); for (const hidden of ['final secret', 'retrieved secret', 'source quote secret']) assert.equal(memory.includes(hidden), false);
  const retrieval = JSON.stringify(tasks.find(t => t.phase === 'retrieval').input);
  assert.ok(retrieval.includes('retrieved secret')); for (const hidden of ['formal secret', 'final secret', 'source quote secret']) assert.equal(retrieval.includes(hidden), false);
  const answer = JSON.stringify(tasks.find(t => t.phase === 'answer').input);
  assert.ok(answer.includes('final secret')); assert.equal(answer.includes('formal secret'), false); assert.equal(answer.includes('retrieved secret'), false);
});
test('memory judge whitelist rejects invented IDs and paired grades retain mapping', () => {
  assert.throws(() => validateIsolatedJudgment({ phase: 'memory' }, { memorySufficiency: 'yes', relevantMemoryIds: ['invented'], organizationIssues: [] }, new Set(['m'])), /whitelist/);
  const task = { phase: 'answer', order: ['baseline', 'current'] };
  const value = { systems: { system1: { desktop: { answerCorrect: 'no' }, connector: { answerCorrect: 'partial' } }, system2: { desktop: { answerCorrect: 'yes' }, connector: { answerCorrect: 'yes' } } } };
  const j = combineIsolatedJudgments([task], { answer: value });
  assert.equal(j.entries.desktop.answerCorrect, 'yes'); assert.equal(j.baselineEntries.desktop.answerCorrect, 'no');
});
test('paired comparison uses rescored baseline rather than drifting legacy grade', () => {
  const paper = { id: 'p', split: 'development', questions: [{ ...question, entries: { desktop: {}, connector: {} } }], extraction: { job: { status: 'succeeded' } }, memories: [] };
  const baseline = { datasetSha256: 'same', documents: [paper], judgments: [{ id: 'q', entries: { desktop: { answerCorrect: 'yes' }, connector: { answerCorrect: 'yes' } } }], receipts: [], productionSha256: {}, model: 'same' };
  const current = { ...baseline, judgments: [{ id: 'q', entries: { desktop: { answerCorrect: 'yes' }, connector: { answerCorrect: 'yes' } }, baselineEntries: { desktop: { answerCorrect: 'no' }, connector: { answerCorrect: 'partial' } }, memorySufficiency: 'yes' }] };
  const c = comparePublicLive(current, baseline);
  assert.equal(c.summary['all:desktop'].beforeFullyCorrect.count, 0); assert.equal(c.summary['all:desktop'].answerableChanges.new_success, 1); assert.equal(c.rows[0].baselineOriginalGrade, 'yes');
});


test('judge repairs require explicit resume and preserve existing run budgets', () => {
  assert.throws(() => publicLiveOptions(['--output-tag','dev','--repair-failed-judges'],process.cwd()),/requires --resume/);
  const o = publicLiveOptions(['--resume','.local-data/public-memory-live-run','--split','development','--repair-failed-judges'],process.cwd());
  assert.equal(o.repairFailedJudges,true);
  assert.equal(o.maxRequests,500); assert.equal(o.maxTokens,2000000);
});

const repairDocuments = [{id:'p',queries:[{id:'broken'},{id:'valid-no'}]}];
function repairReport() {
  return { limits:{requests:500,observedTotalTokens:2000000},receipts:[{index:1}],documents:[{id:'p',complete:true,questions:[{id:'broken',entries:{desktop:{result:{}},connector:{result:{}}}},{id:'valid-no',entries:{desktop:{result:{}},connector:{result:{}}}}]}],judgments:[
    {id:'broken',paperId:'p',error:'answer: malformed JSON',receiptIds:[1],stages:{answer:{error:"Expected ',' or '}' after property value in JSON at position 517 (line 1 column 518)"},memory:{memorySufficiency:'yes',relevantMemoryIds:['m'],organizationIssues:[]},retrieval:{entries:{desktop:{retrievalSufficiency:'no'},connector:{retrievalSufficiency:'partial'}}}}},
    {id:'valid-no',paperId:'p',receiptIds:[],stages:{answer:{systems:{system1:{desktop:{answerCorrect:'no'},connector:{answerCorrect:'no'}},system2:{desktop:{answerCorrect:'no'},connector:{answerCorrect:'no'}}}},memory:{memorySufficiency:'no',relevantMemoryIds:[],organizationIssues:[]}}}
  ]};
}

test('repair plan selects only failed parser or schema phases, never low grades or transport failures', () => {
  const report=repairReport(); const original=structuredClone(report);
  assert.deepEqual(failedJudgeRepairPlan(report,repairDocuments),[{questionId:'broken',paperId:'p',phases:['answer']}]);
  assert.deepEqual(report,original);
  for (const error of ['Judge HTTP 429','Evaluation halted before judge','fetch failed','Evaluation call/token limit']) assert.equal(isJudgeProtocolFailure({error}),false);
  for (const error of ['Unexpected end of JSON input','Answer judge schema','Memory judge schema/ID whitelist','Retrieval judge schema']) assert.equal(isJudgeProtocolFailure({error}),true);
  assert.equal(isJudgeProtocolFailure({error:'JSON parse',errorKind:'transport'}),false);
  assert.equal(isJudgeProtocolFailure({error:'Judge response schema',errorKind:'protocol'}),true);
  report.judgments[0].stages.answer={error:'Judge HTTP 503'};
  assert.deepEqual(failedJudgeRepairPlan(report,repairDocuments),[]);
});

test('repair mode refuses incomplete production without resubmitting papers', () => {
  const report=repairReport(); report.documents[0].complete=false;
  assert.throws(()=>failedJudgeRepairPlan(report,repairDocuments),/all production documents complete/);
  report.documents[0].complete=true; report.documents[0].questions.pop();
  assert.throws(()=>failedJudgeRepairPlan(report,repairDocuments),/completed production questions/);
});

test('one repair journals the prior judgment immutably and cannot select valid phases or repeat a question', () => {
  const report=repairReport(); const budgets=structuredClone(report.limits), receipts=structuredClone(report.receipts);
  const item=failedJudgeRepairPlan(report,repairDocuments)[0];
  const previous=structuredClone(report.judgments[0]);
  const repair=beginJudgeRepair(report,item,'2026-10-20T00:00:00Z');
  assert.deepEqual(repair.previousJudgment,previous);
  assert.deepEqual(repair.phases,['answer']); assert.deepEqual(repair.newReceiptIds,[]);
  assert.equal(repair.requestedAt,'2026-10-20T00:00:00Z');
  report.judgments[0].stages.answer={systems:{}};
  assert.deepEqual(repair.previousJudgment,previous);
  assert.deepEqual(report.limits,budgets); assert.deepEqual(report.receipts,receipts);
  assert.throws(()=>beginJudgeRepair(report,item),/already attempted/);
  report.judgments[0].stages.answer=previous.stages.answer;
  assert.throws(()=>failedJudgeRepairPlan(report,repairDocuments),/already attempted/);
  const fresh=repairReport();
  assert.throws(()=>beginJudgeRepair(fresh,{questionId:'broken',paperId:'p',phases:['memory']}),/Only failed parser/);
});

test('recombining a repaired stage preserves valid memory and retrieval judgments', () => {
  const report=repairReport(), previous=report.judgments[0];
  const tasks=isolatedJudgeTasks({...input,mode:'separated'});
  const values={...structuredClone(previous.stages),answer:{systems:{system1:{desktop:{answerCorrect:'no'},connector:{answerCorrect:'no'}},system2:{desktop:{answerCorrect:'yes'},connector:{answerCorrect:'partial'}}}}};
  const combined=combineIsolatedJudgments(tasks,values);
  assert.equal(combined.error,undefined);
  assert.deepEqual(combined.stages.memory,previous.stages.memory);
  assert.deepEqual(combined.stages.retrieval,previous.stages.retrieval);
  assert.equal(combined.memorySufficiency,'yes');
});


test('judge parser validates normal JSON without recording a syntax repair', () => {
  const task={phase:'memory'}, value={memorySufficiency:'yes',relevantMemoryIds:['m'],organizationIssues:[],reason:'All facts present.'};
  const parsed=parseIsolatedJudgeResponse(JSON.stringify(value),task,new Set(['m']),'stop');
  assert.deepEqual(parsed,{value,repair:null});
  assert.throws(()=>parseIsolatedJudgeResponse(JSON.stringify({...value,relevantMemoryIds:['invented']}),task,new Set(['m']),'stop'),/whitelist/);
});

test('judge parser only appends one final object brace and records exact input hashes', async () => {
  const {createHash}=await import('node:crypto');
  const value={systems:{system1:{desktop:{answerCorrect:'yes',reason:'Correct.'},connector:{answerCorrect:'no',reason:'Incorrect.'}},system2:{desktop:{answerCorrect:'partial',reason:'Incomplete.'},connector:{answerCorrect:'yes',reason:'Correct.'}}}};
  const text=JSON.stringify(value).slice(0,-1)+'  ';
  const parsed=parseIsolatedJudgeResponse(text,{phase:'answer'},new Set(),'stop');
  assert.deepEqual(parsed.value,value);
  assert.equal(parsed.repair.kind,'append-single-final-object-brace'); assert.equal(parsed.repair.appended,'}');
  assert.equal(parsed.repair.originalSha256,createHash('sha256').update(text).digest('hex'));
  assert.equal(parsed.repair.repairedSha256,createHash('sha256').update(text+'}').digest('hex'));
  assert.equal(typeof parsed.repair.error,'string');
});

test('single-brace repair cannot supply missing grades, repair quotes, close two objects or accept length truncation', () => {
  const task={phase:'answer'};
  const valid={systems:{system1:{desktop:{answerCorrect:'yes'},connector:{answerCorrect:'no'}},system2:{desktop:{answerCorrect:'yes'},connector:{answerCorrect:'no'}}}};
  const single=JSON.stringify(valid).slice(0,-1);
  const missing=structuredClone(valid); delete missing.systems.system2.connector;
  const invalid=structuredClone(valid); invalid.systems.system2.connector.answerCorrect='great';
  for (const text of [JSON.stringify(missing).slice(0,-1),JSON.stringify(invalid).slice(0,-1),JSON.stringify(valid).slice(0,-2),' {"systems":{"reason":"unterminated}', '{"systems":{"reason":"a " broken quote"}}']) assert.throws(()=>parseIsolatedJudgeResponse(text,task,new Set(),'stop'));
  for (const reason of ['length','max_tokens','content_filter',undefined]) assert.throws(()=>parseIsolatedJudgeResponse(single,task,new Set(),reason));
  assert.throws(()=>parseIsolatedJudgeResponse('{"memorySufficiency":"yes","relevantMemoryIds":["invented"],"organizationIssues":[]',{phase:'memory'},new Set(['m']),'stop'));
});

const flatAnswerFixture = () => ({
  system1: { desktop: { answerCorrect: 'yes', reason: 'A current fact answers the question.' }, connector: { answerCorrect: 'no', reason: 'The answer only gives background.' } },
  system2: { desktop: { answerCorrect: 'partial', reason: 'The answer omits one requested field.' }, connector: { answerCorrect: 'uncertain', reason: 'The human answer is ambiguous.' } },
});

test('flat answer envelope normalization preserves all four grades and exact reason strings with an audit hash', async () => {
  const { createHash } = await import('node:crypto');
  const value = flatAnswerFixture(); value.system1.desktop.reason = 'Exact reason: "a quote"\n第二行';
  const text = `  ${JSON.stringify(value, null, 2)}\n`;
  const parsed = parseIsolatedJudgeResponse(text, { phase: 'answer' }, new Set(), 'stop');
  assert.deepEqual(parsed.value, { systems: value }); assert.equal(parsed.repair, null);
  assert.equal(parsed.envelopeNormalization.kind, 'wrap-flat-answer-systems');
  assert.equal(parsed.envelopeNormalization.modelRequests, 0);
  assert.equal(parsed.envelopeNormalization.originalSha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(parsed.envelopeNormalization.normalizedSha256, createHash('sha256').update(JSON.stringify({ systems: value })).digest('hex'));
});

test('flat envelope normalization rejects unknown keys at root, systems, entries or grades', () => {
  for (const alter of [v => { v.extra = {}; }, v => { v.system3 = v.system1; }, v => { v.system1.mobile = v.system1.desktop; },
    v => { v.system1.desktop.score = 1; }, v => { v.systems = {}; }]) {
    const value = flatAnswerFixture(); alter(value);
    assert.throws(() => parseIsolatedJudgeResponse(JSON.stringify(value), { phase: 'answer' }, new Set(), 'stop'), /Answer judge schema/);
  }
});

test('flat envelope normalization cannot fill missing grades, systems, entries or reasons', () => {
  for (const alter of [v => { delete v.system2; }, v => { delete v.system1.connector; }, v => { delete v.system1.desktop.reason; },
    v => { v.system1.desktop.reason = ''; }, v => { v.system1.desktop.reason = null; }, v => { v.system1.desktop.answerCorrect = 'correct'; },
    v => { delete v.system1.desktop.answerCorrect; }]) {
    const value = flatAnswerFixture(); alter(value);
    assert.throws(() => parseIsolatedJudgeResponse(JSON.stringify(value), { phase: 'answer' }, new Set(), 'stop'), /Answer judge schema/);
  }
});

test('flat normalization never repairs another phase, a truncated response, or syntax plus envelope together', () => {
  const text = JSON.stringify(flatAnswerFixture());
  for (const phase of ['memory', 'retrieval']) assert.throws(() => parseIsolatedJudgeResponse(text, { phase }, new Set(), 'stop'));
  for (const finish of ['length', 'max_tokens', 'content_filter', undefined]) assert.throws(() => parseIsolatedJudgeResponse(text, { phase: 'answer' }, new Set(), finish));
  assert.throws(() => parseIsolatedJudgeResponse(text.slice(0, -1), { phase: 'answer' }, new Set(), 'stop'));
});

test('a correctly wrapped answer remains unchanged and unnormalized', () => {
  const value = { systems: flatAnswerFixture() };
  assert.deepEqual(parseIsolatedJudgeResponse(JSON.stringify(value), { phase: 'answer' }, new Set(), 'stop'), { value, repair: null });
});
