import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { budgetHash } from './memory-public-live-budget.mjs';
import { architectureRegistrationFile, architectureBaselineFile, architectureLimits, architectureTags,
  architecturePreLiveFile, architectureOptions, architectureEvaluationFiles, loadArchitectureRegistration,
  prepareArchitectureBudget, verifyArchitecturePreLive, validateArchitectureReferences,
  architectureRequestReservation } from './memory-architecture-evaluation.mjs';

const root=path.resolve(import.meta.dirname,'..'),hash=budgetHash;
async function put(directory,file,value){await mkdir(path.dirname(path.resolve(directory,file)),{recursive:true});const bytes=JSON.stringify(value);await writeFile(path.resolve(directory,file),bytes);return hash(bytes);}
async function fixture(){
  await mkdir(path.join(root,'.local-data'),{recursive:true});const directory=await mkdtemp(path.join(root,'.local-data/architecture-unit-'));
  const baseline={model:'deepseek-flash',datasetSha256:hash('fixture'),complete:true,split:'development',
    documents:[{memories:Array.from({length:929},(_,i)=>({id:`m${i}`}))}]};
  const checksum=await put(directory,architectureBaselineFile,baseline);
  const registration={version:'memory-architecture-preregistration-v1',registeredAt:'2026-10-26T01:00:00.000Z',
    model:baseline.model,datasetSha256:baseline.datasetSha256,baselineDevelopment:{file:architectureBaselineFile,sha256:checksum},
    frozenMemory:{file:architectureBaselineFile,sha256:checksum,memoryCount:929},limits:{development:architectureLimits}};
  await put(directory,architectureRegistrationFile,registration);
  const args={split:'development',currentTag:architectureTags[0],model:baseline.model,datasetSha256:baseline.datasetSha256,
    before:'2026-10-26T02:00:00.000Z',maxRequests:300,maxTokens:1_600_000};
  return {directory,registration,args,baseline};
}
async function firstRun(f){
  const budget=await prepareArchitectureBudget(f.directory,f.args);
  const report={outputTag:architectureTags[0],workspace:'.local-data/memory-architecture-live-first',split:'development',
    model:f.args.model,datasetSha256:f.args.datasetSha256,startedAt:f.args.before,finishedAt:'2026-10-26T02:30:00.000Z',
    budgetRegistration:budget.budgetRegistration,limits:budget.limits,receipts:[{index:1,usage:{total_tokens:100}}],usage:{total_tokens:100},
    productionSha256:{'qa.rs':hash('old')},binarySha256:hash('old-binary')};
  const file='docs/memory-public-live-qa-architecture-dev-results.json';await put(f.directory,file,report);
  await put(f.directory,`${report.workspace}/progress.json`,report);return {report,file,budget};
}

test('architecture options fix development20, frozen baseline, separate judges and per-attempt limits',()=>{
  const o=architectureOptions(['--output-tag',architectureTags[0]],root);
  assert.equal(o.split,'development');assert.equal(o.judges,'separated');assert.equal(o.maxRequests,300);assert.equal(o.maxTokens,1_600_000);
  assert.equal(o.frozenMemoryRun,path.resolve(root,architectureBaselineFile));
  for(const args of [['--split','all'],['--judge-mode','answers'],['--baseline','old.json'],['--paragraph-control'],
    ['--output-tag','qa-reliability-dev'],['--frozen-memory-run','another.json']])assert.throws(()=>architectureOptions(args.includes('--output-tag')?args:['--output-tag',architectureTags[0],...args],root));
});

test('registration binds unchanged latest reliability memory and independent fixed limits',async()=>{
  const f=await fixture();assert.equal((await loadArchitectureRegistration(f.directory,f.args.before)).registration.frozenMemory.memoryCount,929);
  await assert.rejects(loadArchitectureRegistration(f.directory,'2026-10-26T00:00:00.000Z'));
  await put(f.directory,architectureRegistrationFile,{...f.registration,limits:{development:{...architectureLimits,maxRequests:601}}});
  await assert.rejects(loadArchitectureRegistration(f.directory,f.args.before));
  await put(f.directory,architectureRegistrationFile,f.registration);
  await put(f.directory,architectureBaselineFile,{...f.baseline,model:'changed'});
  await assert.rejects(loadArchitectureRegistration(f.directory,f.args.before),/baseline changed/);
});

test('attempt order, preserved failed usage, exact prior ledger and original resume are enforced',async()=>{
  const f=await fixture(),{report,file}=await firstRun(f);
  await assert.rejects(prepareArchitectureBudget(f.directory,f.args),/already exists/);
  const resumed=await prepareArchitectureBudget(f.directory,{...f.args,resumeRoot:path.resolve(f.directory,report.workspace)});
  assert.equal(resumed.attempt,1);
  await assert.rejects(prepareArchitectureBudget(f.directory,{...f.args,resumeRoot:path.resolve(f.directory,'.local-data/memory-architecture-live-other')}),/original/);
  await assert.rejects(prepareArchitectureBudget(f.directory,{...f.args,maxRequests:299,resumeRoot:path.resolve(f.directory,report.workspace)}),/limits/);
  const second={...f.args,currentTag:architectureTags[1],priorFile:path.resolve(f.directory,file),before:'2026-10-26T03:00:00.000Z'};
  const next=await prepareArchitectureBudget(f.directory,second);assert.equal(next.attempt,2);assert.equal(next.ledger.totalTokens,100);assert.equal(next.ledger.requests,1);
  for(const change of [{maxRequests:301},{maxTokens:1_600_001},{currentTag:'qa-architecture-dev-v3'},{priorFile:undefined}])await assert.rejects(prepareArchitectureBudget(f.directory,{...second,...change}));
  const failed={...report,receipts:[{index:1,error:'transport failed',usage:null}],usage:{total_tokens:0}};
  await put(f.directory,file,failed);await put(f.directory,`${report.workspace}/progress.json`,failed);
  await assert.rejects(prepareArchitectureBudget(f.directory,second),/usage is incomplete/);
});

