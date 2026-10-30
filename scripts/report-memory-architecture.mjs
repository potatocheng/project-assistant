// Independent QA-only reporting. No live requests or historical mutations.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { budgetHash } from './memory-public-live-budget.mjs';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { buildReliabilityMetrics } from './report-memory-qa-reliability.mjs';
import { summarize } from './score-memory-qa-structured-live.mjs';
import { selectedEvaluationReferences } from './memory-qa-structured-capture.mjs';
import { frozenMemorySemanticHash } from './memory-qa-structured-freeze.mjs';
import { architectureBaselineFile, architectureTags } from './memory-architecture-evaluation.mjs';

const ENTRIES=['desktop','connector'],PHASES=['qa','judge','extraction','all'];
export const architectureHistoricalFile='docs/memory-public-live-qa-structured-dev-v3-results.json';
const questions=report=>report.documents.flatMap(p=>p.questions.map(q=>({...q,paperId:p.id})));
const sourceRef=reference=>reference?.kind==='source_passage';
const cell=value=>String(value??'未记录').replaceAll('|','\\|').replaceAll('\r','').replaceAll('\n','<br>');
const table=(headers,rows)=>[`| ${headers.map(cell).join(' | ')} |`,`| ${headers.map(()=>'---').join(' | ')} |`,...rows.map(row=>`| ${row.map(cell).join(' | ')} |`)].join('\n');
const fraction=value=>`${value.count}/${value.denominator}`;
const name=entry=>entry==='desktop'?'桌面':'飞书';

export function architectureSourceChannel(report){
  const cases=questions(report).flatMap(q=>ENTRIES.map(entry=>{
    const actual=q.entries[entry],selected=selectedEvaluationReferences(actual),generations=(actual.generations??[]).map((generation,index)=>({
      generationIndex:index,receiptId:generation.receiptId,referenceCount:generation.references.length,
      sourceReferenceIds:generation.references.filter(sourceRef).map(r=>r.id),
      formalMemoryReferenceCount:generation.references.filter(r=>!sourceRef(r)).length,
    }));
    return {id:q.id,paperId:q.paperId,entry,generations,selectedSourceReferenceIds:selected.filter(sourceRef).map(r=>r.id),
      selectedFormalMemoryReferenceIds:selected.filter(r=>!sourceRef(r)).map(r=>r.id??r.memoryId),
      sourceCitationIds:(actual.result?.citations??[]).filter(sourceRef).map(r=>r.id)};
  }));
  return {interpretation:'Original source passages are a separate production evidence channel, never new formal memories. Reference availability or citation presence is not proof that a source caused a correct answer.',
    perEntry:Object.fromEntries(ENTRIES.map(entry=>{
      const rows=cases.filter(row=>row.entry===entry),generations=rows.flatMap(row=>row.generations);
      return [entry,{cases:rows.length,generations:generations.length,
        generationSourceReferences:generations.reduce((n,g)=>n+g.sourceReferenceIds.length,0),
        generationsWithSources:generations.filter(g=>g.sourceReferenceIds.length).length,
        selectedProducerSourceReferences:rows.reduce((n,row)=>n+row.selectedSourceReferenceIds.length,0),
        entriesWithSelectedSources:rows.filter(row=>row.selectedSourceReferenceIds.length).length,
        uniqueSelectedSourcePassages:new Set(rows.flatMap(row=>row.selectedSourceReferenceIds)).size,
        sourceCitations:rows.reduce((n,row)=>n+row.sourceCitationIds.length,0),
        entriesWithSourceCitations:rows.filter(row=>row.sourceCitationIds.length).length,
        maxSourceReferencesPerGeneration:Math.max(0,...generations.map(g=>g.sourceReferenceIds.length)),
        maxReferencesPerGeneration:Math.max(0,...generations.map(g=>g.referenceCount))}];
    })),cases};
}

function phaseDelta(previous,current){
  const complete=previous.missingUsage===0&&current.missingUsage===0;
  return {baselineRequests:previous.requests,currentRequests:current.requests,requests:current.requests-previous.requests,
    baselineTokens:previous.totalTokens,currentTokens:current.totalTokens,
    totalTokens:complete?current.totalTokens-previous.totalTokens:null,
    relativeTokens:complete&&previous.totalTokens?(current.totalTokens-previous.totalTokens)/previous.totalTokens:null,
    completeUsage:complete};
}

