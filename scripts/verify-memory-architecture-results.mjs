// Offline validation only; no provider calls and no changes to historical runs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { budgetHash } from './memory-public-live-budget.mjs';
import { verifyStructuredReport } from './verify-memory-qa-structured-results.mjs';
import { frozenMemorySemanticHash } from './memory-qa-structured-freeze.mjs';
import { isolatedJudgeTasks, combineIsolatedJudgments } from './memory-qa-structured-judges.mjs';
import { architectureBaselineFile, prepareArchitectureBudget, validateArchitectureReferences,
  verifyArchitecturePreLive } from './memory-architecture-evaluation.mjs';

const root=path.resolve(import.meta.dirname,'..'),file=process.argv[2];
if(!file||file.startsWith('--'))throw new Error('Usage: node verify-memory-architecture-results.mjs REPORT [--no-write]');
const absolute=path.resolve(root,file),bytes=await readFile(absolute),report=await readPublicLiveReport(absolute);
assert.equal(report.architecture?.kind,'frozen-confirmed-memory-qa-only');
assert.equal(report.architecture.formalMemoryCount,929);assert.equal(report.expectedQuestions,20);
assert.equal(report.architecture.suppliedPackFrozen,false);assert.equal(report.architecture.historicalBaselineAnswers,true);
assert.equal(report.baseline.file.replaceAll('\\','/'),architectureBaselineFile);
const budget=await prepareArchitectureBudget(root,{split:report.split,currentTag:report.outputTag,
  priorFile:report.architecture.priorReport?path.resolve(root,report.architecture.priorReport):null,
  model:report.model,datasetSha256:report.datasetSha256,before:report.startedAt,
  resumeRoot:path.resolve(root,report.workspace),maxRequests:report.limits.requests,maxTokens:report.limits.observedTotalTokens});
assert.deepEqual(report.budgetRegistration,budget.budgetRegistration);assert.deepEqual(report.priorBudgetLedger,budget.ledger);
assert.equal(report.architecture.attempt,budget.attempt);
assert.ok(report.receipts.length<=report.limits.requests);assert.ok(report.usage.total_tokens<=report.limits.observedTotalTokens);
const preLive=await verifyArchitecturePreLive(root,{currentTag:report.outputTag,productionSha256:report.productionSha256,
  binarySha256:report.binarySha256,evaluationSha256:report.evaluationSha256,registration:budget.registration,before:report.startedAt});
assert.deepEqual(report.preLiveEvidence,preLive);
const transcript=await readFile(path.resolve(root,report.workspace,'receipts.jsonl'));
const raw=transcript.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
assert.ok(raw.every(r=>['qa','judge'].includes(r.phase)));
for(const receipt of raw){assert.ok(receipt.usage.total_tokens<=receipt.tokenReservation);assert.ok(receipt.tokenReservation>0);}
const details=await verifyStructuredReport(report,bytes,raw);
const frozenBytes=await readFile(path.resolve(root,report.architecture.frozenReport));
assert.equal(report.architecture.frozenReport.replaceAll('\\','/'),architectureBaselineFile);
assert.equal(budgetHash(frozenBytes),report.architecture.frozenReportSha256);
const frozen=await readPublicLiveReport(path.resolve(root,report.architecture.frozenReport));
const manifest=JSON.parse(await readFile(path.join(root,'docs/memory-public-dataset-manifest.json')));
const fixture=JSON.parse(await readFile(path.resolve(root,manifest.fixture)));
let sourceReferences=0;
for(const paper of report.documents){
  const original=frozen.documents.find(p=>p.id===paper.id);assert.ok(original);
  assert.equal(frozenMemorySemanticHash(paper),frozenMemorySemanticHash(original));
  assert.equal(paper.frozenMemory.semanticSha256,frozenMemorySemanticHash(original));
  assert.equal(paper.extraction.skipped,true);assert.deepEqual(paper.extraction.receiptIds,[]);
  for(const actual of paper.questions){
    for(const entry of ['desktop','connector']){
      const checked=validateArchitectureReferences(actual.entries[entry],paper);
      assert.deepEqual(actual.entries[entry].referenceIntegrity,checked);sourceReferences+=checked.sourceReferences;
    }
    const doc=fixture.documents.find(d=>d.id===paper.id),question=doc.queries.find(q=>q.id===actual.id);
    const baselineActual=original.questions.find(q=>q.id===actual.id);
    const tasks=isolatedJudgeTasks({doc,paper,question,actual,baselineActual,mode:report.judgeMode});
    const judgment=report.judgments.find(j=>j.id===actual.id),combined=combineIsolatedJudgments(tasks,judgment.stages);
    for(const [key,value] of Object.entries(combined))assert.deepEqual(judgment[key],value);
  }
}
const child=spawn(process.execPath,[path.join(root,'scripts/verify-memory-public-live.mjs'),file,'--no-write'],
  {cwd:root,stdio:['ignore','pipe','inherit'],windowsHide:true});
let stdout='';child.stdout.on('data',data=>stdout+=data);
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
assert.equal(code,0);const common=JSON.parse(stdout.trim());
const result={version:'memory-architecture-integrity-v1',passed:true,checkedAt:new Date().toISOString(),
  results:common.results,sourceReferences,formalMemories:929,judgmentStages:60,claimProvenanceEntries:details.finalClaimProvenance.length,
  budget:{registration:budget.budgetRegistration,attempt:budget.attempt,ledger:budget.ledger,limits:budget.limits}};
const output=absolute.replace(/-results\.json$/,'-integrity.json');assert.notEqual(output,absolute);
if(!process.argv.includes('--no-write'))await writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result));
