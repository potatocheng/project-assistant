import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { budgetHash, budgetCanonical } from './memory-public-live-budget.mjs';
import { validateArchitectureReferences } from './memory-architecture-evaluation.mjs';
import { projectReference, validateProjectReference, validateAmendedReferences, assertResumeContinuity,
  deriveCorrectedReport, assertOnlyTechnicalChanges, falsePositive } from './amend-memory-architecture-project-reference.mjs';

function fixture(){
  const project={id:'p',name:'Project A',description:'Description',goal:'Deliver',status:'active',targetDate:null,
    updatedAt:'2026-10-20',taskSummary:{updatedAt:null}};
  const paper={id:'paper',projectId:'p',sourceId:'s',sourceSha256:budgetHash('source'),memories:[{id:'m'}],segments:[{id:'g',text:'Full source text.'}]};
  const memory={id:'memory:m',kind:'memory',projectId:'p',content:'Stored fact.'};
  const reference={...projectReference(project),sourceTitle:null,referenceIndex:2};delete reference.projectId;delete reference.updatedAt;
  const source={id:'source:s:g',kind:'source_passage',sourceId:'s',segmentId:'g',sourceHash:paper.sourceSha256,
    contentHash:budgetHash(paper.segments[0].text),content:paper.segments[0].text,evidenceLabel:'导入原文（非正式记忆）'};
  const actual={scopeViolation:true,referenceIntegrityFailure:falsePositive,receiptIds:[1],
    generations:[{receiptId:1,references:[memory,reference,source],output:{claims:[]}}],result:{answer:'Unchanged answer',claims:[],citations:[]}};
  const report={workspace:'.local-data/original',limits:{requests:300},receipts:[{index:1}],judgments:[],
    documents:[{...paper,questions:[{id:'q',entries:{desktop:actual}}]}]};
  return {project,paper,memory,reference,source,actual,report};
}

test('reproduces frozen validator false positive and accepts the independently verified project',()=>{
  const f=fixture();assert.throws(()=>validateArchitectureReferences(f.actual,f.paper),new RegExp(falsePositive));
  const before=budgetCanonical(f.actual),checked=validateAmendedReferences(f.actual,f.paper,f.project);
  assert.deepEqual(checked,{projectReferences:1,integrity:{sourceReferences:1,formalMemoryCount:1,sourceContent:'exact-frozen-segment'}});
  assert.equal(budgetCanonical(f.actual),before);
});

test('project reference must match frozen identity, complete content and metadata exactly',()=>{
  const f=fixture();
  for(const change of [{id:'project:foreign'},{kind:'memory'},{title:'Forged'},{content:'Deliver'},
    {projectId:null},{projectId:'foreign'},{sourceTitle:'A paper'},{memoryId:'m'},{sourceId:'s'},
    {revision:1},{updatedAt:'tomorrow'},{referenceIndex:0},{record:{...f.project,goal:'Changed'}}]){
    assert.throws(()=>validateProjectReference({...f.reference,...change},'p',f.project),JSON.stringify(change));
  }
  assert.throws(()=>validateProjectReference(f.reference,'foreign',f.project));
  assert.throws(()=>validateAmendedReferences(f.actual,f.paper,undefined));
});

test('production formatting preserves statuses, dates, description and latest task update',()=>{
  const f=fixture();assert.equal(projectReference(f.project).content,'目标：Deliver；状态：进行中；目标日期：未记录。Description');
  const changed={...f.project,status:'completed',targetDate:'2026-11-01',taskSummary:{updatedAt:'2026-10-21'}};
  const ref=projectReference(changed);assert.equal(ref.content,'目标：Deliver；状态：已完成；目标日期：2026-11-01。Description');
  assert.equal(ref.updatedAt,'2026-10-21');
});

test('first-project filtering preserves inherited scope for all remaining references',()=>{
  const f=fixture(),project={...f.reference,referenceIndex:1,projectId:'p'},memory={...f.memory};delete memory.projectId;
  f.actual.generations[0].references=[project,memory,f.source];
  assert.equal(validateAmendedReferences(f.actual,f.paper,f.project).integrity.sourceReferences,1);
  memory.projectId=null;assert.throws(()=>validateAmendedReferences(f.actual,f.paper,f.project),/scope/);
  delete memory.projectId;delete project.projectId;assert.throws(()=>validateAmendedReferences(f.actual,f.paper,f.project),/scope/);
});

