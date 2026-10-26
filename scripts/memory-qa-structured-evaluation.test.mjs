import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { structuredLiveOptions } from './memory-qa-structured-options.mjs';
import { qaStructuredBudgetState, assertQaStructuredTag, assertQaStructuredPriorCoverage, structuredDevelopmentLimits } from './memory-qa-structured-budget.mjs';
import { selectedStructuredGenerationIndices, selectedEvaluationReferences, validateStructuredClaimProvenance } from './memory-qa-structured-capture.mjs';
import { copyFrozenPaperWorkspace, frozenMemorySemanticHash, assertFrozenHostMemory } from './memory-qa-structured-freeze.mjs';
import { isolatedJudgeTasks as oldTasks } from './memory-public-live-judges.mjs';
import { isolatedJudgeTasks as structuredTasks } from './memory-qa-structured-judges.mjs';
const root=path.resolve(import.meta.dirname,'..');
const registration={limits:{development:{...structuredDevelopmentLimits},full:{maxRequests:2000,maxTokens:12000000}}};
const cli=['--output-tag','qa-structured-dev','--split','development','--judge-mode','separated'];
const make=()=>{
 const refs=[{id:'memory:a',content:[{spanIndex:1,text:'Base value is A.'}]},{id:'memory:b',content:[{spanIndex:1,text:'Additional value is B.'}]}];
 const generations=refs.map((r,i)=>({receiptId:i+1,references:[{...r,content:r.content[0].text}],rawReferences:[r],output:{claims:[{text:i?'B':'A',supportSpans:[{referenceIndex:1,spanIndex:1}]}]}}));
 return {receiptIds:[1,2],generations,result:{claims:refs.map((r,i)=>({text:i?'B':'A',citationIds:[r.id],supportQuotes:[{citationId:r.id,quote:r.content[0].text}]})),queryTrace:{answerGenerationIndex:1,answerGenerationIndices:[0,1],generationRounds:[{generationIndex:0,retrievalRound:0},{generationIndex:1,retrievalRound:2}],answerClaimProvenance:[{claimIndex:1,generationIndex:0,sourceClaimIndex:1,retrievalRound:0,text:'A'},{claimIndex:2,generationIndex:1,sourceClaimIndex:1,retrievalRound:2,text:'B'}]}}};
};
test('structured options preserve common validation and dry-run needs no provider',()=>{
 const o=structuredLiveOptions([...cli,'--no-api-dry-run','--max-requests','1200','--max-tokens','6000000'],root);
 assert.equal(o.noApiDryRun,true);assert.equal(o.maxRequests,1200);assert.equal(o.maxTokens,6000000);
 for(const tail of [['--binary'],['--binary','a','--binary','b'],['--diagnostic-arm','baseline'],['--paragraph-control'],['--budget-addendum','x'],['--unknown']])assert.throws(()=>structuredLiveOptions([...cli,...tail],root));
});
test('diagnostic options require dedicated arm, same-memory source and separated judges',()=>{
 const o=structuredLiveOptions(['--output-tag','qa-structured-diag-baseline','--split','development','--judge-mode','separated','--diagnostic-arm','baseline','--frozen-memory-run','docs/frozen.json'],root);
 assert.equal(o.diagnosticArm,'baseline');assert.equal(o.frozenMemoryRun,path.join(root,'docs/frozen.json'));
 assert.throws(()=>structuredLiveOptions([...cli,'--diagnostic-arm','candidate','--frozen-memory-run','x'],root));
 assert.throws(()=>structuredLiveOptions(['--output-tag','qa-structured-dev','--split','development','--judge-mode','answers'],root));
});
test('all diagnostic arms and failed fresh attempts deduct once while only three fresh20 count',()=>{
 const ledger={entries:[{outputTag:'qa-structured-diag-baseline'},{outputTag:'qa-structured-diag-candidate'},{outputTag:'qa-structured-dev'}],requests:400,totalTokens:1800000};
 const s=qaStructuredBudgetState(registration,{split:'development',ledger,currentTag:'qa-structured-dev-v2',maxRequests:1200,maxTokens:6000000});
 assert.equal(s.attempt,2);assert.deepEqual(s.limits,{requests:800,observedTotalTokens:4200000});
 assert.throws(()=>qaStructuredBudgetState(registration,{split:'development',ledger,currentTag:'qa-structured-diag-baseline',maxRequests:1200,maxTokens:6000000}),/already spent/);
 ledger.entries.push({outputTag:'qa-structured-dev-v2'},{outputTag:'qa-structured-dev-v3'});
 assert.throws(()=>qaStructuredBudgetState(registration,{split:'development',ledger,currentTag:'qa-structured-dev-v4',maxRequests:1200,maxTokens:6000000}),/three/);
 assert.throws(()=>qaStructuredBudgetState(registration,{split:'all',ledger,currentTag:'qa-structured-full',maxRequests:2000,maxTokens:12000000}),/separate/);
 assert.throws(()=>qaStructuredBudgetState(registration,{split:'development',maxRequests:1201,maxTokens:6000000}),/exceeds/);
});
test('tag accounting cannot omit failed diagnostic runs or allocate a second full',()=>{
 for(const tag of ['qa-structured-diag-baseline','qa-structured-diag-candidate','qa-structured-dev-v3'])assert.doesNotThrow(()=>assertQaStructuredTag('development',tag));
 assert.throws(()=>assertQaStructuredTag('all','qa-structured-full-v2'));
 assert.throws(()=>assertQaStructuredPriorCoverage(null,['qa-structured-diag-baseline'],'qa-structured-dev'),/omitted/);
});
test('incremental evaluation selects actual producer union and verifies every source claim/span',()=>{
 const a=make(); assert.deepEqual(selectedStructuredGenerationIndices(a),[0,1]); assert.equal(selectedEvaluationReferences(a).length,2);
 assert.deepEqual(validateStructuredClaimProvenance(a),{mode:'explicit-multiple-producers',claimCount:2,generationIndices:[0,1]});
});
test('incremental provenance rejects omitted, forged, duplicated or off-by-one claims and support',()=>{
 for(const mutate of [a=>a.result.queryTrace.answerClaimProvenance.pop(),a=>a.result.queryTrace.answerClaimProvenance[0].claimIndex=0,
 a=>a.result.queryTrace.answerClaimProvenance[1].claimIndex=1,a=>a.result.queryTrace.answerClaimProvenance[0].sourceClaimIndex=2,
 a=>a.result.queryTrace.answerClaimProvenance[0].text='different',a=>a.result.claims[0].text='invented',
 a=>a.result.claims[0].supportQuotes[0].quote='fabricated',a=>a.result.claims[0].citationIds=['memory:other'],
 a=>a.result.queryTrace.answerClaimProvenance[1].retrievalRound=1,a=>a.generations[0].rawReferences[0].content=[],
 a=>a.generations[1].output.claims[0].supportSpans[0].referenceIndex=2,a=>a.result.queryTrace.answerGenerationIndices=[1],
 a=>a.result.queryTrace.answerGenerationIndices=[0,0],a=>a.result.queryTrace.answerGenerationIndex=0]) {const a=make();mutate(a);assert.throws(()=>validateStructuredClaimProvenance(a));}
});
test('canonical memory IDs remain equivalent and unchanged legacy singleton mapping remains valid',()=>{
 const a=make();a.result.claims[0].citationIds=['a'];a.result.claims[0].supportQuotes[0].citationId='a';assert.doesNotThrow(()=>validateStructuredClaimProvenance(a));
 const old={generations:[{receiptId:1,references:[{id:'a',content:'A'}]}],receiptIds:[1],result:{claims:[],queryTrace:{answerGenerationIndex:0}}};
 assert.deepEqual(selectedStructuredGenerationIndices(old),[0]);assert.equal(validateStructuredClaimProvenance(old).mode,'legacy-single-producer');
});
test('judge adapter preserves answer/memory prompts, gold, labels and anonymous order',()=>{
 const doc={paragraphs:[]},paper={memories:[]},question={id:'q1',question:'What?',answerable:true,expectedAnswers:['A'],acceptableEvidenceSets:[]};
 const actual={entries:{desktop:make(),connector:make()}};
 const old=oldTasks({doc,paper,question,actual,baselineActual:actual,mode:'separated'}), next=structuredTasks({doc,paper,question,actual,baselineActual:actual,mode:'separated'});
 for(const phase of ['answer','memory'])assert.deepEqual(next.find(t=>t.phase===phase),old.find(t=>t.phase===phase));
 const before=old.find(t=>t.phase==='retrieval'),after=next.find(t=>t.phase==='retrieval');
 assert.equal(after.system,before.system.replace('the LAST actual generation references CONTENT','the actual selected producer generation references CONTENT (possibly multiple contexts that jointly produced the final answer)'));
 assert.equal(after.input.entries.desktop.references.length,2);assert.deepEqual(after.input.outputSchema,before.input.outputSchema);
});
test('frozen SQLite copies preserve source/WAL hashes and semantic memory, never credentials',async()=>{
 await mkdir(path.join(root,'.local-data'),{recursive:true});const local=await mkdtemp(path.join(root,'.local-data/qa-structured-freeze-test-'));
 const source=path.join(local,'source'),destination=path.join(local,'copy');await mkdir(source);await mkdir(path.join(source,'secrets'));
 await writeFile(path.join(source,'workspace.sqlite'),'mock sqlite');await writeFile(path.join(source,'workspace.sqlite-wal'),'mock wal');await writeFile(path.join(source,'secrets','api'),'do not copy');
 const paper={workspace:path.relative(root,source),projectId:'p',sourceId:'s',sourceSha256:'h',segments:[],memories:[{id:'m',content:'A',facets:{entity:'x'},kind:'fact',quotes:[],detail:{memory:{id:'m'},revisions:[]}}]};
 const evidence=await copyFrozenPaperWorkspace(root,paper,destination);assert.equal(evidence.semanticSha256,frozenMemorySemanticHash(paper));
 assert.equal(await readFile(path.join(destination,'workspace.sqlite'),'utf8'),'mock sqlite');await assert.rejects(readFile(path.join(destination,'secrets','api')));
 await assertFrozenHostMemory({call:async cmd=>cmd==='get_state'?{memories:[{id:'m',projectId:'p'}]}:paper.memories[0].detail},paper);
 await assert.rejects(assertFrozenHostMemory({call:async cmd=>cmd==='get_state'?{memories:[{id:'m',projectId:'p'}]}:{memory:{id:'m',content:'changed'},revisions:[]}},paper));
 await assert.rejects(copyFrozenPaperWorkspace(root,paper,source),/distinct/);
});

