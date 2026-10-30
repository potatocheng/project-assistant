// Independent, offline technical amendment. Intentionally outside the frozen
// evaluation manifest: the original runner, receipts and judgments stay intact.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { budgetHash, budgetCanonical } from './memory-public-live-budget.mjs';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { copyFrozenPaperWorkspace, frozenMemorySemanticHash } from './memory-qa-structured-freeze.mjs';
import { capturedEvaluationReferences } from './memory-qa-structured-capture.mjs';
import { verifyStructuredReport } from './verify-memory-qa-structured-results.mjs';
import { isolatedJudgeTasks, combineIsolatedJudgments } from './memory-qa-structured-judges.mjs';
import { architectureBaselineFile, prepareArchitectureBudget, validateArchitectureReferences,
  verifyArchitecturePreLive } from './memory-architecture-evaluation.mjs';

const root=path.resolve(import.meta.dirname,'..');
export const falsePositive='Architecture reference memory not in frozen store';
const canonicalHash=value=>budgetHash(budgetCanonical(value));
const same=(a,b,message)=>assert.equal(budgetCanonical(a),budgetCanonical(b),message);
const entryRows=report=>report.documents.flatMap((paper,pi)=>paper.questions.flatMap((question,qi)=>
  Object.entries(question.entries).map(([entry,actual])=>({paper,question,entry,actual,pi,qi}))));
const entryKey=row=>`${row.paper.id}/${row.question.id}/${row.entry}`;
const isProject=ref=>ref.kind==='project'||ref.id?.startsWith('project:');

export function projectReference(record) {
  assert.equal(typeof record.id,'string');assert.equal(typeof record.name,'string');
  const text=key=>typeof record[key]==='string'?record[key]:'';
  const status={todo:'未开始',in_progress:'进行中',blocked:'阻塞',done:'已完成',cancelled:'已取消',
    completed:'已完成',planned:'待启动',on_hold:'暂停'}[record.status]??'进行中';
  return {id:`project:${record.id}`,kind:'project',projectId:record.id,title:record.name,
    content:`目标：${text('goal')}；状态：${status}；目标日期：${typeof record.targetDate==='string'?record.targetDate:'未记录'}。${text('description')}`,
    updatedAt:[record.updatedAt,record.taskSummary?.updatedAt].filter(v=>typeof v==='string').sort().at(-1)??null};
}

export function validateProjectReference(ref,projectId,record) {
  const expected=projectReference(record);
  assert.equal(projectId,record.id,'Project reference crossed project scope');
  for(const key of ['id','kind','title','content'])assert.equal(ref[key],expected[key],`Project reference ${key} differs from frozen project`);
  if(Object.hasOwn(ref,'projectId'))assert.equal(ref.projectId,record.id,'Explicit project scope differs');
  if(Object.hasOwn(ref,'sourceTitle'))assert.equal(ref.sourceTitle,null,'Project cannot inherit a source title');
  if(Object.hasOwn(ref,'updatedAt'))assert.equal(ref.updatedAt,expected.updatedAt,'Project timestamp differs');
  if(Object.hasOwn(ref,'record'))same(ref.record,record,'Project record differs from frozen context');
  if(Object.hasOwn(ref,'referenceIndex'))assert.ok(Number.isSafeInteger(ref.referenceIndex)&&ref.referenceIndex>0);
  const allowed=new Set(['id','kind','projectId','title','content','updatedAt','sourceTitle','referenceIndex','record']);
  for(const key of Object.keys(ref))assert.ok(allowed.has(key),`Unexpected project field ${key}`);
  return expected;
}