export function buildArchitectureMetrics(current,baseline,historicalV3,fixture=null){
  if(current.receipts.some(r=>r.phase==='extraction'))throw new Error('Architecture reporting requires zero new extraction requests');
  if(current.datasetSha256!==historicalV3.datasetSha256)throw new Error('Historical reference fixture differs');
  const oldPapers=new Map(baseline.documents.map(p=>[p.id,p]));
  if(current.documents.length!==baseline.documents.length||current.documents.some(p=>!oldPapers.has(p.id)
      ||frozenMemorySemanticHash(p)!==frozenMemorySemanticHash(oldPapers.get(p.id))))throw new Error('Architecture formal memory or original source changed');
  const metrics=buildReliabilityMetrics(current,baseline,fixture),historicalSummary=summarize(historicalV3,fixture);
  metrics.version='memory-architecture-metrics-v1';
  metrics.methodology='QA-only comparison with frozen reliability formal memories and original sources. Current and historical reliability answers are anonymously regraded together; original reliability grades remain separate. v3 is historical reference only and was not regraded in this run. Memory-label differences are judge variation on identical retained content, not new retention. Source passages are a separate evidence channel. Same-model automatic judgments on known development regression cases; no causal or blind-evaluation claim.';
  metrics.scope.qaOnly=true;
  metrics.scope.frozenFormalMemories=current.documents.reduce((n,p)=>n+p.memories.length,0);
  metrics.scope.formalMemoryAdditions=0;
  metrics.currentSummary.extraction.historicalExtractionStatuses=metrics.currentSummary.extraction.statuses;
  metrics.currentSummary.extraction.statuses={not_run_frozen_memory:current.documents.length};
  metrics.comparisons.historicalOriginal.extraction.after.statuses={not_run_frozen_memory:current.documents.length};
  metrics.comparisons.anonymousPaired.extraction.after.statuses={not_run_frozen_memory:current.documents.length};
  metrics.memory.unchangedContent=true;
  metrics.memory.interpretation='The identical frozen formal memory is scored again. Different labels measure judge variation, not extraction improvement or newly stored facts; original source passages are excluded from the memory judge.';
  metrics.memory.labelChanges=metrics.cases.filter(row=>row.entry==='desktop'&&row.answerable&&row.memory.baseline!==row.memory.current)
    .map(row=>({id:row.id,before:row.memory.baseline,after:row.memory.current}));
  metrics.historicalReference={outputTag:historicalV3.outputTag,workspace:historicalV3.workspace,binarySha256:historicalV3.binarySha256,
    role:'historical-original-only-not-paired',summary:historicalSummary};
  metrics.sourceChannel=architectureSourceChannel(current);
  const sourceCases=new Map(metrics.sourceChannel.cases.map(row=>[`${row.id}:${row.entry}`,row]));
  for(const row of metrics.cases)row.sourceChannel=sourceCases.get(`${row.id}:${row.entry}`);
  metrics.costs.comparable={qa:phaseDelta(metrics.costs.baseline.qa,metrics.costs.current.qa),
    judge:phaseDelta(metrics.costs.baseline.judge,metrics.costs.current.judge),
    interpretation:'Compare QA with QA and judging with judging. The current run reuses historical extraction; its zero extraction cost is not an end-to-end cost reduction. Cached input is a subset of input. No currency bill or unit price is supplied.'};
  metrics.costs.currentExtraction={requests:0,totalTokens:0,performed:false};
  return metrics;
}

