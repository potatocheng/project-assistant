import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { budgetHash } from './memory-public-live-budget.mjs';
import { buildArchitectureMetrics, architectureMarkdown, architectureSourceChannel,
  parseArchitectureReportArgs, architectureReportPaths, assertArchitectureReportIntegrity } from './report-memory-architecture.mjs';

const entries=['desktop','connector'];
function fixtureReport(tag){
  const questions=[{id:'q0',answerable:true},{id:'q1',answerable:true},{id:'no-answer',answerable:false}]
    .map(q=>({...q,question:`Question ${q.id}?`,entries:Object.fromEntries(entries.map(entry=>[entry,{generations:[],
      result:{answer:`${tag} ${entry} answer`,status:'answered',claims:[],unknowns:[],citations:[],queryTrace:{}}}]))}));
  const usage=total=>({prompt_tokens:total-10,completion_tokens:10,total_tokens:total,prompt_cache_hit_tokens:0});
  return {version:'qasper-production-live-v2',outputTag:tag,split:'development',datasetSha256:'fixture',workspace:`workspace-${tag}`,
    model:'deepseek-flash',binarySha256:`binary-${tag}`,productionSha256:{'qa.rs':`source-${tag}`},evaluationSha256:{judge:'same'},
    complete:true,receipts:[{phase:'qa',status:200,usage:usage(100)},{phase:'judge',status:200,usage:usage(200)}],usage:{total_tokens:300},
    documents:[{id:'paper',split:'development',projectId:'p',sourceId:'s',sourceSha256:'source-hash',
      memories:[{id:'m',content:'The unchanged formal fact.',facets:{},kind:'fact',quotes:[],detail:{}}],
      segments:[{id:'g',text:'The complete original passage.'}],qaReadOnly:true,extraction:{job:{status:'succeeded'}},questions}],
    judgments:questions.map(q=>({id:q.id,answerable:q.answerable,memorySufficiency:'yes',anonymousOrder:['baseline','current'],
      entries:Object.fromEntries(entries.map(entry=>[entry,{answerCorrect:'yes',retrievalSufficiency:'yes',reason:'WRONG FLATTENED REASON'}])),
      baselineEntries:Object.fromEntries(entries.map(entry=>[entry,{answerCorrect:'partial'}])),
      stages:{answer:{systems:{system1:Object.fromEntries(entries.map(entry=>[entry,{answerCorrect:'partial',reason:`${tag} paired ${entry}`}])) ,
        system2:Object.fromEntries(entries.map(entry=>[entry,{answerCorrect:'yes',reason:`${tag} current ${entry}`}]))}},
        memory:{reason:'Frozen memory judge reason'},retrieval:{entries:Object.fromEntries(entries.map(entry=>[entry,{retrievalSufficiency:'yes',reason:'Retrieval reason'}]))}}})),
  };
}
function reports(){
  const current=fixtureReport('qa-architecture-dev'),baseline=fixtureReport('qa-reliability-dev'),historical=fixtureReport('qa-structured-dev-v3');
  baseline.receipts.push({phase:'extraction',status:200,usage:{prompt_tokens:900,completion_tokens:100,total_tokens:1000,prompt_cache_hit_tokens:0}});
  baseline.usage.total_tokens=1300;
  current.receipts[0].usage={prompt_tokens:140,completion_tokens:10,total_tokens:150,prompt_cache_hit_tokens:0};current.usage.total_tokens=350;
  baseline.judgments[0].entries.desktop.answerCorrect='no';baseline.judgments[0].entries.connector.answerCorrect='partial';
  return {current,baseline,historical};
}

test('QA-only costs compare QA with QA, retain historical v3 separately and never credit skipped extraction',()=>{
  const {current,baseline,historical}=reports(),before=structuredClone({current,baseline,historical});
  const m=buildArchitectureMetrics(current,baseline,historical);
  assert.equal(m.costs.current.extraction.requests,0);assert.equal(m.costs.current.extraction.totalTokens,0);
  assert.equal(m.costs.comparable.qa.totalTokens,50);assert.equal(m.costs.comparable.qa.relativeTokens,0.5);
  assert.equal(m.costs.comparable.all,undefined);assert.equal(m.costs.comparable.extraction,undefined);
  assert.equal(m.baselineOriginalSummary.summary['all:desktop'].fullyCorrectAnswerable.count,1);
  assert.equal(m.historicalReference.summary.summary['all:desktop'].fullyCorrectAnswerable.count,2);
  assert.equal(m.comparisons.strictAnonymousPaired.desktop.beforeFullyCorrect.count,0);
  assert.equal(m.currentSummary.summary['all:desktop'].fullyCorrectAnswerable.count,2);
  assert.equal(m.historicalReference.role,'historical-original-only-not-paired');
  assert.deepEqual({current,baseline,historical},before);
});