// Only the typed project records are removed from this temporary validation
// view. All other references still pass the unchanged frozen validator. Resolve
// inherited project IDs before filtering, including when the first ref is project.
export function validateAmendedReferences(actual,paper,record) {
  let projectReferences=0;const shown=new Set();
  const generations=(actual.generations??[]).map(generation=>{
    const refs=generation.references??[];
    return {...generation,references:refs.flatMap(ref=>{
      const project=Object.hasOwn(ref,'projectId')?ref.projectId:refs[0]?.projectId;
      if(!isProject(ref))return [{...ref,projectId:project}];
      assert.ok(record,'No frozen project authority');assert.equal(record.id,paper.projectId);
      validateProjectReference(ref,project,record);projectReferences++;shown.add(ref.id);return [];
    })};
  });
  const citations=(actual.result?.citations??[]).filter(ref=>{
    if(!isProject(ref))return true;
    validateProjectReference(ref,ref.projectId,record);
    assert.ok(shown.has(ref.id),'Project citation was not shown to a generation');return false;
  });
  return {integrity:validateArchitectureReferences({...actual,generations,result:{...actual.result,citations}},paper),projectReferences};
}

export function assertResumeContinuity(archived,current,archivedRaw,currentRaw) {
  assert.ok(Buffer.isBuffer(archivedRaw)&&Buffer.isBuffer(currentRaw));
  assert.ok(currentRaw.subarray(0,archivedRaw.length).equals(archivedRaw),'Original receipt bytes changed');
  for(const key of ['outputTag','split','judgeMode','expectedQuestions','expectedPapers','startedAt','model','datasetSha256',
    'productionSha256','evaluationSha256','binarySha256','workspace','limits','baseline','budgetRegistration',
    'priorBudgetLedger','architecture','preLiveEvidence','productionSnapshot','evaluationSnapshot'])same(current[key],archived[key],`Resume changed ${key}`);
  same(current.receipts.slice(0,archived.receipts.length),archived.receipts,'Original receipt metadata changed');
  const finalRows=new Map(entryRows(current).map(row=>[entryKey(row),row]));
  for(const row of entryRows(archived))same(finalRows.get(entryKey(row))?.actual,row.actual,'Original completed entry changed');
  for(const judgment of archived.judgments)same(current.judgments.find(j=>j.id===judgment.id),judgment,'Original judgment changed');
  return {receiptBytes:archivedRaw.length,requests:archived.receipts.length,entries:entryRows(archived).length,
    judgments:archived.judgments.length,receiptPrefixSha256:budgetHash(archivedRaw)};
}

export function deriveCorrectedReport(current,archived,projects) {
  const corrections=entryRows(archived).filter(r=>r.actual.scopeViolation===true);
  assert.equal(corrections.length,1,'Amendment must match the single archived technical failure');
  assert.equal(corrections[0].actual.referenceIntegrityFailure,falsePositive);
  assert.equal(corrections[0].actual.referenceIntegrity,undefined);
  const permitted=new Set(corrections.map(entryKey)),corrected=structuredClone(current),patches=[],projectChecks=[];
  for(const row of entryRows(corrected)){
    const {integrity,projectReferences}=validateAmendedReferences(row.actual,row.paper,projects.get(row.paper.projectId));
    if(projectReferences)projectChecks.push({paperId:row.paper.id,questionId:row.question.id,entry:row.entry,projectId:row.paper.projectId,
      references:projectReferences,generationReceipts:row.actual.generations.filter(g=>g.references.some(isProject)).map(g=>g.receiptId)});
    if(!permitted.has(entryKey(row))){
      assert.equal(row.actual.scopeViolation,false,'An unapproved failure remains');
      assert.equal(row.actual.referenceIntegrityFailure,undefined);same(row.actual.referenceIntegrity,integrity);continue;
    }
    same(row.actual,corrections[0].actual,'Archived faulty entry changed');
    assert.ok(projectReferences>0,'False positive has no validated project reference');
    const base=`/documents/${row.pi}/questions/${row.qi}/entries/${row.entry}`;
    patches.push({op:'replace',path:`${base}/scopeViolation`,before:true,value:false},
      {op:'remove',path:`${base}/referenceIntegrityFailure`,before:falsePositive},
      {op:'add',path:`${base}/referenceIntegrity`,value:integrity});
    row.actual.scopeViolation=false;delete row.actual.referenceIntegrityFailure;row.actual.referenceIntegrity=integrity;
  }
  assert.equal(patches.length,3,'Only one failure may be amended');
  assertOnlyTechnicalChanges(current,corrected,patches);
  return {corrected,patches,projectChecks};
}