export function architectureMarkdown(metrics){
  const lines=['# 记忆架构：固定记忆上的20题真实问答比较','',
    `本轮 ${metrics.scope.currentRunTag}，${metrics.scope.questions}题：${metrics.scope.answerable}题可答、${metrics.scope.unanswerable}题无答案。冻结正式记忆 ${metrics.scope.frozenFormalMemories} 条，新增 0 条；提取请求 0 次。100题未执行。`,'',
    '与 reliability 的历史答案做本次匿名配对重评；同时保留 reliability 原评。v3 只列历史原评参考，本轮没有重评 v3。下面是同模型自动评分，开发集已用于回归，并非新增盲测。','',
    '## 正确率与参考充分性','',table(['入口','指标','v3 历史参考','reliability 原评','本次 reliability 配对','本轮'],ENTRIES.flatMap(entry=>{
      const historical=metrics.historicalReference.summary.summary[`all:${entry}`],old=metrics.baselineOriginalSummary.summary[`all:${entry}`],
        next=metrics.currentSummary.summary[`all:${entry}`],paired=metrics.comparisons.strictAnonymousPaired[entry];
      return [[name(entry),'可答题完整正确',fraction(historical.fullyCorrectAnswerable),fraction(old.fullyCorrectAnswerable),fraction(paired.beforeFullyCorrect),fraction(next.fullyCorrectAnswerable)],
        [name(entry),'无答案题正确拒答',fraction(historical.correctAbstention),fraction(old.correctAbstention),fraction(paired.beforeCorrectAbstention),fraction(next.correctAbstention)],
        [name(entry),'检索参考充分 yes',fraction(historical.rawJudgeStageLabels.fullRetrievalCoverage),fraction(old.rawJudgeStageLabels.fullRetrievalCoverage),'旧参考包未重评',fraction(next.rawJudgeStageLabels.fullRetrievalCoverage)],
        [name(entry),'相对本次旧答案配对的新增成功 / 退化','—','—','—',`${paired.answerableChanges.new_success??0} / ${paired.answerableChanges.regression??0}`]];
    })),'','partial 不计入完整正确；所有可答题保留在分母。历史原评与本次配对评分分开，不将评分漂移归为代码收益。','',
    '## 冻结记忆与独立原文通道','',
    '正式记忆内容、条件、修订、证据和原始段落均与 reliability 一致。下面的记忆标签是同一内容再次接受 judge 评分；任何变化都不表示新增留存。原文通道不进入记忆留存评分。','',
    table(['评分','yes','partial','no','uncertain','缺失','严格 yes'],['baseline','current'].map(arm=>{
      const m=metrics.memory[arm];return [arm==='baseline'?'reliability 原评':'冻结内容本次重评',m.distribution.yes,m.distribution.partial,m.distribution.no,m.distribution.uncertain,m.distribution.missing,fraction(m.yes)];
    })),'',table(['入口','含原文的生成次数','最终生产参考含原文的题数','最终生产原文参考数','引用原文的题数','原文引用数','单次生成最多原文 / 总参考'],ENTRIES.map(entry=>{
      const s=metrics.sourceChannel.perEntry[entry];return [name(entry),`${s.generationsWithSources}/${s.generations}`,`${s.entriesWithSelectedSources}/${s.cases}`,
        s.selectedProducerSourceReferences,`${s.entriesWithSourceCitations}/${s.cases}`,s.sourceCitations,`${s.maxSourceReferencesPerGeneration} / ${s.maxReferencesPerGeneration}`];
    })),'','原文参考数量按最终答案实际生产上下文的并集统计；并集跨两次生成时不等同于单个参考包。来源字段与整段内容通过完整性校验。引用或可见原文不单独证明其导致答案正确。','',
    '## 分阶段请求与 tokens','',
    '成本只作同阶段比较：QA 对 QA、judge 对 judge。本轮复用已完成的提取，不将本轮 QA-only 总量与旧含提取总量相比来宣称节省。未提供货币账单或单价，因此不估算货币费用。','',
    table(['阶段','reliability 请求 / tokens','本轮请求 / tokens','同阶段 tokens 变化'],PHASES.map(phase=>{
      const old=metrics.costs.baseline[phase],next=metrics.costs.current[phase],delta=metrics.costs.comparable[phase];
      return [phase,`${old.requests} / ${old.totalTokens}`,`${next.requests} / ${next.totalTokens}`,
        delta?delta.completeUsage?`${delta.totalTokens>=0?'+':''}${delta.totalTokens}${delta.relativeTokens===null?'':` (${(100*delta.relativeTokens).toFixed(2)}%)`}`:'usage 不完整，未计算':phase==='extraction'?'本轮未执行':'范围不同，不计算节省'];
    })),'',table(['本轮阶段','input','output','cache input','失败请求','缺失(total/input/output/cache)'],PHASES.map(phase=>{
      const c=metrics.costs.current[phase];return [phase,c.inputTokens,c.outputTokens,c.cachedInputTokens,c.failedRequests,
        ['totalTokens','inputTokens','outputTokens','cachedInputTokens'].map(field=>c.missingByField[field]).join('/')];
    })),'','所有成功、失败和重试请求均纳入实际收据；cache 属于 input，不重复加入 total。','',
    '## 逐题变化','',
    '理由来自对应 stages.answer.systems，按 anonymousOrder 映射；不使用检索阶段覆盖后的扁平 reason。'];
  for(const row of metrics.cases){
    lines.push('',`### ${row.id} · ${name(row.entry)} · ${row.answerable?'可答':'无答案'}`,'',row.question,'',
      table(['reliability 原评','本次 reliability 配对','本轮','相对原评','相对配对'],[[row.baselineOriginalGrade,row.baselinePairedGrade,row.currentGrade,row.originalChange,row.pairedChange]]),'',
      table(['内容','原始记录'],[['reliability 答案',row.baselineAnswer.text],['本轮答案',row.currentAnswer.text],
        ['reliability 原评理由',row.reasons.baselineOriginal.reason],['reliability 本次配对理由',row.reasons.baselinePaired.reason],['本轮理由',row.reasons.current.reason],
        ['旧 / 本轮参考充分性',`${row.retrieval.baseline} / ${row.retrieval.current}`],['本轮参考理由',row.retrieval.currentReason],
        ['最终生产原文参考 ID',row.sourceChannel.selectedSourceReferenceIds.join(', ')||'无'],['最终原文引用 ID',row.sourceChannel.sourceCitationIds.join(', ')||'无']]));
  }
  lines.push('','## 审计','',`当前报告：${metrics.inputs?.current?.file??'未提供'}；直接比较基线：${metrics.inputs?.baseline?.file??'未提供'}；v3 历史参考：${metrics.inputs?.historical?.file??'未提供'}。`,
    `完整性：${metrics.integrity?.file??'未提供'}，通过=${metrics.integrity?.record?.passed===true}；报告 SHA 与完整性记录绑定。`,
    `当前 binary：${metrics.current.binarySha256}；注册、源码、评测快照、逐题原文计数与完整成本字段见同名 metrics。`,'');
  return lines.join('\n');
}

