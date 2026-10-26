// Independent QA-only architecture round. Historical rounds remain immutable.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { budgetHash, budgetCanonical } from './memory-public-live-budget.mjs';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { publicLiveOptions } from './memory-public-live-options.mjs';

export const architectureRegistrationFile = 'docs/memory-architecture-preregistration.json';
export const architectureBaselineFile = 'docs/memory-public-live-qa-reliability-dev-results.json';
export const architectureLimits = Object.freeze({ maxRequests: 600, maxTokens: 3_200_000,
  maxFreshAttempts: 2, perAttemptRequests: 300, perAttemptTokens: 1_600_000 });
export const architectureTags = Object.freeze(['qa-architecture-dev', 'qa-architecture-dev-v2']);
export const architecturePreLiveFile = tag => `docs/memory-architecture-pre-live${tag === architectureTags[1] ? '-v2' : ''}.json`;
const equal = (a,b) => budgetCanonical(a) === budgetCanonical(b);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
export const architectureEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-architecture-live.mjs', 'scripts/memory-architecture-evaluation.mjs',
  'scripts/memory-architecture-evaluation.test.mjs', 'scripts/verify-memory-architecture-results.mjs',
  'scripts/report-memory-architecture.mjs', 'scripts/report-memory-architecture.test.mjs',
  'scripts/report-memory-qa-reliability.mjs', 'scripts/report-memory-qa-reliability.test.mjs',
  architectureRegistrationFile, 'scripts/memory-qa-structured-judges.mjs',
  'scripts/memory-qa-structured-capture.mjs', 'scripts/memory-qa-structured-freeze.mjs',
  'scripts/capture-memory-evaluation-references.mjs', 'scripts/memory-public-live-options.mjs',
  'scripts/memory-public-live-io.mjs', 'scripts/memory-public-live-budget.mjs',
  'scripts/memory-public-live-judges.mjs', 'scripts/verify-memory-qa-structured-results.mjs',
  'scripts/verify-memory-public-live.mjs', 'scripts/memory-qa-structured-budget.mjs',
  'scripts/memory-qa-structured-review-mapping.mjs', 'scripts/memory-qa-structured-observations.mjs',
  'scripts/score-memory-qa-structured-live.mjs', 'scripts/compare-memory-public-live.mjs',
]);
export async function fingerprintArchitectureEvaluation(root) {
  return Object.fromEntries(await Promise.all(architectureEvaluationFiles.map(async file =>
    [file, budgetHash(await readFile(path.resolve(root,file)))])));
}

// A UTF-8 byte is a conservative upper bound for one input token; allow chat
// framing in addition to the actual serialized request and bounded completion.
// Reservations include concurrent requests, so observed usage cannot cross a
// run's cap merely because several calls were already in flight.
export function architectureRequestReservation(body) {
  const completion=body.max_tokens??body.max_completion_tokens;
  if(!Number.isSafeInteger(completion)||completion<1||completion>32_768)throw new Error('Architecture request needs a bounded completion limit');
  return Buffer.byteLength(JSON.stringify(body),'utf8')+completion+1024;
}

export function architectureOptions(args,root) {
  const extras=new Set(['--binary','--production-source-root']);
  const values={},remaining=[];
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--no-api-dry-run') { if(values.dryRun) throw new Error('Duplicate dry run'); values.dryRun=true; continue; }
    if(!extras.has(args[i])) {remaining.push(args[i]);continue;}
    const name=args[i]; if(values[name] || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Invalid architecture option');
    values[name]=args[++i];
  }
  for(const [name,value] of [['--split','development'],['--judge-mode','separated'],['--max-requests','300'],
    ['--max-tokens','1600000'],['--baseline',architectureBaselineFile]]) if(!remaining.includes(name)) remaining.push(name,value);
  const options=publicLiveOptions(remaining,root);
  if(options.split!=='development' || options.judges!=='separated' || options.requiredGate || options.budgetAddendum
      || remaining.includes('--paragraph-control') || options.baseline!==path.resolve(root,architectureBaselineFile)
      || options.tag && !architectureTags.includes(options.tag)) throw new Error('Architecture round is fixed development20 QA-only with its registered baseline');
  return {...options,noApiDryRun:values.dryRun===true,
    binary:path.resolve(root,values['--binary']??`target/debug/${process.platform==='win32'?'pm-host.exe':'pm-host'}`),
    productionSourceRoot:path.resolve(root,values['--production-source-root']??'.'),
    frozenMemoryRun:path.resolve(root,architectureBaselineFile),
    priorFile:remaining.includes('--prior-run')?path.resolve(root,remaining[remaining.indexOf('--prior-run')+1]):null};
}

