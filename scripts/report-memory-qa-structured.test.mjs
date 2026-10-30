import test from 'node:test';
import assert from 'node:assert/strict';
import {executedRunEvidence,structuredVersionNote,structuredReferenceNote} from './report-memory-qa-structured.mjs';
test('report binds executed binary/source/test/evaluation evidence instead of current checkout',()=>{
 const actual={binarySha256:'historical-binary',productionSha256:{'qa.rs':'historical-source'},preLiveEvidence:{finishedAt:'before-live'},evaluationSha256:{judge:'frozen'}};
 const result=executedRunEvidence(actual);assert.deepEqual(result,actual);actual.productionSha256['qa.rs']='current-source';assert.equal(result.productionSha256['qa.rs'],'historical-source');
});
test('different diagnostic/fresh binaries cannot be presented as final-version retesting',()=>{
 const a={binarySha256:'aaaaaaaaaaaaaaaa-original'},b={binarySha256:'bbbbbbbbbbbbbbbb-final'};
 assert.match(structuredVersionNote(a,b),/不同；诊断不能冒充最终版本复测/);assert.match(structuredVersionNote(a,null),/如使用不同binary/);
 assert.match(structuredVersionNote(a,{...a}),/实际二进制相同/);
});
test('missing diagnostic baseline reference grading never claims a reference net improvement',()=>{
 assert.match(structuredReferenceNote({baselineOriginallyJudged:false}),/参考充分性未单独评分/);assert.match(structuredReferenceNote({baselineOriginallyJudged:false}),/不能.*声称参考净增/);
 assert.match(structuredReferenceNote({baselineOriginallyJudged:true}),/不能声称同次配对参考净增/);
});

test('fresh20 table retains original run labels, QA costs and actual binaries across attempts',async()=>{
 const {freshDevelopmentAttempts,freshDevelopmentMarkdown}=await import('./report-memory-qa-structured.mjs');
 const metric=n=>({count:n,denominator:19,rate:n/19}),run=(tag,desk,conn,tokens,binary,passed)=>({outputTag:tag,file:`docs/memory-public-live-${tag}-results.json`,binarySha256:binary,
  summary:{outputTag:tag,summary:{'all:desktop':{fullyCorrectAnswerable:metric(desk),rawJudgeStageLabels:{fullRetrievalCoverage:metric(16)}},'all:connector':{fullyCorrectAnswerable:metric(conn),rawJudgeStageLabels:{fullRetrievalCoverage:metric(17)}}}},costs:{qa:{requests:91,tokens}},gate:{passed}});
 const first=run('qa-structured-dev',13,14,287123,'e02d181562cb81b6-first',false),next=run('qa-structured-dev-v2',14,16,260000,'actual-v2-binary',true);
 const rows=freshDevelopmentAttempts([first],next);assert.equal(rows.length,2);assert.equal(rows[0].originalDesktop.count,13);assert.equal(rows[0].originalConnector.count,14);assert.equal(rows[0].qaTokens,287123);assert.equal(rows[0].gate,'failed');assert.equal(rows[1].gate,'passed');
 const markdown=freshDevelopmentMarkdown(rows);assert.match(markdown,/e02d181562cb81b6/);assert.match(markdown,/actual-v2-binary/);assert.match(markdown,/不同次提取和模型随机性/);assert.match(markdown,/不是同调用配对/);assert.match(markdown,/没有重新评分（regrade）/);
});
test('fresh20 summary excludes diagnostic arms and does not infer a missing gate passed',async()=>{
 const {freshDevelopmentAttempts,freshDevelopmentMarkdown}=await import('./report-memory-qa-structured.mjs');
 const metric={count:0,denominator:19,rate:0},fresh={outputTag:'qa-structured-dev',binarySha256:'recorded',summary:{summary:{'all:desktop':{fullyCorrectAnswerable:metric,rawJudgeStageLabels:{fullRetrievalCoverage:metric}},'all:connector':{fullyCorrectAnswerable:metric,rawJudgeStageLabels:{fullRetrievalCoverage:metric}}}},costs:{qa:{requests:1,tokens:9}}};
 const rows=freshDevelopmentAttempts([{outputTag:'qa-structured-diag-baseline'},{outputTag:'qa-structured-diag-candidate'},fresh],null);
 assert.equal(rows.length,1);assert.equal(rows[0].gate,'not_provided');assert.match(freshDevelopmentMarkdown(rows),/未提供/);assert.match(freshDevelopmentMarkdown([]),/尚未执行/);
});
test('fresh20 table snapshots labels without mutating or replacing original metrics',async()=>{
 const {freshDevelopmentAttempts}=await import('./report-memory-qa-structured.mjs');
 const metric={count:13,denominator:19,rate:13/19},fresh={outputTag:'qa-structured-dev-v2',binarySha256:'v2',summary:{summary:{'all:desktop':{fullyCorrectAnswerable:metric,rawJudgeStageLabels:{fullRetrievalCoverage:metric}},'all:connector':{fullyCorrectAnswerable:metric,rawJudgeStageLabels:{fullRetrievalCoverage:metric}}}},costs:{qa:{requests:1,tokens:9}}};
 const rows=freshDevelopmentAttempts([],fresh);rows[0].originalDesktop.count=99;assert.equal(fresh.summary.summary['all:desktop'].fullyCorrectAnswerable.count,13);
});