export function parseArchitectureReportArgs(args){
  const result={current:null,integrity:null};
  for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];
    if(!['--current','--integrity'].includes(name)||!value||value.startsWith('--')||result[name.slice(2)])throw new Error('Use --current REPORT --integrity PASSED_INTEGRITY');
    result[name.slice(2)]=value;
  }
  if(!result.current||!result.integrity)throw new Error('Architecture report requires current and passed integrity artifacts');
  return result;
}

export function architectureReportPaths(root,tag){
  if(!architectureTags.includes(tag))throw new Error('Unknown architecture report tag');
  const stem=tag.replace(/^qa-/,'memory-');
  return {metrics:path.join(root,'docs',`${stem}-metrics.json`),report:path.join(root,'docs',`${stem}-report.md`)};
}

export function assertArchitectureReportIntegrity(record,currentFile,currentBytes,root){
  const result=record.results?.find(r=>path.resolve(root,r.file)===path.resolve(currentFile));
  if(record.version!=='memory-architecture-integrity-v1'||record.passed!==true||result?.passed!==true
      ||result.sha256!==budgetHash(currentBytes))throw new Error('Architecture integrity must pass and bind the exact current report bytes');
  return result;
}

export async function generateArchitectureReport(args=process.argv.slice(2)){
  const options=parseArchitectureReportArgs(args),root=path.resolve(import.meta.dirname,'..');
  const files={current:path.resolve(root,options.current),baseline:path.resolve(root,architectureBaselineFile),historical:path.resolve(root,architectureHistoricalFile)};
  const values=await Promise.all(Object.entries(files).map(async([name,file])=>[name,{report:await readPublicLiveReport(file),bytes:await readFile(file)}]));
  const inputs=Object.fromEntries(values),{current,baseline,historical}=Object.fromEntries(values.map(([name,value])=>[name,value.report]));
  const integrityFile=path.resolve(root,options.integrity),integrityBytes=await readFile(integrityFile),record=JSON.parse(integrityBytes);
  const currentResult=assertArchitectureReportIntegrity(record,files.current,inputs.current.bytes,root);
  if(!architectureTags.includes(current.outputTag)||current.architecture?.kind!=='frozen-confirmed-memory-qa-only'||current.complete!==true
      ||current.split!=='development'||questions(current).length!==20||questions(current).filter(q=>q.answerable).length!==19
      ||current.documents.reduce((n,p)=>n+p.memories.length,0)!==929||baseline.outputTag!=='qa-reliability-dev'
      ||historical.outputTag!=='qa-structured-dev-v3'||path.resolve(root,current.baseline.file)!==files.baseline
      ||current.baseline.workspace!==baseline.workspace||current.baseline.binarySha256!==baseline.binarySha256
      ||record.budget?.registration?.sha256!==current.budgetRegistration?.sha256
      ||currentResult.requests!==current.receipts.length||currentResult.totalTokens!==current.usage.total_tokens)throw new Error('Architecture report identity, frozen scope or integrity differs');
  const manifest=JSON.parse(await readFile(path.join(root,'docs/memory-public-dataset-manifest.json'))),fixture=JSON.parse(await readFile(path.resolve(root,manifest.fixture)));
  const metrics=buildArchitectureMetrics(current,baseline,historical,fixture);
  metrics.inputs=Object.fromEntries(Object.entries(files).map(([name,file])=>[name,{file:path.relative(root,file),sha256:budgetHash(inputs[name].bytes)}]));
  metrics.integrity={file:path.relative(root,integrityFile),sha256:budgetHash(integrityBytes),currentResult,record};
  metrics.budget=record.budget;
  const outputs=architectureReportPaths(root,current.outputTag);
  for(const output of Object.values(outputs))if([...Object.values(files),integrityFile].includes(output))throw new Error('Architecture report cannot overwrite its evidence');
  await writeFile(outputs.metrics,JSON.stringify(metrics,null,2),{flag:'wx'});
  await writeFile(outputs.report,architectureMarkdown(metrics),{flag:'wx'});
  console.log(JSON.stringify({report:path.relative(root,outputs.report),metrics:path.relative(root,outputs.metrics),complete:current.complete,qaOnly:true}));
  return metrics;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await generateArchitectureReport();