test('project allowance does not weaken frozen memory or complete source validation',()=>{
  for(const mutate of [f=>f.source.content='Truncated',f=>f.source.sourceHash=budgetHash('other'),
    f=>f.source.projectId='foreign',f=>f.memory.id='memory:other',f=>f.source.memoryId='m']){
    const f=fixture();mutate(f);assert.throws(()=>validateAmendedReferences(f.actual,f.paper,f.project));
  }
});

test('project citations must be exact and shown to a generation',()=>{
  const f=fixture();f.actual.result.citations=[projectReference(f.project)];
  assert.equal(validateAmendedReferences(f.actual,f.paper,f.project).projectReferences,1);
  f.actual.result.citations[0].content='Forged';assert.throws(()=>validateAmendedReferences(f.actual,f.paper,f.project));
  f.actual.result.citations=[projectReference(f.project)];f.actual.generations[0].references=[f.memory];
  assert.throws(()=>validateAmendedReferences(f.actual,f.paper,f.project),/not shown/);
});

test('resume preserves exact original receipts, completed entries, judgments and limits',()=>{
  const f=fixture(),original=structuredClone(f.report),current=structuredClone(original),raw=Buffer.from('first\n');
  current.receipts.push({index:2});current.judgments.push({id:'new',score:'yes'});
  assert.equal(assertResumeContinuity(original,current,raw,Buffer.from('first\nsecond\n')).entries,1);
  assert.throws(()=>assertResumeContinuity(original,current,raw,Buffer.from('changed\n')),/receipt bytes/);
  for(const mutate of [r=>r.limits.requests++,r=>r.receipts[0].index=9,
    r=>r.documents[0].questions[0].entries.desktop.result.answer='New answer']){
    const changed=structuredClone(current);mutate(changed);assert.throws(()=>assertResumeContinuity(original,changed,raw,raw));
  }
  original.judgments=[{id:'old',score:'yes'}];current.judgments=[{id:'old',score:'no'}];
  assert.throws(()=>assertResumeContinuity(original,current,raw,raw),/judgment/);
});

test('derived view changes only the three documented technical fields',()=>{
  const f=fixture(),before=budgetCanonical(f.report),result=deriveCorrectedReport(f.report,f.report,new Map([['p',f.project]]));
  assert.equal(result.patches.length,3);assert.equal(result.projectChecks[0].references,1);
  assert.equal(result.corrected.documents[0].questions[0].entries.desktop.scopeViolation,false);
  assert.equal(budgetCanonical(f.report),before);
  for(const mutate of [r=>r.documents[0].questions[0].entries.desktop.result.answer='Changed',
    r=>r.receipts.push({index:2}),r=>r.judgments.push({score:'yes'}),r=>r.limits.requests++,r=>r.complete=true]){
    const changed=structuredClone(result.corrected);mutate(changed);assert.throws(()=>assertOnlyTechnicalChanges(f.report,changed,result.patches));
  }
});

test('amendment cannot excuse an unrelated or additional failure',()=>{
  const f=fixture();f.actual.referenceIntegrityFailure='Other error';
  assert.throws(()=>deriveCorrectedReport(f.report,f.report,new Map([['p',f.project]])));
  f.actual.referenceIntegrityFailure=falsePositive;f.actual.generations[0].references=[f.memory];
  assert.throws(()=>deriveCorrectedReport(f.report,f.report,new Map([['p',f.project]])),/no validated project/);
  f.report.documents[0].questions[0].entries.connector=structuredClone(f.actual);
  assert.throws(()=>deriveCorrectedReport(f.report,f.report,new Map([['p',f.project]])),/single/);
});

test('all frozen evaluation file hashes remain equal to the immutable halted run',async()=>{
  const root=path.resolve(import.meta.dirname,'..'),haltFile=path.join(root,'docs/memory-architecture-v2-reference-halt.json');
  let halt;try{halt=JSON.parse(await readFile(haltFile));}catch(error){if(error.code==='ENOENT')return;throw error;}
  const report=JSON.parse(await readFile(path.join(root,halt.archive,'results.json')));
  assert.equal(Object.keys(report.evaluationSha256).length,24);
  for(const [file,sha]of Object.entries(report.evaluationSha256))assert.equal(budgetHash(await readFile(path.join(root,file))),sha,file);
});
