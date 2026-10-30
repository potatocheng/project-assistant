import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {verifyStructuredPreLive} from './memory-qa-structured-pre-live.mjs';
import {structuredOperationalObservations,compareActualPacks} from './memory-qa-structured-observations.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('pre-live mandates all eleven commands, source/binary/eval identity and registration before tests',async()=>{
 const dir=await mkdtemp(path.join(root,'.local-data/qa-structured-pre-live-test-'));await mkdir(path.join(dir,'docs'));
 const registeredAt='2026-10-23T00:00:00Z',startedAt='2026-10-23T00:01:00Z',finishedAt='2026-10-23T00:02:00Z',before='2026-10-23T00:03:00Z';
 const regression={version:'memory-qa-structured-regressions-v1',passed:true,startedAt,finishedAt,commands:Array.from({length:11},()=>({exitCode:0})),productionSha256:{'qa.rs':'new'},binarySha256:'new-bin',evaluationSha256:{gate:'unchanged'}};
 const input={productionSha256:regression.productionSha256,binarySha256:'new-bin',evaluationSha256:regression.evaluationSha256,registration:{registeredAt,baselineBinary:{productionSha256:{'qa.rs':'old'},sha256:'old-bin'}},before};
 const save=async r=>writeFile(path.join(dir,'docs/memory-qa-structured-regressions.json'),JSON.stringify(r));await save(regression);
 assert.equal((await verifyStructuredPreLive(dir,input)).commands,11);
 assert.equal((await verifyStructuredPreLive(dir,{...input,diagnosticArm:'baseline',productionSha256:{'qa.rs':'old'},binarySha256:'old-bin'})).executedSource,'registered-old-baseline');
 for(const mutate of [r=>r.passed=false,r=>r.commands.pop(),r=>r.commands[4].exitCode=1,r=>r.finishedAt='2026-10-23T00:04:00Z',r=>r.evaluationSha256.gate='changed',r=>r.binarySha256='other',r=>r.productionSha256['qa.rs']='changed',r=>r.startedAt='2026-10-22T00:00:00Z']) {const r=structuredClone(regression);mutate(r);await save(r);await assert.rejects(verifyStructuredPreLive(dir,input));}
});
function report(){const refs=[{id:'memory:a',content:'A'}];const value={receiptIds:[1,2],generations:[{receiptId:1,references:refs}],result:{status:'partial',claims:[{text:'A'}],unknowns:['B missing'],queryTrace:{answerGenerationIndex:0,reviewRounds:[{reviewIndex:0,generationIndex:0,retrievalRound:0}],reviews:[{questionPlan:{version:'fixed',obligations:[{id:'o1'}]},obligations:[{status:'partial'}],claimReviews:[{verdict:'supported'}],unknownDecisions:[{disposition:'retain'}]}]}}};return {documents:[{id:'p',memories:[{id:'a'}],questions:[{id:'q',answerable:true,entries:{desktop:value,connector:structuredClone(value)}}]}],judgments:[{id:'q',relevantMemoryIds:['a']}],receipts:['desktop','connector'].flatMap((entry,i)=>[{phase:'qa',questionId:'q',entry,index:i*2+1,task:'generation',usage:{total_tokens:100}},{phase:'qa',questionId:'q',entry,index:i*2+2,task:'answer_review',usage:{total_tokens:50}}])};}
test('trace funnel exposes actual packs, same-model relevant IDs and decisions without inventing truth',()=>{
 const r=report(),o=structuredOperationalObservations(r);assert.equal(o.rows.length,2);assert.equal(o.rows[0].questionPlan.version,'fixed');assert.equal(o.rows[0].judgeRelevantIdsShownInProducerUnion,1);assert.equal(o.perEntry.desktop.qaTokens,150);assert.equal(o.perEntry.desktop.claimTargetStatuses.supported,1);assert.equal(o.perEntry.desktop.unknownCount,1);
 assert.match(o.rows[0].interpretation,/Neither is independent human truth/);
});
test('offline pack differences explicitly do not claim a fixed-supplied-pack experiment',()=>{
 const a=report(),b=structuredClone(a);b.documents[0].questions[0].entries.desktop.generations[0].references=[{id:'memory:b',content:'B'}];
 const c=compareActualPacks(a,b);assert.equal(c[0].firstPackIdentical,false);assert.deepEqual(c[0].removedFirstPackIds,['memory:a']);assert.deepEqual(c[0].addedFirstPackIds,['memory:b']);assert.match(c[0].note,/no actual fixed-supplied-pack/);
});

test('raw anonymous judge inputs bind both actual systems and preserve exact wire JSON',async()=>{
 const {verifyStructuredJudgeInputs}=await import('./verify-memory-qa-structured-results.mjs');
 const {isolatedJudgeTasks}=await import('./memory-qa-structured-judges.mjs');
 const v={generations:[],result:{status:'unknown',grounded:false,answer:'Unknown',claims:[],unknowns:['Missing']}};
 const actual={id:'q1',entries:{desktop:v,connector:structuredClone(v)}},paper={id:'p',memories:[],questions:[actual]},question={id:'q1',question:'What?',answerable:true,expectedAnswers:['A'],acceptableEvidenceSets:[]},doc={id:'p',queries:[question],paragraphs:[]};
 const baseline={documents:[structuredClone(paper)]},r={judgeMode:'separated',documents:[paper],judgments:[]};
 const tasks=isolatedJudgeTasks({doc,paper,question,actual,baselineActual:baseline.documents[0].questions[0],mode:'separated'});
 const values={answer:{systems:{system1:{desktop:{answerCorrect:'no',reason:'R'},connector:{answerCorrect:'no',reason:'R'}},system2:{desktop:{answerCorrect:'no',reason:'R'},connector:{answerCorrect:'no',reason:'R'}}}},memory:{memorySufficiency:'no',relevantMemoryIds:[],organizationIssues:[],reason:'R'},retrieval:{entries:{desktop:{retrievalSufficiency:'no',reason:'R'},connector:{retrievalSufficiency:'no',reason:'R'}}}};
 r.judgments.push({id:'q1',anonymousOrder:tasks[0].order,stages:values});
 const raw=tasks.map(task=>({phase:'judge',paperId:'p',questionId:'q1',judgeStage:task.phase,request:{messages:[{role:'system',content:task.system},{role:'user',content:JSON.stringify(task.input)}]},responseText:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(values[task.phase])}}]})}));
 assert.deepEqual(verifyStructuredJudgeInputs(r,raw,{documents:[doc]},baseline),{questions:1,stages:3});
 const altered=JSON.parse(raw[0].request.messages[1].content);altered.systems.system1.desktop.final.answer='Fabricated';raw[0].request.messages[1].content=JSON.stringify(altered);
 assert.throws(()=>verifyStructuredJudgeInputs(r,raw,{documents:[doc]},baseline));
});
