// Read-only report; all calls and failures remain separately visible.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readPublicLiveReport} from './memory-public-live-io.mjs';
import {summarize} from './score-memory-qa-structured-live.mjs';
import {comparePublicLive} from './compare-memory-public-live.mjs';
import {structuredOperationalObservations,compareActualPacks} from './memory-qa-structured-observations.mjs';
import {verifyQaStructuredRecordedBudget,loadQaStructuredRegistration} from './memory-qa-structured-budget.mjs';
export function executedRunEvidence(report) {
 return {binarySha256:report.binarySha256,productionSha256:structuredClone(report.productionSha256??{}),preLiveEvidence:structuredClone(report.preLiveEvidence??null),evaluationSha256:structuredClone(report.evaluationSha256??{})};
}
export function structuredVersionNote(diagnostic,development) {
 if(!diagnostic)return '本报告未提供固定记忆诊断版本，不能把其他版本的诊断结果当作当前版本复测。';
 if(!development)return '固定记忆诊断仅覆盖其实际执行的二进制；后续fresh链路如使用不同binary，诊断不能冒充最终版本复测。';
 if(diagnostic.binarySha256!==development.binarySha256)return `固定记忆诊断binary ${diagnostic.binarySha256.slice(0,16)} 与fresh链路binary ${development.binarySha256.slice(0,16)} 不同；诊断不能冒充最终版本复测。`;
 return '固定记忆诊断与fresh链路的实际二进制相同；固定记忆和重新提取两种实验口径分别列示。';
}
export function structuredReferenceNote(run) {
 return run.baselineOriginallyJudged?'旧参考充分率来自历史原始评分，本轮未对旧参考包作同次独立重评；不能声称同次配对参考净增。':'旧baseline的参考充分性未单独评分；不能依据本轮参考充分率声称参考净增。';
}
export function freshDevelopmentAttempts(previous,current) {
 const candidates=[...(previous??[]),...(current?[current]:[])];
 return candidates.filter(run=>/^qa-structured-dev(?:-|$)/.test(run.outputTag??run.summary?.outputTag??'')).map((run,index)=>{
  const desktop=run.summary.summary['all:desktop'],connector=run.summary.summary['all:connector'];
  return {attempt:index+1,outputTag:run.outputTag??run.summary.outputTag,file:run.file,workspace:run.workspace,
   binarySha256:run.binarySha256,originalDesktop:structuredClone(desktop.fullyCorrectAnswerable),originalConnector:structuredClone(connector.fullyCorrectAnswerable),
   desktopReferences:structuredClone(desktop.rawJudgeStageLabels.fullRetrievalCoverage),connectorReferences:structuredClone(connector.rawJudgeStageLabels.fullRetrievalCoverage),
   qaRequests:run.costs.qa.requests,qaTokens:run.costs.qa.tokens,gate:run.gate?.passed===true?'passed':run.gate?.passed===false?'failed':'not_provided',
   comparisonScope:'Original labels from distinct fresh extraction/model runs; not same-call paired grading, not causal attribution and not regrading.'};
 });
}
export function freshDevelopmentMarkdown(rows) {
 const lines=['## 本轮各次 fresh20 原始评分与 QA 成本','','各行保留该次实际运行的原始自动评分、QA成本、实际binary与门槛结果。不同次提取和模型随机性均可能影响结果；这些行不是同调用配对，不构成因果对照，也没有重新评分（regrade）。同调用配对仍见各阶段原有表。',''];
 if(!rows.length)return [...lines,'尚未执行 fresh20。',''].join('\n');
 const rate=v=>`${v.count}/${v.denominator}`;
 lines.push('| 次数 / tag | 桌面完整正确 | 飞书完整正确 | 参考充分（桌／飞） | QA请求 / tokens | 实际binary | 全部门槛 |','| --- | --- | --- | --- | --- | --- | --- |');
 for(const r of rows)lines.push(`| ${r.attempt} / ${r.outputTag} | ${rate(r.originalDesktop)} | ${rate(r.originalConnector)} | ${rate(r.desktopReferences)} / ${rate(r.connectorReferences)} | ${r.qaRequests} / ${r.qaTokens} | ${r.binarySha256?.slice(0,16)??'未记录'} | ${{passed:'通过',failed:'未通过',not_provided:'未提供'}[r.gate]} |`);
 return [...lines,''].join('\n');
}
export async function generateStructuredReport(args=process.argv.slice(2)) {
const root=path.resolve(import.meta.dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex');
const arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const table=(headers,rows)=>[`| ${headers.join(' | ')} |`,`| ${headers.map(()=>'---').join(' | ')} |`,...rows.map(r=>`| ${r.join(' | ')} |`)].join('\n');
const cost=r=>Object.fromEntries(['all','extraction','qa','judge'].map(phase=>{const receipts=r.receipts.filter(v=>phase==='all'||v.phase===phase);return [phase,{requests:receipts.length,tokens:receipts.reduce((n,v)=>n+(v.usage?.total_tokens??0),0)}];}));
const evidence=await loadQaStructuredRegistration(root),registration=evidence.registration;
const fixtureManifest=JSON.parse(await readFile(path.join(root,'docs/memory-public-dataset-manifest.json'))),fixture=JSON.parse(await readFile(path.resolve(root,fixtureManifest.fixture)));
const metrics={version:'memory-qa-structured-metrics-v1',createdAt:new Date().toISOString(),datasetSha256:registration.datasetSha256,registration:evidence.budgetRegistration,
 historical:evidence.historical.map(r=>({name:r.name,ledger:r.ledger})),diagnostic:null,development:null,full:null};
async function run(file,baselineFile) { const report=await readPublicLiveReport(path.resolve(root,file)),baseline=await readPublicLiveReport(path.resolve(root,baselineFile));
 if(path.resolve(root,report.baseline.file)!==path.resolve(root,baselineFile)||report.baseline.workspace!==baseline.workspace||report.baseline.binarySha256!==baseline.binarySha256)throw new Error('Report paired comparator differs from actual evaluated baseline');
 const budget=await verifyQaStructuredRecordedBudget(root,report);return {...executedRunEvidence(report),baselineExecution:executedRunEvidence(baseline),file,sha256:hash(await readFile(path.resolve(root,file))),workspace:report.workspace,outputTag:report.outputTag,complete:report.complete,
   costs:cost(report),summary:summarize(report,fixture),comparison:comparePublicLive(report,baseline),observations:structuredOperationalObservations(report),
   baselineOriginalSummary:summarize(baseline,fixture),baselineOriginallyJudged:baseline.judgments.length>0,baselineCosts:cost(baseline),budget:{ledger:budget.ledger,attempt:budget.attempt},actualPackComparison:compareActualPacks(baseline,report)}; }
const diagBaseline=arg('--diagnostic-baseline'),diagCandidate=arg('--diagnostic-candidate'),devFile=arg('--dev'),gateFile=arg('--gate'),fullFile=arg('--full');
if(!!diagBaseline!==!!diagCandidate)throw new Error('Diagnostic report requires both freshly executed arms');
if(diagCandidate) { const b=await readPublicLiveReport(path.resolve(root,diagBaseline)),c=await readPublicLiveReport(path.resolve(root,diagCandidate));
 if(b.diagnostic?.arm!=='baseline'||c.diagnostic?.arm!=='candidate'||b.diagnostic.frozenReportSha256!==c.diagnostic.frozenReportSha256||path.resolve(root,c.baseline.file)!==path.resolve(root,diagBaseline))throw new Error('Diagnostic arms are not a fresh identical-memory pair');
 metrics.diagnostic={...await run(diagCandidate,diagBaseline),baselineFile:diagBaseline,baselineCosts:cost(b),fixedConfirmedMemory:true,fixedSuppliedPack:false}; }
if(devFile) {metrics.development=await run(devFile,registration.baselineDevelopment.file);if(!gateFile)throw new Error('Development report requires explicit gate');metrics.development.gate=JSON.parse(await readFile(path.resolve(root,gateFile)));}
if(fullFile) {if(metrics.development?.gate?.passed!==true)throw new Error('Cannot present unauthorized full100');metrics.full=await run(fullFile,registration.baselineFull.file);
 const targets=registration.fullTargets,full=metrics.full;full.targets=[];
 for(const e of ['desktop','connector']){const s=full.summary.summary[`all:${e}`];for(const [metric,actual,minimum]of [['complete',s.fullyCorrectAnswerable.count,targets[`${e}Complete`]],['references',s.rawJudgeStageLabels.fullRetrievalCoverage.count,targets[`${e}ReferencesSufficient`]],['correctAbstention',s.correctAbstention.count,targets[`${e}CorrectAbstention`]]])full.targets.push({name:`${e}_${metric}`,actual,required:minimum,passed:actual>=minimum});}
 full.targets.push({name:'qa_tokens',actual:full.costs.qa.tokens,required:targets.maxCombinedQaTokens,passed:full.costs.qa.tokens<=targets.maxCombinedQaTokens});}
if(!metrics.development&&!metrics.diagnostic)throw new Error('Provide --dev REPORT --gate GATE or both diagnostic arms');
const latest=await readPublicLiveReport(path.resolve(root,fullFile??devFile??diagCandidate)),latestBudget=await verifyQaStructuredRecordedBudget(root,latest);
const ledger=latest.split==='all'?metrics.development.budget.ledger:latestBudget.ledger;
const currentDevelopment=fullFile?await readPublicLiveReport(path.resolve(root,devFile)):latest;
metrics.currentRoundBudget={development:{priorRequests:ledger?.requests??0,priorTokens:ledger?.totalTokens??0,currentRequests:currentDevelopment.receipts.length,currentTokens:currentDevelopment.usage.total_tokens,
 totalRequests:(ledger?.requests??0)+currentDevelopment.receipts.length,totalTokens:(ledger?.totalTokens??0)+currentDevelopment.usage.total_tokens,limits:registration.limits.development},full:metrics.full?metrics.full.costs.all:null};
metrics.previousCurrentRoundRuns=[];
for(const e of ledger?.entries??[]) {const report=await readPublicLiveReport(path.resolve(root,e.file));let recordedGate=null;
 if(/^qa-structured-dev(?:-|$)/.test(report.outputTag)){const gateFile=e.file.replace(/-results\.json$/,'-gate.json');try{const bytes=await readFile(path.resolve(root,gateFile)),gate=JSON.parse(bytes);
  if(path.resolve(root,gate.report)!==path.resolve(root,e.file)||gate.binarySha256!==report.binarySha256)throw new Error('Historical fresh gate belongs to a different executed report');
  recordedGate={file:gateFile,sha256:hash(bytes),passed:gate.passed,failedCheckNames:gate.checks.filter(c=>!c.passed).map(c=>c.name)};
 }catch(error){if(error.code!=='ENOENT')throw error;}}
 metrics.previousCurrentRoundRuns.push({...executedRunEvidence(report),file:e.file,sha256:e.sha256,outputTag:e.outputTag,complete:report.complete,gate:recordedGate,costs:cost(report),
 summary:report.diagnostic?.arm==='baseline'?null:summarize(report,fixture)});}
metrics.freshDevelopmentAttempts=freshDevelopmentAttempts(metrics.previousCurrentRoundRuns,metrics.development);
const lines=['# 结构化记忆 QA 优化与验证', '', '固定开发20题与全部100题均是已参与开发的回归资料。评分来自独立上下文中的同一模型，并非新增人工复核。旧标签、同次匿名配对标签、完整失败及费用分别保留。', '',
 '## 实验口径', '', `- 20题成本恢复参考为${registration.costReferenceDevelopment.combinedQaTokens} QA tokens，硬上限${registration.thresholds.maxCombinedQaTokens}；本轮质量比较仍使用上轮实际259312 QA tokens的结果，三者分别列示。`, '- 固定记忆诊断：两次实际执行旧／新二进制，同一已确认正文、组织字段、修订和来源。未冻结模型收到的参考包。','- 完整链路：重新提取、确认、检索、生成、审查及回答。只有全部20题门槛通过才运行100题。','- 增量回答：参考充分性评估实际被选中的生成上下文并集；每次实际调用的包限制独立核验。逐义务／逐断言状态是系统诊断，不能作为人工真值。',''];
lines.push('## 实际执行版本', '', structuredVersionNote(metrics.diagnostic,metrics.development), '完整binary/source/evaluation hash及测试前置证据见各阶段机器metrics；不从当前工作区版本反推历史运行版本。', '');
for(const [key,title]of [['diagnostic','固定记忆20题 QA 诊断'],['development','20题完整链路'],['full','100题完整链路']]) {
 const r=metrics[key];if(!r){lines.push(`## ${title}`,'','未执行。','');continue;}
 lines.push(`## ${title}`,'',`原始结果：[${r.file}](${path.basename(r.file)})；完整执行：${r.complete}。${r.gate?`全部门槛：${r.gate.passed?'通过':'未通过'}。`:''}`,'',`执行binary：${r.binarySha256.slice(0,16)}；比较baseline binary：${r.baselineExecution.binarySha256.slice(0,16)}（完整hash见机器JSON）。`,structuredReferenceNote(r),'',table(['指标','桌面旧原始','桌面同次旧配对','桌面本轮','飞书旧原始','飞书同次旧配对','飞书本轮'],[
 ['完整正确',...['desktop','connector'].flatMap(e=>{const b=r.baselineOriginalSummary.summary[`all:${e}`],p=r.comparison.summary[`all:${e}`],n=r.summary.summary[`all:${e}`];return [r.baselineOriginallyJudged?`${b.fullyCorrectAnswerable.count}/${b.answerable}`:'未单独评分',`${p.beforeFullyCorrect.count}/${p.answerable}`,`${n.fullyCorrectAnswerable.count}/${n.answerable}`];})],
 ['参考充分',...['desktop','connector'].flatMap(e=>{const b=r.baselineOriginalSummary.summary[`all:${e}`],n=r.summary.summary[`all:${e}`];return [r.baselineOriginallyJudged?`${b.rawJudgeStageLabels?.fullRetrievalCoverage?.count??'—'}/${b.answerable}`:'未单独评分','—',`${n.rawJudgeStageLabels?.fullRetrievalCoverage?.count??'—'}/${n.answerable}`];})],
 ['正确拒答',...['desktop','connector'].flatMap(e=>{const b=r.baselineOriginalSummary.summary[`all:${e}`],p=r.comparison.summary[`all:${e}`],n=r.summary.summary[`all:${e}`];return [r.baselineOriginallyJudged?`${b.correctAbstention.count}/${b.unanswerable}`:'未单独评分',`${p.beforeCorrectAbstention.count}/${p.unanswerable}`,`${n.correctAbstention.count}/${n.unanswerable}`];})]
 ]),'',table(['费用阶段','旧请求','旧tokens','新请求','新tokens'],['all','extraction','qa','judge'].map(p=>[p,r.baselineCosts[p].requests,r.baselineCosts[p].tokens,r.costs[p].requests,r.costs[p].tokens])),'');
 lines.push(table(['链路阶段','优化前','本轮'],[
 ['提取状态',`${r.baselineOriginalSummary.extraction.papers}篇；${JSON.stringify(r.baselineOriginalSummary.extraction.statuses)}`,key==='diagnostic'?'未重提取：固定已确认记忆':`${r.summary.extraction.papers}篇；${JSON.stringify(r.summary.extraction.statuses)}`],
 ['正式记忆条数',r.baselineOriginalSummary.extraction.formalMemories,r.summary.extraction.formalMemories],
 ['记忆正文完整保留（同模型评估）',r.baselineOriginallyJudged?`${r.baselineOriginalSummary.summary['all:desktop'].rawJudgeStageLabels.fullMemoryCoverage.count}/${r.baselineOriginalSummary.summary['all:desktop'].answerable}`:'未单独评分',`${r.summary.summary['all:desktop'].rawJudgeStageLabels.fullMemoryCoverage.count}/${r.summary.summary['all:desktop'].answerable}`],
 ['QA只读',r.baselineOriginalSummary.extraction.qaReadOnly,r.summary.extraction.qaReadOnly],
 ['审查协议失败（桌面／飞书）','原始raw保留', ['desktop','connector'].map(e=>r.observations.rows.filter(x=>x.entry===e&&x.reviewFailures.length>0).length).join(' / ')],
 ['补查生成＋审查tokens','原始raw保留',['desktop','connector'].map(e=>r.observations.perEntry[e].additionalGenerationAndReviewTokens).join(' / ')]
 ]),'');
 if(r.targets)lines.push('全量预设目标：',...r.targets.map(t=>`- ${t.name}：${t.actual}；目标${t.required}；${t.passed?'达到':'未达到'}`),'');
 if(r.gate&&!r.gate.passed)lines.push('未通过项：',...r.gate.checks.filter(c=>!c.passed).map(c=>`- ${c.name}：${JSON.stringify(c.actual).slice(0,200)}`),'');
}
lines.push(freshDevelopmentMarkdown(metrics.freshDevelopmentAttempts));
lines.push('## 预算与失败保留','',table(['费用组','请求','tokens'],[...metrics.historical.map(h=>[`${h.name}历史（不扣本轮）`,h.ledger.requests,h.ledger.totalTokens]),['本轮诊断＋开发（所有失败）',metrics.currentRoundBudget.development.totalRequests,metrics.currentRoundBudget.development.totalTokens],['本轮完整100题',metrics.full?.costs.all.requests??'未执行',metrics.full?.costs.all.tokens??'未执行']]),'','逐题配对、每个实际参考包hash、逐义务／断言／未知决策、补查成本和完整费用链见同名机器 JSON。');
await writeFile(path.join(root,'docs/memory-qa-structured-metrics.json'),JSON.stringify(metrics,null,2));
await writeFile(path.join(root,'docs/memory-qa-structured-report.md'),lines.join('\n'));
console.log(JSON.stringify({report:'docs/memory-qa-structured-report.md',developmentGate:metrics.development?.gate?.passed??null,fullExecuted:!!metrics.full,budget:metrics.currentRoundBudget}));

return metrics;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await generateStructuredReport();