export async function loadArchitectureRegistration(root,before) {
  const bytes=await readFile(path.resolve(root,architectureRegistrationFile)),registration=JSON.parse(bytes);
  if(registration.version!=='memory-architecture-preregistration-v1' || !date(registration.registeredAt)
      || before && (!date(before)||Date.parse(registration.registeredAt)>Date.parse(before))
      || registration.model!=='deepseek-flash' || !sha(registration.datasetSha256)
      || !equal(registration.limits?.development,architectureLimits)) throw new Error('Architecture registration identity, date or limits invalid');
  const baselineBytes=await readFile(path.resolve(root,architectureBaselineFile)),baseline=await readPublicLiveReport(path.resolve(root,architectureBaselineFile));
  if(registration.baselineDevelopment?.file!==architectureBaselineFile || registration.frozenMemory?.file!==architectureBaselineFile
      || registration.baselineDevelopment.sha256!==budgetHash(baselineBytes) || registration.frozenMemory.sha256!==budgetHash(baselineBytes)
      || registration.frozenMemory.memoryCount!==929 || baseline.documents.reduce((n,p)=>n+p.memories.length,0)!==929
      || baseline.model!==registration.model || baseline.datasetSha256!==registration.datasetSha256
      || baseline.complete!==true || baseline.split!=='development') throw new Error('Architecture frozen baseline changed or is not the complete reliability memory');
  return {registration,budgetRegistration:{file:architectureRegistrationFile,sha256:budgetHash(bytes),registeredAt:registration.registeredAt,
    developmentLimits:architectureLimits,baselineSha256:registration.baselineDevelopment.sha256,frozenMemorySha256:registration.frozenMemory.sha256}};
}

function usage(report) {
  if(!Array.isArray(report.receipts)) throw new Error('Architecture attempt lacks receipts');
  let tokens=0;
  for(const [i,r] of report.receipts.entries()) {
    if(r.index!==i+1 || !count(r.usage?.total_tokens)) throw new Error('Architecture prior usage is incomplete; preserve the failed attempt and reconcile before continuing');
    tokens+=r.usage.total_tokens;
  }
  if(report.usage && report.usage.total_tokens!==tokens) throw new Error('Architecture prior usage differs from receipts');
  return {requests:report.receipts.length,totalTokens:tokens};
}