test('changed retention labels on identical formal content are judge variation and original sources cannot add memories',()=>{
  const {current,baseline,historical}=reports();current.judgments[0].memorySufficiency='partial';
  const m=buildArchitectureMetrics(current,baseline,historical);
  assert.equal(m.memory.unchangedContent,true);assert.equal(m.scope.formalMemoryAdditions,0);assert.equal(m.scope.frozenFormalMemories,1);
  assert.deepEqual(m.memory.labelChanges,[{id:'q0',before:'yes',after:'partial'}]);
  current.documents[0].memories[0].content='Changed formal fact';
  assert.throws(()=>buildArchitectureMetrics(current,baseline,historical),/memory or original source changed/);
  current.documents[0].memories[0].content=baseline.documents[0].memories[0].content;
  current.documents[0].segments[0].text='Clipped original';
  assert.throws(()=>buildArchitectureMetrics(current,baseline,historical),/memory or original source changed/);
});

test('source accounting separates all generation occurrences, selected-producer union and final citations',()=>{
  const {current}=reports(),actual=current.documents[0].questions[0].entries.desktop;
  const source={id:'source:s:g',kind:'source_passage',content:'The complete original passage.'};
  actual.generations=[{receiptId:1,references:[source]},{receiptId:2,references:[structuredClone(source),{id:'memory:m',kind:'memory',content:'Formal fact.'}]}];
  actual.receiptIds=[1,2];actual.result.queryTrace={answerGenerationIndices:[0,1],answerGenerationIndex:1};
  actual.result.citations=[source];
  const s=architectureSourceChannel(current).perEntry.desktop;
  assert.equal(s.generationSourceReferences,2);assert.equal(s.generationsWithSources,2);
  assert.equal(s.selectedProducerSourceReferences,1);assert.equal(s.entriesWithSelectedSources,1);
  assert.equal(s.sourceCitations,1);assert.equal(s.entriesWithSourceCitations,1);assert.equal(s.maxReferencesPerGeneration,2);
});

test('markdown separates all baseline meanings, original answer reasons and zero extraction without a cost saving claim',()=>{
  const {current,baseline,historical}=reports();current.documents[0].questions[0].entries.desktop.result.answer='Fact | condition\nSecond';
  const text=architectureMarkdown(buildArchitectureMetrics(current,baseline,historical));
  assert.match(text,/Fact \\\| condition<br>Second/);assert.match(text,/v3 只列历史原评参考/);
  assert.match(text,/不表示新增留存/);assert.match(text,/QA 对 QA、judge 对 judge/);assert.match(text,/100题未执行/);
  assert.match(text,/qa-reliability-dev current desktop/);assert.match(text,/qa-architecture-dev paired desktop/);
  assert.doesNotMatch(text,/WRONG FLATTENED REASON/);assert.match(text,/\+50 \(50\.00%\)/);
});

test('report artifacts require explicit passed integrity bound to exact report bytes',()=>{
  const root=process.cwd(),file=path.resolve(root,'docs/current-results.json'),bytes=Buffer.from('report');
  const good={version:'memory-architecture-integrity-v1',passed:true,results:[{file:'docs/current-results.json',sha256:budgetHash(bytes),passed:true}]};
  assert.equal(assertArchitectureReportIntegrity(good,file,bytes,root).passed,true);
  for(const change of [{passed:false},{version:'other'},{results:[{...good.results[0],sha256:budgetHash('different')}]},
    {results:[{...good.results[0],passed:false}]},{results:[]}])assert.throws(()=>assertArchitectureReportIntegrity({...good,...change},file,bytes,root));
});

test('CLI requires integrity and independently names the first and second reports',()=>{
  assert.deepEqual(parseArchitectureReportArgs(['--current','a','--integrity','b']),{current:'a',integrity:'b'});
  for(const args of [[],['--current','a'],['--current','a','--integrity'],['--current','a','--baseline','b'],['--current','a','--current','b']])assert.throws(()=>parseArchitectureReportArgs(args));
  assert.notEqual(architectureReportPaths(process.cwd(),'qa-architecture-dev').metrics,architectureReportPaths(process.cwd(),'qa-architecture-dev-v2').metrics);
  assert.match(architectureReportPaths(process.cwd(),'qa-architecture-dev-v2').report,/memory-architecture-dev-v2-report\.md$/);
  assert.throws(()=>architectureReportPaths(process.cwd(),'qa-reliability-dev'));
});