export function assertOnlyTechnicalChanges(original,corrected,patches) {
  assert.equal(patches.length,3);const restored=structuredClone(corrected);
  const base=patches[0].path.replace(/\/scopeViolation$/,'');
  assert.match(base,/^\/documents\/\d+\/questions\/\d+\/entries\/(desktop|connector)$/);
  same(patches.map(p=>[p.op,p.path]),[['replace',base+'/scopeViolation'],['remove',base+'/referenceIntegrityFailure'],['add',base+'/referenceIntegrity']]);
  const object=base.split('/').slice(1).reduce((value,key)=>value[key],restored);
  assert.equal(object.scopeViolation,false);assert.equal(object.referenceIntegrityFailure,undefined);
  same(object.referenceIntegrity,patches[2].value);
  object.scopeViolation=true;object.referenceIntegrityFailure=falsePositive;delete object.referenceIntegrity;
  same(restored,original,'Amendment changed a field beyond the three allowed derived fields');
}

async function immutable(file,bytes) {
  try{await writeFile(file,bytes,{flag:'wx'});}catch(error){
    if(error.code!=='EEXIST'||!(await readFile(file)).equals(Buffer.from(bytes)))throw error;
  }
}
function host(binary,workspace) {
  const child=spawn(binary,[workspace],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true}),pending=new Map();let next=0;
  const lines=createInterface({input:child.stdout});child.stderr.on('data',()=>{});
  const stopped=new Promise(resolve=>child.once('close',resolve));
  const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',fail);child.on('exit',()=>fail(new Error('Offline host exited')));
  lines.on('line',line=>{let reply;try{reply=JSON.parse(line);}catch(error){fail(error);return;}
    const p=pending.get(reply.id);if(!p)return;pending.delete(reply.id);clearTimeout(p.timer);
    reply.ok?p.resolve(reply.data):p.reject(new Error(reply.error?.message??'Offline host error'));
  });
  return {call(command,payload={}){
    assert.ok(command==='get_state'||command==='ask_assistant'&&payload.useModel===false,'Offline host command whitelist');
    return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Offline host timeout'));},30000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,command,payload})+'\n');});
  },async stop(){child.kill();await stopped;lines.close();}};
}

async function frozenProjectAuthority(report,frozen) {
  const binary=path.join(root,report.productionSnapshot,process.platform==='win32'?'pm-host.exe':'pm-host');
  assert.equal(budgetHash(await readFile(binary)),report.binarySha256,'Frozen binary changed');
  const directory=await mkdtemp(path.join(root,'.local-data/memory-architecture-amendment-'));
  const needed=new Set(entryRows(report).filter(row=>row.actual.generations?.some(g=>g.references.some(isProject))).map(row=>row.paper.projectId));
  const projects=new Map(),evidence=[];
  for(const projectId of needed){
    const original=frozen.documents.find(p=>p.projectId===projectId),paper=report.documents.find(p=>p.projectId===projectId);assert.ok(original&&paper);
    const workspace=path.join(directory,`paper-${evidence.length}`),copy=await copyFrozenPaperWorkspace(root,original,workspace);
    same(copy.files,paper.frozenMemory.files,'Frozen source database differs from the run creation snapshot');
    same(copy.sourceWorkspace,paper.frozenMemory.sourceWorkspace);const h=host(binary,workspace);
    try{
      const state=await h.call('get_state'),identity=state.projects.filter(p=>p.id===projectId);assert.equal(identity.length,1);
      const context=(await h.call('ask_assistant',{projectId,question:'项目概览',date:'2026-10-20',useModel:false})).context;
      const records=context.projects.filter(p=>p.id===projectId);assert.equal(records.length,1);const record=records[0];
      assert.equal(record.name,identity[0].name);assert.equal(record.description,Array.from(identity[0].description).slice(0,2000).join(''));
      assert.equal(context.projectId,projectId);projects.set(projectId,record);
      const source=state.sources.find(s=>s.id===original.sourceId);assert.equal(source.projectId,projectId);assert.equal(source.sha256,original.sourceSha256);
      const currentMemories=state.memories.filter(m=>m.projectId===projectId).map(m=>m.id).sort();
      same(currentMemories,original.memories.map(m=>m.id).sort());
      for(const [name,sha]of Object.entries(copy.files))assert.equal(budgetHash(await readFile(path.resolve(root,original.workspace,name))),sha,'Source SQLite changed');
      evidence.push({paperId:paper.id,projectId,workspace:path.relative(root,workspace),copy,
        commands:[{command:'get_state',project:identity[0],source,memoryIds:currentMemories},{command:'ask_assistant',useModel:false,project:record}],
        projectReference:projectReference(record),binarySha256:report.binarySha256});
    }finally{await h.stop();}
  }
  const file=path.join(directory,'frozen-project-authority.json'),bytes=JSON.stringify({providerCalls:0,evidence},null,2);
  await immutable(file,bytes);return {projects,evidence:{file:path.relative(root,file),sha256:budgetHash(bytes)}};
}