test('unknown producer still exposes actual selected evidence while claims/provenance may be empty',()=>{
 const a=make();a.result.claims=[];a.result.queryTrace.answerGenerationIndex=0;a.result.queryTrace.answerGenerationIndices=[0];a.result.queryTrace.answerClaimProvenance=[];
 assert.equal(validateStructuredClaimProvenance(a).claimCount,0);assert.equal(selectedEvaluationReferences(a).length,1);
});

test('confirmed-memory fixture and preserved old process match before real diagnostic calls',async()=>{
 const {spawn}=await import('node:child_process');
 const child=spawn(process.execPath,['scripts/verify-memory-qa-structured-frozen-memory.mjs'],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 assert.equal(code,0,stderr);const result=JSON.parse(stdout.trim());assert.equal(result.passed,true);assert.equal(result.papers,6);assert.equal(result.memories,938);assert.equal(result.providerRequests,0);
});

test('only existing production trim normalization is allowed for raw claim text',()=>{
 const a=make();a.generations[0].output.claims[0].text='  A\n';assert.doesNotThrow(()=>validateStructuredClaimProvenance(a));
 a.generations[0].output.claims[0].text='A changed';assert.throws(()=>validateStructuredClaimProvenance(a));
});

test('selected context union cannot include a generation that contributed no final claim',()=>{
 const a=make();a.result.claims.pop();a.result.queryTrace.answerClaimProvenance.pop();
 assert.throws(()=>validateStructuredClaimProvenance(a),/actual final claim producers/);
 a.result.queryTrace.answerGenerationIndex=0;a.result.queryTrace.answerGenerationIndices=[0];assert.doesNotThrow(()=>validateStructuredClaimProvenance(a));
 const empty=make();empty.result.claims=[];empty.result.queryTrace.answerClaimProvenance=[];
 assert.throws(()=>validateStructuredClaimProvenance(empty),/actual final claim producers/);
 empty.result.queryTrace.answerGenerationIndices=[1];assert.doesNotThrow(()=>validateStructuredClaimProvenance(empty));
});

test('fresh setup initializes a wx empty transcript and explicit zero usage for auditable zero-fee failures',async()=>{
 const source=await readFile(path.join(root,'scripts/evaluate-memory-qa-structured-live.mjs'),'utf8');
 const statement="await writeFile(path.join(runRoot, 'receipts.jsonl'), '', { flag: 'wx' });";
 assert.ok(source.includes(statement));assert.ok(source.indexOf(statement)<source.indexOf('const proxy = http.createServer'));
 assert.match(source,/return sum; \}, \{ prompt_tokens:0, completion_tokens:0, total_tokens:0/);
 const dir=await mkdtemp(path.join(root,'.local-data/qa-structured-empty-transcript-test-')),file=path.join(dir,'receipts.jsonl');
 await writeFile(file,'',{flag:'wx'});assert.equal(await readFile(file,'utf8'),'');await assert.rejects(writeFile(file,'replace',{flag:'wx'}),{code:'EEXIST'});
});
