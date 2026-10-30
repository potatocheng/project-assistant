// Offline integrity for incremental producers and the separate frozen-memory diagnostic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { verifyQaStructuredRecordedBudget } from './memory-qa-structured-budget.mjs';
import { capturedEvaluationReferences, validateStructuredClaimProvenance, selectedEvaluationReferences } from './memory-qa-structured-capture.mjs';
import { frozenMemorySemanticHash } from './memory-qa-structured-freeze.mjs';
import { isolatedJudgeTasks, parseIsolatedJudgeResponse } from './memory-qa-structured-judges.mjs';
import { budgetCanonical } from './memory-public-live-budget.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'), root=path.resolve(import.meta.dirname,'..');
export function verifyStructuredJudgeInputs(report, raw, fixture, baseline) {
  if (report.diagnostic?.arm === 'baseline') { assert.equal(raw.filter(r=>r.phase==='judge').length,0); return {questions:0,stages:0}; }
  let stages=0;
  for (const paper of report.documents) for (const actual of paper.questions) {
    const doc=fixture.documents.find(d=>d.id===paper.id),question=doc?.queries.find(q=>q.id===actual.id);
    assert.ok(question);
    const baselineActual=baseline.documents.find(p=>p.id===paper.id)?.questions.find(q=>q.id===actual.id);
    const tasks=isolatedJudgeTasks({doc,paper,question,actual,baselineActual,mode:report.judgeMode}),judgment=report.judgments.find(j=>j.id===actual.id);
    assert.ok(judgment); assert.deepEqual(judgment.anonymousOrder,tasks.find(t=>t.phase==='answer').order);
    for (const task of tasks) {
      const receipts=raw.filter(r=>r.phase==='judge'&&r.questionId===actual.id&&r.judgeStage===task.phase);
      const repairs=(report.evaluationRepairs??[]).filter(r=>r.questionId===actual.id&&r.phases?.includes(task.phase));
      assert.equal(receipts.length,1+repairs.length);
      for (const r of receipts) {
        assert.equal(r.paperId,paper.id); assert.deepEqual(JSON.parse(r.request.messages.at(-1).content),JSON.parse(JSON.stringify(task.input)));
        const suffix=r.evaluationRepair===true?' Format-only repair: return strictly parseable JSON. Use short plain English reasons without quotation marks, backslashes or embedded newlines inside string values. The evaluation criteria are unchanged.':'';
        assert.equal(r.request.messages[0].content,task.system+suffix);
      }
      const last=receipts.at(-1),response=JSON.parse(last.responseText);
      const parsed=parseIsolatedJudgeResponse(response.choices[0].message.content,task,new Set(paper.memories.map(m=>m.id)),response.choices[0].finish_reason);
      assert.deepEqual(parsed.value,judgment.stages[task.phase]);stages++;
    }
  }
  return {questions:report.judgments.length,stages};
}
export async function verifyStructuredReport(report, bytes, raw, { rootDirectory=root }={}) {
  const rroot=rootDirectory;
  assert.equal(report.complete,true); assert.equal(report.haltReason,null); assert.equal(report.binaryUnchanged,true);
  assert.equal(report.productionUnchanged,true); assert.equal(report.evaluationUnchanged,true);
  const snapshot=path.resolve(rroot,report.productionSnapshot), evalSnapshot=path.resolve(rroot,report.evaluationSnapshot);
  assert.equal(hash(await readFile(path.join(snapshot,process.platform==='win32'?'pm-host.exe':'pm-host'))),report.binarySha256);
  for (const [f,sha] of Object.entries(report.productionSha256)) assert.equal(hash(await readFile(path.join(snapshot,f))),sha);
  for (const [f,sha] of Object.entries(report.evaluationSha256)) assert.equal(hash(await readFile(path.join(evalSnapshot,f))),sha);
  assert.equal(raw.length,report.receipts.length); assert.equal(new Set(raw.map(r=>r.index)).size,raw.length);
  let tokens=0;
  for(const r of raw) {
    const {request,responseText,...meta}=r; assert.deepEqual(meta,report.receipts.find(t=>t.index===r.index));
    assert.equal(hash(JSON.stringify(request)),r.requestSha256); assert.equal(request.model,report.model); assert.equal(r.status,200);
    const upstream=JSON.parse(responseText); assert.deepEqual(upstream.usage,r.usage); tokens+=r.usage.total_tokens;
    if(r.phase!=='judge') for(const field of ['humanAnswers','goldParagraphs','humanEvidenceAlternatives','acceptableEvidenceSets','expectedAnswers'])
      assert.equal(Object.hasOwn(JSON.parse(request.messages.at(-1).content),field),false);
  }
  assert.equal(tokens,report.usage.total_tokens);
  if(process.env.DEEPSEEK_API_KEY) {assert.equal(bytes.includes(process.env.DEEPSEEK_API_KEY),false); assert.equal(JSON.stringify(raw).includes(process.env.DEEPSEEK_API_KEY),false);}
  const provenance=[];
  for(const paper of report.documents) {
    assert.equal(paper.qaReadOnly,true); assert.equal(paper.harnessError,undefined);
    for(const q of paper.questions) for(const entry of ['desktop','connector']) {
      const value=q.entries[entry]; assert.ok(value); assert.equal(value.scopeViolation,false); assert.equal(value.provenanceFailure,undefined);
      const entryRaw=raw.filter(r=>r.phase==='qa'&&r.paperId===paper.id&&r.questionId===q.id&&r.entry===entry);
      assert.deepEqual(value.receiptIds,entryRaw.map(r=>r.index));
      assert.deepEqual(value.generations.map(g=>g.receiptId),entryRaw.filter(r=>r.task==='generation').map(r=>r.index));
      for(const g of value.generations) {
        const receipt=raw.find(r=>r.index===g.receiptId); assert.ok(receipt); assert.equal(receipt.task,'generation');
        const input=JSON.parse(receipt.request.messages.at(-1).content);
        assert.deepEqual(g.references,capturedEvaluationReferences(input));
        assert.deepEqual(g.rawReferences,input.references??input.context?.memories??[]);
        assert.deepEqual(g.output,JSON.parse(JSON.parse(receipt.responseText).choices[0].message.content));
      }
      if(value.result) { const checked=validateStructuredClaimProvenance(value); assert.deepEqual(checked,value.producerProvenance);
        assert.deepEqual(selectedEvaluationReferences(value),value.evaluationProducerReferences); provenance.push({questionId:q.id,entry,...checked}); }
    }
  }
  if(report.diagnostic) {
    assert.equal(report.diagnostic.kind,'fixed-confirmed-memory-qa-only'); assert.equal(report.diagnostic.suppliedPackFrozen,false);
    const frozenBytes=await readFile(path.resolve(rroot,report.diagnostic.frozenReport)); assert.equal(hash(frozenBytes),report.diagnostic.frozenReportSha256);
    const frozen=await readPublicLiveReport(path.resolve(rroot,report.diagnostic.frozenReport));
    assert.equal(report.receipts.filter(r=>r.phase==='extraction').length,0);
    for(const paper of report.documents) {
      const original=frozen.documents.find(p=>p.id===paper.id); assert.ok(original);
      assert.equal(frozenMemorySemanticHash(paper),frozenMemorySemanticHash(original)); assert.equal(paper.frozenMemory.semanticSha256,frozenMemorySemanticHash(original));
    }
    if(report.diagnostic.arm==='baseline') { assert.equal(report.judgments.length,0); assert.equal(report.receipts.filter(r=>r.phase==='judge').length,0); }
    else { assert.equal(report.diagnostic.arm,'candidate'); assert.equal(report.judgments.length,20); }
  }
  const fixtureManifest=JSON.parse(await readFile(path.join(rroot,'docs/memory-public-dataset-manifest.json')));
  const fixture=JSON.parse(await readFile(path.resolve(rroot,fixtureManifest.fixture))),baseline=await readPublicLiveReport(path.resolve(rroot,report.baseline.file));
  const judgeInputs=verifyStructuredJudgeInputs(report,raw,fixture,baseline);
  return {judgeInputs,finalClaimProvenance:provenance,producerPackMethod:'union of actual selected contexts, not one supplied pack',diagnostic:report.diagnostic??null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const file=process.argv[2]; if(!file||file.startsWith('--')) throw new Error('Usage: node verify-memory-qa-structured-results.mjs REPORT [--no-write]');
  const reportBytes=await readFile(path.resolve(root,file)), report=await readPublicLiveReport(path.resolve(root,file));
  if(!report.outputTag?.startsWith('qa-structured-')) throw new Error('Structured verifier accepts only its round');
  let common={results:[]};
  if(report.diagnostic?.arm!=='baseline') {
    const child=spawn(process.execPath,[path.join(root,'scripts/verify-memory-public-live.mjs'),file,'--no-write'],{cwd:root,stdio:['ignore','pipe','inherit'],windowsHide:true});
    let stdout=''; child.stdout.on('data',b=>stdout+=b);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    if(code!==0) throw new Error(`Common live integrity failed: ${code}`); common=JSON.parse(stdout.trim());
  }
  const transcript=await readFile(path.resolve(root,report.workspace,'receipts.jsonl')),
    raw=transcript.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const details=await verifyStructuredReport(report,reportBytes,raw), budget=await verifyQaStructuredRecordedBudget(root,report);
  if(!common.results.length) common.results.push({file,sha256:hash(reportBytes),transcriptSha256:hash(transcript),requests:raw.length,totalTokens:report.usage.total_tokens,
    questions:report.documents.reduce((n,p)=>n+p.questions.length,0),formalMemories:report.documents.reduce((n,p)=>n+p.memories.length,0),passed:true});
  const result={...common,structured:details,structuredBudget:{registration:budget.budgetRegistration,ledger:budget.ledger,historical:budget.historical.map(r=>({name:r.name,requests:r.ledger.requests,totalTokens:r.ledger.totalTokens})),attempt:budget.attempt}};
  const output=path.resolve(root,file).replace(/-results\.json$/,'-integrity.json'); if(output===path.resolve(root,file)) throw new Error('Integrity cannot overwrite input');
  if(!process.argv.includes('--no-write')) await writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,passed:true,results:result.results,claimProvenanceEntries:details.finalClaimProvenance.length,budget:result.structuredBudget}));
}