function parseArgs(args) {
  const options={};for(let i=0;i<args.length;i++){
    if(args[i]==='--inspect'){options.inspect=true;continue;}
    assert.ok(['--halt','--current','--output','--amendment','--integrity'].includes(args[i]),'Unknown argument');
    const key=args[i].slice(2),value=args[++i];assert.ok(value&&!value.startsWith('--'));assert.equal(options[key],undefined);options[key]=path.resolve(root,value);
  }
  for(const key of ['halt','current',...(options.inspect?[]:['output','amendment','integrity'])])assert.ok(options[key],`Missing --${key}`);
  return options;
}

export async function runTechnicalAmendment(args=process.argv.slice(2)) {
  const options=parseArgs(args),haltBytes=await readFile(options.halt),halt=JSON.parse(haltBytes),archive=path.resolve(root,halt.archive);
  assert.equal(halt.version,'architecture-reference-halt-archive-v1');
  const artifacts={};for(const name of ['progress.json','results.json','receipts.jsonl','compact-results.json']){
    artifacts[name]=await readFile(path.join(archive,name));assert.equal(budgetHash(artifacts[name]),halt.hashes[name],`Immutable halt artifact changed: ${name}`);
  }
  assert.ok(artifacts['progress.json'].equals(artifacts['results.json']));
  const archived=JSON.parse(artifacts['results.json']);assert.equal(archived.workspace.replaceAll('\\','/'),halt.workspace.replaceAll('\\','/'));
  assert.equal(archived.receipts.length,halt.requests);assert.equal(archived.usage.total_tokens,halt.totalTokens);
  assert.equal(JSON.parse(artifacts['compact-results.json']).detailSha256,budgetHash(artifacts['results.json']));
  const currentBytes=await readFile(options.current),current=await readPublicLiveReport(options.current);
  const transcript=await readFile(path.resolve(root,current.workspace,'receipts.jsonl'));
  const preserved=assertResumeContinuity(archived,current,artifacts['receipts.jsonl'],transcript);
  const raw=transcript.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  for(const row of entryRows(current))for(const generation of row.actual.generations??[]){
    const receipt=raw.find(r=>r.index===generation.receiptId);assert.ok(receipt);
    assert.equal(receipt.paperId,row.paper.id);assert.equal(receipt.questionId,row.question.id);assert.equal(receipt.entry,row.entry);
    assert.equal(receipt.requestSha256,budgetHash(JSON.stringify(receipt.request)));
    same(generation.references,capturedEvaluationReferences(JSON.parse(receipt.request.messages.at(-1).content)),'Captured project/reference data differs from raw receipt');
  }
  const frozenBytes=await readFile(path.resolve(root,current.architecture.frozenReport));
  assert.equal(current.architecture.frozenReport.replaceAll('\\','/'),architectureBaselineFile);
  assert.equal(budgetHash(frozenBytes),current.architecture.frozenReportSha256);
  const frozen=await readPublicLiveReport(path.resolve(root,architectureBaselineFile));
  const authority=await frozenProjectAuthority(current,frozen),derived=deriveCorrectedReport(current,archived,authority.projects);
  if(options.inspect){const result={providerCalls:0,preserved,projectAuthority:authority.evidence,projectChecks:derived.projectChecks,patches:derived.patches};console.log(JSON.stringify(result));return result;}
  const {corrected,patches,projectChecks}=derived;assert.equal(corrected.complete,true);assert.equal(corrected.haltReason,null);
  assert.equal(corrected.architecture.kind,'frozen-confirmed-memory-qa-only');assert.equal(corrected.architecture.formalMemoryCount,929);
  assert.equal(corrected.expectedQuestions,20);assert.equal(corrected.architecture.suppliedPackFrozen,false);assert.equal(corrected.architecture.historicalBaselineAnswers,true);
  assert.equal(corrected.baseline.file.replaceAll('\\','/'),architectureBaselineFile);
  const budget=await prepareArchitectureBudget(root,{split:corrected.split,currentTag:corrected.outputTag,
    priorFile:corrected.architecture.priorReport?path.resolve(root,corrected.architecture.priorReport):null,
    model:corrected.model,datasetSha256:corrected.datasetSha256,before:corrected.startedAt,
    resumeRoot:path.resolve(root,corrected.workspace),maxRequests:corrected.limits.requests,maxTokens:corrected.limits.observedTotalTokens});
  same(corrected.budgetRegistration,budget.budgetRegistration);same(corrected.priorBudgetLedger,budget.ledger);assert.equal(corrected.architecture.attempt,budget.attempt);
  assert.ok(corrected.receipts.length<=corrected.limits.requests);assert.ok(corrected.usage.total_tokens<=corrected.limits.observedTotalTokens);
  const preLive=await verifyArchitecturePreLive(root,{currentTag:corrected.outputTag,productionSha256:corrected.productionSha256,
    binarySha256:corrected.binarySha256,evaluationSha256:corrected.evaluationSha256,registration:budget.registration,before:corrected.startedAt});
  same(corrected.preLiveEvidence,preLive);
  for(const r of raw){assert.ok(['qa','judge'].includes(r.phase));assert.ok(r.tokenReservation>0&&r.usage.total_tokens<=r.tokenReservation);}
  const outputBytes=JSON.stringify(corrected),details=await verifyStructuredReport(corrected,Buffer.from(outputBytes),raw);
  const manifest=JSON.parse(await readFile(path.join(root,'docs/memory-public-dataset-manifest.json')));
  const fixture=JSON.parse(await readFile(path.resolve(root,manifest.fixture)));let sourceReferences=0;
  for(const paper of corrected.documents){
    const original=frozen.documents.find(p=>p.id===paper.id);assert.ok(original);
    assert.equal(frozenMemorySemanticHash(paper),frozenMemorySemanticHash(original));assert.equal(paper.frozenMemory.semanticSha256,frozenMemorySemanticHash(original));
    assert.equal(paper.extraction.skipped,true);same(paper.extraction.receiptIds,[]);
    for(const actual of paper.questions){
      for(const entry of ['desktop','connector']){
        const checked=validateAmendedReferences(actual.entries[entry],paper,authority.projects.get(paper.projectId));
        same(actual.entries[entry].referenceIntegrity,checked.integrity);sourceReferences+=checked.integrity.sourceReferences;
      }
      const doc=fixture.documents.find(d=>d.id===paper.id),question=doc.queries.find(q=>q.id===actual.id),baselineActual=original.questions.find(q=>q.id===actual.id);
      const tasks=isolatedJudgeTasks({doc,paper,question,actual,baselineActual,mode:corrected.judgeMode});
      const judgment=corrected.judgments.find(j=>j.id===actual.id),combined=combineIsolatedJudgments(tasks,judgment.stages);
      for(const [key,value]of Object.entries(combined))same(judgment[key],value);
    }
  }
  assert.equal(new Set([options.current,options.halt,options.output,options.amendment,options.integrity]).size,5,'Outputs must be distinct from original evidence');
  assert.ok(!/^memory-public-live-qa-architecture-.*-results\.json$/.test(path.basename(options.output)),
    'Audited report must not masquerade as a fresh attempt');
  assert.ok(/-results\.json$/.test(options.output),'Common verifier requires a distinct -results.json input');
  await immutable(options.output,outputBytes);
  const child=spawn(process.execPath,[path.join(root,'scripts/verify-memory-public-live.mjs'),options.output,'--no-write'],
    {cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr);
  const common=JSON.parse(stdout.trim());
  // Bind the final raw report, every unchanged model/judge payload, and all
  // amendment-only tools without adding them to the pre-live frozen manifest.
  assert.ok((await readFile(options.current)).equals(currentBytes),'Current report changed while auditing');
  assert.ok((await readFile(path.resolve(root,current.workspace,'receipts.jsonl'))).equals(transcript),'Receipt transcript changed while auditing');
  const currentDetail=JSON.parse(currentBytes).artifactKind==='compact_public_live_report'?JSON.parse(currentBytes).detailFile:null;
  const amendment={version:'memory-architecture-technical-amendment-v1',createdAt:new Date().toISOString(),providerCalls:0,
    reason:'Frozen validator incorrectly classified a verified project navigation reference as formal memory. Only the three derived reference-integrity fields are corrected.',
    halt:{file:path.relative(root,options.halt),sha256:budgetHash(haltBytes),archive:halt.archive,hashes:halt.hashes},
    original:{file:path.relative(root,options.current),sha256:budgetHash(currentBytes),detailFile:currentDetail,
      ...(currentDetail?{detailSha256:budgetHash(await readFile(path.resolve(root,currentDetail)))}:{}),
      receiptFile:path.join(current.workspace,'receipts.jsonl'),receiptSha256:budgetHash(transcript),requests:current.receipts.length,totalTokens:current.usage.total_tokens},
    corrected:{file:path.relative(root,options.output),sha256:budgetHash(outputBytes)},preserved,
    unchanged:{receipts:canonicalHash(current.receipts),judgments:canonicalHash(current.judgments),
      entryPayloads:canonicalHash(entryRows(current).map(r=>({key:entryKey(r),result:r.actual.result,generations:r.actual.generations,receiptIds:r.actual.receiptIds}))),
      productionSha256:current.productionSha256,binarySha256:current.binarySha256,evaluationSha256:current.evaluationSha256,
      budgetRegistration:current.budgetRegistration,limits:current.limits,priorBudgetLedger:current.priorBudgetLedger},
    projectAuthority:authority.evidence,projectChecks,patches,verification:{structured:true,common:true,architectureSourceAndMemory:true,budget:true},
    tools:Object.fromEntries(await Promise.all(['scripts/amend-memory-architecture-project-reference.mjs','scripts/amend-memory-architecture-project-reference.test.mjs']
      .map(async file=>[file,budgetHash(await readFile(path.join(root,file)))])))};
  const amendmentBytes=JSON.stringify(amendment,null,2);await immutable(options.amendment,amendmentBytes);
  const integrity={version:'memory-architecture-integrity-v1',passed:true,checkedAt:amendment.createdAt,results:common.results,
    sourceReferences,formalMemories:929,judgmentStages:60,claimProvenanceEntries:details.finalClaimProvenance.length,
    budget:{registration:budget.budgetRegistration,attempt:budget.attempt,ledger:budget.ledger,limits:budget.limits},
    technicalAmendment:{file:path.relative(root,options.amendment),sha256:budgetHash(amendmentBytes),projectReferences:projectChecks.reduce((n,p)=>n+p.references,0)}};
  await immutable(options.integrity,JSON.stringify(integrity,null,2));
  const result={passed:true,providerCalls:0,output:path.relative(root,options.output),amendment:path.relative(root,options.amendment),
    integrity:path.relative(root,options.integrity),requests:current.receipts.length,totalTokens:current.usage.total_tokens,projectChecks,patches};
  console.log(JSON.stringify(result));return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await runTechnicalAmendment();