test('another workspace cannot restart a consumed tag or hide charged failures',async()=>{
  const f=await fixture(),{report}=await firstRun(f);
  await put(f.directory,'.local-data/memory-architecture-live-other/progress.json',{...report,workspace:'.local-data/memory-architecture-live-other'});
  await assert.rejects(prepareArchitectureBudget(f.directory,f.args),/unique/);
});

test('per-attempt pre-live evidence freezes code and requires a substantive second-attempt repair plan',async()=>{
  const f=await fixture(),first=await firstRun(f),loaded=await loadArchitectureRegistration(f.directory,f.args.before);
  const productionSha256={'qa.rs':hash('new')},binarySha256=hash('new-binary'),evaluationSha256={'scripts/evaluator.mjs':hash('eval')};
  const evidence={version:'memory-architecture-pre-live-v1',outputTag:architectureTags[0],passed:true,
    startedAt:'2026-10-26T01:10:00.000Z',finishedAt:'2026-10-26T01:15:00.000Z',commands:[{command:'offline tests',exitCode:0}],
    registrationSha256:loaded.budgetRegistration.sha256,productionSha256,binarySha256,evaluationSha256};
  const args={currentTag:architectureTags[0],productionSha256,binarySha256,evaluationSha256,registration:f.registration,before:f.args.before};
  await put(f.directory,architecturePreLiveFile(args.currentTag),evidence);assert.equal((await verifyArchitecturePreLive(f.directory,args)).commands,1);
  await assert.rejects(verifyArchitecturePreLive(f.directory,{...args,binarySha256:hash('forged')}));
  const repair={...evidence,outputTag:architectureTags[1],startedAt:'2026-10-26T02:40:00.000Z',finishedAt:'2026-10-26T02:50:00.000Z'};
  const second={...args,currentTag:architectureTags[1],before:'2026-10-26T03:00:00.000Z'};
  await put(f.directory,architecturePreLiveFile(second.currentTag),repair);await assert.rejects(verifyArchitecturePreLive(f.directory,second),/repair plan/);
  repair.repairPlan={priorReport:first.file,priorReportSha256:hash(await readFile(path.resolve(f.directory,first.file))),problem:'Observed omitted evidence',changes:['Preserve ranked anchors']};
  await put(f.directory,architecturePreLiveFile(second.currentTag),repair);assert.equal((await verifyArchitecturePreLive(f.directory,second)).commands,1);
});

test('source passages are exact complete frozen segments with inherited project scope and separate IDs',()=>{
  const text='Only signed requests pass.\n条件不能删。',paper={projectId:'p',sourceId:'s',sourceSha256:hash('source'),
    memories:[{id:'m'}],segments:[{id:'g',text}]};
  const ref={id:'source:s:g',kind:'source_passage',sourceId:'s',segmentId:'g',sourceHash:paper.sourceSha256,
    contentHash:hash(text),content:text,evidenceLabel:'导入原文（非正式记忆）'};
  const actual={generations:[{references:[{id:'memory:m',projectId:'p',content:'Signed requests pass.'},ref]}],
    result:{citations:[{...ref,projectId:'p'}]}};
  assert.equal(validateArchitectureReferences(actual,paper).sourceReferences,1);
  for(const change of [{projectId:'foreign'},{sourceId:'other'},{segmentId:'missing'},{memoryId:'m'},
    {content:text.slice(1)},{contentHash:hash('changed')},{sourceHash:hash('other')},{id:'memory:m'},{evidenceLabel:'formal memory'}]) {
    const altered=structuredClone(actual);Object.assign(altered.generations[0].references[1],change);
    assert.throws(()=>validateArchitectureReferences(altered,paper));
  }
  const wrong=structuredClone(actual);wrong.result.citations[0].projectId='foreign';assert.throws(()=>validateArchitectureReferences(wrong,paper));
});

test('request reservations bound input bytes and explicit output instead of spending past observed caps',()=>{
  const body={model:'deepseek-flash',max_tokens:4096,messages:[{role:'user',content:'中文😀'}]};
  assert.equal(architectureRequestReservation(body),Buffer.byteLength(JSON.stringify(body))+4096+1024);
  assert.throws(()=>architectureRequestReservation({...body,max_tokens:undefined}));
});

test('new round fingerprints all new execution and validation code without changing old runners or rules',async()=>{
  for(const name of ['scripts/evaluate-memory-architecture-live.mjs','scripts/verify-memory-architecture-results.mjs',architectureRegistrationFile,
    'scripts/memory-qa-structured-judges.mjs','scripts/memory-qa-structured-capture.mjs'])assert.ok(architectureEvaluationFiles.includes(name));
  assert.equal(new Set(architectureEvaluationFiles).size,architectureEvaluationFiles.length);
  assert.ok(!architectureEvaluationFiles.some(file=>/-pre-live|-results\.json|-metrics\.json/.test(file)));
  const runner=await readFile(path.join(root,'scripts/evaluate-memory-architecture-live.mjs'),'utf8');
  for(const forbidden of ["host.call('create_project'","host.call('import_text'","host.call('start_extraction'","host.call('confirm_proposal'"])assert.ok(!runner.includes(forbidden),forbidden);
  assert.ok(runner.includes('copyFrozenPaperWorkspace'));assert.ok(runner.includes('validateArchitectureReferences'));
});