async function knownRuns(root) {
  const runs=new Map();
  const add=(report,file)=>{
    if(!report.outputTag?.startsWith('qa-architecture-'))return;
    if(!architectureTags.includes(report.outputTag)||!report.workspace)throw new Error('Unknown architecture attempt identity');
    const workspace=path.resolve(root,report.workspace);
    if(!workspace.startsWith(path.resolve(root,'.local-data')+path.sep)||!path.basename(workspace).startsWith('memory-architecture-live-'))throw new Error('Architecture workspace must stay isolated');
    const key=workspace.toLowerCase(),old=runs.get(key);
    if(old) {
      const length=Math.min(old.report.receipts.length,report.receipts.length);
      if(old.report.outputTag!==report.outputTag||!equal(old.report.receipts.slice(0,length),report.receipts.slice(0,length)))throw new Error('Architecture report and workspace receipts diverged');
      if(old.report.receipts.length>report.receipts.length)return;
    }
    runs.set(key,{report,file});
  };
  for(const name of await readdir(path.resolve(root,'docs')))if(/^memory-public-live-qa-architecture-.*-results\.json$/.test(name)) {
    const file=path.join('docs',name);add(await readPublicLiveReport(path.resolve(root,file)),file);
  }
  let dirs=[];try{dirs=await readdir(path.resolve(root,'.local-data'));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const dir of dirs.filter(name=>name.startsWith('memory-architecture-live-'))) {
    const file=path.join('.local-data',dir,'progress.json');
    try{add(JSON.parse(await readFile(path.resolve(root,file))),file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return [...runs.values()];
}

export async function prepareArchitectureBudget(root,args) {
  const evidence=await loadArchitectureRegistration(root,args.before),attempt=architectureTags.indexOf(args.currentTag)+1;
  if(!attempt||args.split!=='development'||args.model!==evidence.registration.model||args.datasetSha256!==evidence.registration.datasetSha256
      || !Number.isSafeInteger(args.maxRequests)||args.maxRequests<1||args.maxRequests>architectureLimits.perAttemptRequests
      || !Number.isSafeInteger(args.maxTokens)||args.maxTokens<1||args.maxTokens>architectureLimits.perAttemptTokens)throw new Error('Architecture run identity or per-attempt budget invalid');
  const runs=await knownRuns(root),current=runs.filter(r=>r.report.outputTag===args.currentTag),previous=runs.filter(r=>r.report.outputTag!==args.currentTag);
  if(runs.some(r=>!equal(r.report.budgetRegistration,evidence.budgetRegistration)))throw new Error('Architecture registration cannot reset existing attempts');
  for(const {report} of runs) {
    if(report.split!=='development'||report.model!==args.model||report.datasetSha256!==args.datasetSha256
        ||!Number.isSafeInteger(report.limits?.requests)||report.limits.requests<1||report.limits.requests>architectureLimits.perAttemptRequests
        ||!Number.isSafeInteger(report.limits?.observedTotalTokens)||report.limits.observedTotalTokens<1||report.limits.observedTotalTokens>architectureLimits.perAttemptTokens)
      throw new Error('Existing architecture attempt identity or limits changed');
    const spent=usage(report);
    if(spent.requests>report.limits.requests||spent.totalTokens>report.limits.observedTotalTokens)throw new Error('Existing architecture attempt exceeded its registered budget');
  }
  if(current.length>1||previous.length!==attempt-1||previous.some(r=>r.report.outputTag!==architectureTags[0]))throw new Error('Architecture attempts must be unique and ordered');
  if(args.resumeRoot) {
    if(current.length!==1||path.resolve(root,current[0].report.workspace)!==path.resolve(args.resumeRoot))throw new Error('Resume requires the original architecture workspace');
    const original=current[0].report;
    if(original.limits.requests!==args.maxRequests||original.limits.observedTotalTokens!==args.maxTokens
        || original.model!==args.model||original.datasetSha256!==args.datasetSha256)throw new Error('Architecture resume cannot change identity or limits');
    usage(original);
  } else if(current.length)throw new Error('Architecture attempt already exists; resume its original workspace');
  if(attempt===1&&args.priorFile||attempt===2&&!args.priorFile)throw new Error('Only the second architecture attempt requires its first run ledger');
  if(attempt===2) {
    const explicit=await readPublicLiveReport(args.priorFile);
    if(explicit.outputTag!==architectureTags[0]||path.resolve(root,explicit.workspace)!==path.resolve(root,previous[0].report.workspace)
        || !equal(explicit.receipts,previous[0].report.receipts)||!date(explicit.finishedAt))throw new Error('Second architecture attempt requires the exact finished first run, including failures');
  }
  const entries=previous.map(({report,file})=>({file,workspace:report.workspace,outputTag:report.outputTag,...usage(report)}));
  const ledger={entries,requests:entries.reduce((n,r)=>n+r.requests,0),totalTokens:entries.reduce((n,r)=>n+r.totalTokens,0)};
  if(ledger.requests+args.maxRequests>architectureLimits.maxRequests||ledger.totalTokens+args.maxTokens>architectureLimits.maxTokens)
    throw new Error('Architecture cumulative budget exhausted');
  return {...evidence,attempt,ledger,registeredLimits:architectureLimits,
    limits:{requests:args.maxRequests,observedTotalTokens:args.maxTokens}};
}

export async function verifyArchitecturePreLive(root,{currentTag,productionSha256,binarySha256,evaluationSha256,registration,before}) {
  const registered=await loadArchitectureRegistration(root,before),file=architecturePreLiveFile(currentTag);
  const bytes=await readFile(path.resolve(root,file)),evidence=JSON.parse(bytes);
  if(!architectureTags.includes(currentTag)||!equal(registration,registered.registration)||evidence.version!=='memory-architecture-pre-live-v1'
      || evidence.outputTag!==currentTag||evidence.passed!==true||!Array.isArray(evidence.commands)||!evidence.commands.length
      || evidence.commands.some(c=>typeof c.command!=='string'||c.exitCode!==0)||!date(evidence.startedAt)||!date(evidence.finishedAt)
      || Date.parse(evidence.startedAt)<Date.parse(registration.registeredAt)||Date.parse(evidence.finishedAt)<Date.parse(evidence.startedAt)
      || Date.parse(evidence.finishedAt)>Date.parse(before)||evidence.registrationSha256!==registered.budgetRegistration.sha256
      || !equal(evidence.productionSha256,productionSha256)||!Object.keys(productionSha256).length||!sha(binarySha256)
      || evidence.binarySha256!==binarySha256||!equal(evidence.evaluationSha256,evaluationSha256))throw new Error('Architecture pre-live checks or frozen fingerprints differ');
  if(currentTag===architectureTags[1]) {
    const repair=evidence.repairPlan;
    if(!repair||typeof repair.problem!=='string'||!repair.problem.trim()||!Array.isArray(repair.changes)||!repair.changes.length
        ||repair.changes.some(value=>typeof value!=='string'||!value.trim()))throw new Error('Second architecture attempt requires an evidence-driven repair plan');
    const priorBytes=await readFile(path.resolve(root,repair.priorReport)),prior=await readPublicLiveReport(path.resolve(root,repair.priorReport));
    if(budgetHash(priorBytes)!==repair.priorReportSha256||prior.outputTag!==architectureTags[0]||!date(prior.finishedAt)
        ||Date.parse(prior.finishedAt)>Date.parse(evidence.startedAt)||equal(prior.productionSha256,productionSha256)||prior.binarySha256===binarySha256)
      throw new Error('Second architecture attempt must change code after its recorded first-run failure analysis');
  }
  return {file,sha256:budgetHash(bytes),finishedAt:evidence.finishedAt,commands:evidence.commands.length};
}

// Indexed projections deliberately inherit a common project from their first
// reference. Source content is always checked against the full frozen segment.
export function validateArchitectureReferences(actual,paper) {
  const memoryIds=new Set(paper.memories.map(m=>m.id)),shownSources=new Set();let sourceReferences=0;
  const validateSource=(ref,project)=>{
    const segment=paper.segments.find(s=>s.id===ref.segmentId);
    if(project!==paper.projectId||ref.kind!=='source_passage'||ref.memoryId!==undefined||ref.sourceId!==paper.sourceId
        ||!segment||ref.id!==`source:${paper.sourceId}:${segment.id}`||ref.content!==segment.text
        ||ref.contentHash!==budgetHash(segment.text)||ref.sourceHash!==paper.sourceSha256
        ||ref.evidenceLabel!=='导入原文（非正式记忆）')throw new Error('Architecture source passage identity, hash or complete content mismatch');
  };
  for(const generation of actual.generations??[]) {
    const refs=generation.references??[];
    for(const ref of refs) {
      const project=Object.hasOwn(ref,'projectId')?ref.projectId:refs[0]?.projectId;
      if(project!==paper.projectId)throw new Error('Architecture reference project scope mismatch');
      if(ref.kind!=='source_passage') {
        const id=ref.memoryId??ref.id?.replace(/^memory:/,'');
        if(!memoryIds.has(id))throw new Error('Architecture reference memory not in frozen store');
        continue;
      }
      validateSource(ref,project);sourceReferences++;shownSources.add(ref.id);
    }
  }
  for(const citation of actual.result?.citations??[]) {
    if(citation.memoryId) {if(!memoryIds.has(citation.memoryId))throw new Error('Architecture citation memory scope mismatch');}
    else if(citation.kind==='source_passage'||citation.id?.startsWith('source:')) {
      validateSource(citation,citation.projectId);
      if(!shownSources.has(citation.id))throw new Error('Architecture source citation was not shown to a generation');
    }
  }
  return {sourceReferences,formalMemoryCount:memoryIds.size,sourceContent:'exact-frozen-segment'};
}
