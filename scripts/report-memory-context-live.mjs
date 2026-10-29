import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const report=JSON.parse(await readFile(path.join(root,'.local-data/context-eval-20261028/comparison.json'),'utf8'));
const totalFacts=report.dataset.cases.reduce((n,d)=>n+d.facts.length,0)*report.registration.repeats;
const totalContext=report.dataset.cases.reduce((n,d)=>n+d.facts.filter(f=>f.context).length,0)*report.registration.repeats;
const state=()=>({full:0,partial:0,missing:0,unscored:0});
const summary={version:'memory-context-live-summary-v1',registration:report.registration,finishedAt:report.finishedAt??null,totalFacts,totalContext,arms:{},cases:[],paired:{improved:0,regressed:0,unchanged:0,unscored:0}};
function usage(receipts){return {requests:receipts.length,successful:receipts.filter(r=>r.status===200).length,inputTokens:receipts.reduce((n,r)=>n+(r.usage?.prompt_tokens??0),0),outputTokens:receipts.reduce((n,r)=>n+(r.usage?.completion_tokens??0),0),tokens:receipts.reduce((n,r)=>n+(r.usage?.total_tokens??0),0),cacheHitTokens:receipts.reduce((n,r)=>n+(r.usage?.prompt_cache_hit_tokens??0),0),missingUsage:receipts.filter(r=>!Number.isFinite(r.usage?.total_tokens)).length,elapsedMs:receipts.reduce((n,r)=>n+(r.elapsedMs??0),0)};}
const labelsFor=(facts,candidates,ready=false)=>Object.fromEntries(facts.map(f=>[f.id,(f.fullIndices.some(i=>!ready||candidates[i-1]?.ready)?'full':f.partialIndices.some(i=>!ready||candidates[i-1]?.ready)?'partial':'missing')]));
for(const arm of ['baseline','candidate']){
 const runs=report.runs.filter(r=>r.arm===arm),receipts=report.receipts.filter(r=>r.arm===arm&&r.phase==='extraction');
 const a={jobs:runs.length,successfulJobs:runs.filter(r=>r.job?.status==='succeeded').length,candidates:runs.reduce((n,r)=>n+(r.candidates?.length??0),0),ready:runs.reduce((n,r)=>n+(r.candidates?.filter(c=>c.ready).length??0),0),all:state(),readyFacts:state(),context:state(),unsafeCandidates:0,judgedCandidates:0,quoteFailures:runs.filter(r=>r.quotesValid===false).length,formalMemories:runs.reduce((n,r)=>n+(r.formalMemories??0),0),usage:usage(receipts),stages:Object.fromEntries(['extraction','review'].map(s=>[s,usage(receipts.filter(r=>r.stage===s))]))};
 for(const doc of report.dataset.cases)for(let repeat=1;repeat<=report.registration.repeats;repeat++){
   const run=runs.find(r=>r.caseId===doc.id&&r.repeat===repeat),judge=report.judgments.find(j=>j.caseId===doc.id&&j.repeat===repeat);
   const output=judge?.output?.[['A','B'][judge.mapping.indexOf(arm)]];
   const row={caseId:doc.id,group:doc.group,arm,repeat,all:state(),ready:state(),factStates:{},readyStates:{},unsafe:0,requests:receipts.filter(r=>r.caseId===doc.id&&r.repeat===repeat).length,tokens:usage(receipts.filter(r=>r.caseId===doc.id&&r.repeat===repeat)).tokens};
   if(output){
    row.factStates=labelsFor(output.facts,run.candidates);row.readyStates=labelsFor(output.facts,run.candidates,true);
    for(const f of doc.facts){a.all[row.factStates[f.id]]++;row.all[row.factStates[f.id]]++;a.readyFacts[row.readyStates[f.id]]++;row.ready[row.readyStates[f.id]]++;if(f.context)a.context[row.factStates[f.id]]++;}
    row.unsafe=output.unsafeIndices.length;a.unsafeCandidates+=row.unsafe;a.judgedCandidates+=run.candidates.length;
   }else{a.all.unscored+=doc.facts.length;a.readyFacts.unscored+=doc.facts.length;a.context.unscored+=doc.facts.filter(f=>f.context).length;row.all.unscored=doc.facts.length;}
   summary.cases.push(row);
 }
 a.needsReview=a.candidates-a.ready;summary.arms[arm]=a;
}
for(const doc of report.dataset.cases)for(let repeat=1;repeat<=report.registration.repeats;repeat++){
 const [a,b]=['baseline','candidate'].map(arm=>summary.cases.find(c=>c.arm===arm&&c.caseId===doc.id&&c.repeat===repeat));
 for(const f of doc.facts){if(!a.factStates[f.id]||!b.factStates[f.id])summary.paired.unscored++;else if(a.factStates[f.id]!=='full'&&b.factStates[f.id]==='full')summary.paired.improved++;else if(a.factStates[f.id]==='full'&&b.factStates[f.id]!=='full')summary.paired.regressed++;else summary.paired.unchanged++;}
}
summary.judgeUsage=usage(report.receipts.filter(r=>r.phase==='judge'));summary.totalUsage=usage(report.receipts);
summary.denseExact=Object.fromEntries(['baseline','candidate'].map(arm=>[arm,report.runs.filter(r=>r.arm===arm&&r.caseId==='dense_facts').map(r=>({repeat:r.repeat,retained:Array.from({length:18},(_,i)=>({id:`D${String(i+1).padStart(2,'0')}`,days:i+11})).filter(f=>r.candidates.some(c=>c.content.includes(f.id)&&new RegExp(`${f.days}\\s*天`).test(c.content))).length,total:18}))]));
const b=summary.arms.baseline,c=summary.arms.candidate,pct=(n,d)=>d?`${(n/d*100).toFixed(1)}%`:'—';
const lines=[ '# 上下文提取 v6 / v7 真实模型对照', '',
`模型：${report.registration.model}。12份合成资料（6份既有、6份新增诊断），每版本重复2次，共${report.runs.length}次独立提取、${totalFacts}个事实观察／版本。基线来自 HEAD ada7e8b，候选为本轮未提交v7源码快照；完整二进制与题集哈希见机器报告。`, '',
'评价完整保留要求同一条候选正文明确表达目标事实及必要主体、条件和否定。逐字引用或多个互不关联候选的并集不算完整。全部最终草稿与可确认候选分别统计，未自动放行人工审核草稿，也未执行问答。', '',
'| 指标 | v6 | v7 |','| --- | ---: | ---: |',
`| 提取任务成功 | ${b.successfulJobs}/${b.jobs} | ${c.successfulJobs}/${c.jobs} |`,
`| 全部最终草稿：完整保留 | ${b.all.full}/${totalFacts}（${pct(b.all.full,totalFacts)}） | ${c.all.full}/${totalFacts}（${pct(c.all.full,totalFacts)}） |`,
`| 部分保留 / 完全遗漏 / 未评分 | ${b.all.partial} / ${b.all.missing} / ${b.all.unscored} | ${c.all.partial} / ${c.all.missing} / ${c.all.unscored} |`,
`| 上下文相关事实完整保留 | ${b.context.full}/${totalContext} | ${c.context.full}/${totalContext} |`,
`| 可确认候选：完整保留 | ${b.readyFacts.full}/${totalFacts} | ${c.readyFacts.full}/${totalFacts} |`,
`| 候选数 / 需审核数 | ${b.candidates} / ${b.needsReview} | ${c.candidates} / ${c.needsReview} |`,
`| 自动评分标记不安全断言 | ${b.unsafeCandidates}/${b.judgedCandidates} | ${c.unsafeCandidates}/${c.judgedCandidates} |`,
`| 提取与复查请求 | ${b.usage.requests} | ${c.usage.requests} |`,
`| 提取与复查总tokens | ${b.usage.tokens.toLocaleString('en-US')} | ${c.usage.tokens.toLocaleString('en-US')} |`,
`| 输入 / 输出tokens | ${b.usage.inputTokens} / ${b.usage.outputTokens} | ${c.usage.inputTokens} / ${c.usage.outputTokens} |`,
`| 输入缓存命中tokens | ${b.usage.cacheHitTokens} | ${c.usage.cacheHitTokens} |`,
`| 缺usage请求 | ${b.usage.missingUsage} | ${c.usage.missingUsage} |`, '',
`配对事实观察：新增完整保留${summary.paired.improved}，退化${summary.paired.regressed}，其余${summary.paired.unchanged}，未评分${summary.paired.unscored}。`, '',
`v7局部复查独立消耗：${c.stages.review.requests}次、${c.stages.review.tokens} tokens。评分另计${summary.judgeUsage.requests}次、${summary.judgeUsage.tokens} tokens；本实验全部调用${summary.totalUsage.requests}次、${summary.totalUsage.tokens} tokens。以上tokens均来自提供方usage，未按现价推算人民币费用。`, '',
'| 样本 | v6完整保留（两轮合计） | v7完整保留（两轮合计） | v6 tokens | v7 tokens |','| --- | ---: | ---: | ---: | ---: |'];
for(const d of report.dataset.cases){const rows=arm=>summary.cases.filter(c=>c.caseId===d.id&&c.arm===arm);const sum=(arm,key)=>rows(arm).reduce((n,c)=>n+(key==='full'?c.all.full:c.tokens),0);lines.push(`| ${d.id} | ${sum('baseline','full')}/${d.facts.length*2} | ${sum('candidate','full')}/${d.facts.length*2} | ${sum('baseline','tokens')} | ${sum('candidate','tokens')} |`);}
lines.push('', '这些是助手构造的合成诊断和同模型匿名自动评分，不是独立人工验收或业务盲测。两次重复只能观察基本波动，不能证明统计显著性。新增记忆条数、逐字引文有效和任务成功都不能代替语义正确率。生产实现与题集在运行前冻结，本轮不根据结果修改生产代码或重跑挑选答案。', '', '[机器汇总](memory-context-live-summary.json)；完整来源、候选、评分、请求收据和原始模型报文保存在 `.local-data/context-eval-20261028/`。');
await writeFile(path.join(root,'docs/memory-context-live-summary.json'),JSON.stringify(summary,null,2));
await writeFile(path.join(root,'docs/memory-context-live-report.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({arms:summary.arms,paired:summary.paired,totalUsage:summary.totalUsage,denseExact:summary.denseExact},null,2));
