import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const run=path.join(root,'.local-data/context-fresh-live-20261028');
const bytes=await readFile(path.join(run,'comparison.json'));
const r=JSON.parse(bytes),hash=x=>createHash('sha256').update(x).digest('hex');
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const sum=(xs,fn)=>xs.reduce((n,x)=>n+fn(x),0);
const usage=xs=>({requests:xs.length,inputTokens:sum(xs,x=>x.usage.prompt_tokens),outputTokens:sum(xs,x=>x.usage.completion_tokens),tokens:sum(xs,x=>x.usage.total_tokens),cacheHitTokens:sum(xs,x=>x.usage.prompt_cache_hit_tokens??0)});
assert(r.finishedAt&&r.runs.length===24&&r.judgments.length===12,'Incomplete final run');
const wire=(await readFile(path.join(run,'wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const requests=new Map(wire.filter(x=>x.request).map(x=>[x.index,x]));
const responses=new Map(wire.filter(x=>x.response).map(x=>[x.index,x]));
for(const receipt of r.receipts){
 assert(receipt.status===200&&!receipt.error&&receipt.actualModel===r.registration.model,`Provider ${receipt.index}`);
 assert(hash(JSON.stringify(requests.get(receipt.index)?.request))===receipt.requestSha256,`Request ${receipt.index}`);
 assert(JSON.stringify(responses.get(receipt.index)?.response.usage)===JSON.stringify(receipt.usage),`Usage ${receipt.index}`);
}
for(const v of r.runs){
 assert(!v.error&&v.job.status==='succeeded'&&v.quotesValid&&v.formalMemories===0,`Run ${v.id}`);
 assert(v.sourceSha256===hash(r.dataset.cases.find(d=>d.id===v.caseId).text),`Source ${v.id}`);
 const receipts=r.receipts.filter(x=>x.runId===v.id),budget=v.batches.map(b=>b.budget).sort((a,b)=>b.requests-a.requests)[0];
 assert(budget.requests===receipts.length&&budget.inputTokens+budget.outputTokens===usage(receipts).tokens&&budget.usageComplete,`Budget ${v.id}`);
}
for(const [arm,digest] of Object.entries(r.registration.binarySha256))assert(hash(await readFile(path.join(run,`${arm}.exe`)))===digest,`Binary ${arm}`);
assert(hash(JSON.stringify(r.dataset))===r.registration.datasetSha256,'Dataset');
for(const [file,digest] of Object.entries(r.registration.harnessSha256))assert(hash(await readFile(path.join(run,file)))===digest,`Harness ${file}`);
const totalFacts=sum(r.dataset.cases,d=>d.facts.length)*r.registration.repeats;
const result={version:'memory-context-fresh-report-v1',rawReportSha256:hash(bytes),registration:r.registration,finishedAt:r.finishedAt,totalFacts,scope:'Six newly authored diagnostic sources, actual provider calls through production Engine, two repeats per version. Source-aware, not blind or independently human labelled. No production changes during this evaluation.',integrity:{passed:true,sourceAndBinaryHashes:true,wireHashes:true,providerUsageAndJobBudgets:true,quotesValid:true,formalMemoriesWritten:0},arms:{},denseChecks:[],scopeChecks:[],judgeUsage:usage(r.receipts.filter(x=>x.phase==='judge')),totalUsage:usage(r.receipts)};
const bodyRules={
 boundary_exception_new:{related:['Selene','上述计划','隐私评审','付费企业租户'],required:['Selene','2026-12-08','隐私评审通过','付费企业租户','不包括试用租户']},
 boundary_reference_variant:{related:['Helios','这项安排','数据治理','境内付费','境外客户'],required:['Helios','2026-12-12','数据治理委员会批准','境内付费客户','境外客户仍禁止启用']},
 english_reference_variant:{related:['Aster','This release','security audit','internal pilot','External customers'],required:['Aster','2026-12-18','completed security audit','internal pilot accounts','External customers are excluded']},
};
for(const arm of ['baseline','candidate']){
 const runs=r.runs.filter(x=>x.arm===arm),receipts=r.receipts.filter(x=>x.arm===arm);
 const a={usage:usage(receipts),full:0,partial:0,missing:0,unscored:0,readyFull:0,ready:sum(runs,x=>x.candidates.filter(c=>c.ready).length),needsReview:sum(runs,x=>x.candidates.filter(c=>!c.ready).length),cases:[]};
 for(const doc of r.dataset.cases){
  const row={caseId:doc.id,total:doc.facts.length*2,full:0,partial:0,missing:0,unscored:0,readyFull:0,usage:usage(receipts.filter(x=>x.caseId===doc.id))};
  for(const j of r.judgments.filter(j=>j.caseId===doc.id)){
   const v=runs.find(x=>x.caseId===j.caseId&&x.repeat===j.repeat),o=j.output?.[['A','B'][j.mapping.indexOf(arm)]];
   if(!o){row.unscored+=doc.facts.length;continue;}
   for(const f of o.facts){row[f.fullIndices.length?'full':f.partialIndices.length?'partial':'missing']++;if(f.fullIndices.some(i=>v.candidates[i-1].ready))row.readyFull++;}
  }
  for(const key of ['full','partial','missing','unscored','readyFull'])a[key]+=row[key];
  a.cases.push(row);
 }
 result.arms[arm]=a;
 for(const v of runs){
  if(v.caseId==='dense_30_new'){
   const retained=Array.from({length:30},(_,i)=>i+1).filter(i=>v.candidates.some(c=>c.content.includes(`Q${String(i).padStart(2,'0')}队列的消息保存上限为${i+40}小时`))).length;
   result.denseChecks.push({runId:v.id,arm,retained,total:30,partitioned:v.batches.filter(b=>b.status==='partitioned').length});
  }
  const rule=bodyRules[v.caseId];
  if(rule||v.caseId==='list_scope_new'){
   const relevant=v.candidates.filter(c=>rule?rule.related.some(t=>c.content.includes(t)):['Cedar','Maple','下列变更'].some(t=>c.content.includes(t)));
   const candidates=relevant.map(c=>{
    const complete=rule?rule.required.every(t=>c.content.includes(t)):['灾备演练通过','预发布环境'].every(t=>c.content.includes(t))&&['Cedar','Maple'].some(t=>c.content.includes(t));
    return {index:c.index,content:c.content,ready:c.ready,statuses:c.statuses,literalScopeComplete:complete};
   });
   result.scopeChecks.push({runId:v.id,arm,caseId:v.caseId,candidates,incompleteReady:candidates.filter(c=>c.ready&&!c.literalScopeComplete).length});
  }
 }
}
result.duplicates=r.runs.filter(v=>v.caseId==='dense_30_new').map(v=>({runId:v.id,arm:v.arm,uniqueBodies:new Set(v.candidates.map(c=>c.content)).size,candidates:v.candidates.length,proposals:v.proposals.length,duplicateBodies:[...new Set(v.candidates.map(c=>c.content))].map(content=>({content,variants:v.candidates.filter(c=>c.content===content).map(c=>({facets:c.facets,ready:c.ready}))})).filter(v=>v.variants.length>1)}));
result.bodyAudit={provenance:'Post-run assistant inspection of every non-dense candidate body and exact dense facts; literal checks are not independent human labels or a general semantic classifier. No original model judgments were changed.',incompleteReady:Object.fromEntries(['baseline','candidate'].map(arm=>[arm,sum(result.scopeChecks.filter(x=>x.arm===arm),x=>x.incompleteReady)])),findings:[
 {issue:'dense_recall',result:'Both v8 repetitions retained all 30 facts; v7 retained 12. v8 used seven requests per repetition.'},
 {issue:'known_reference_not_recombined',result:'Selene date and qualifier remained separate. v8 held all four incomplete candidate observations for review but did not produce a complete fact.'},
 {issue:'reference_variants_bypass_gate',result:'Chinese 这项安排 and English This release remain outside supported reference matching. Four incomplete Chinese and four incomplete English candidate observations are ready in v8.'},
 {issue:'list_introduction_bypass',result:'Two 下列变更 introduction-only candidates remain ready; complete Cedar and Maple candidates also coexist.'},
 {issue:'duplicate_topic_facets',result:'Second dense repetition has 42 proposals for 30 literal bodies. The 12 repeated bodies have different topic facet strings; source/body/entity/conditions are otherwise equal in observed examples.'},
 {issue:'unrelated_neighbors',result:'Both versions preserve the independent project conditions and dates without crossover in both repetitions.'}
]};
const b=result.arms.baseline,c=result.arms.candidate;
const pct=(n,d)=>((n/d-1)*100).toFixed(1);
const lines=[
'# 新样本真实模型测试：v7 / v8','',
'本轮结论：饱和分区补提在新的30条密集事实样本上有效，但逐条审核仍有漏拦，并出现重复候选。此前“已识别不完整候选放行数为零”的结果仅成立于上一轮样本，不能推广到这轮新增表达。','',
`实际调用模型 ${r.registration.model}，经生产 pm-host 的导入、解析、提取、检查点和候选持久化流程运行。6份新构造的合成诊断资料，每版本重复2次，共24个任务，74个事实观察／版本；没有模拟模型响应，没有写入正式记忆。测试资料不是用户业务原文或独立盲测，构造时参考了现有实现。`,'',
'| 指标 | v7 | v8 |','| --- | ---: | ---: |',
`| 密集事实保留（每轮） | 12/30、12/30 | 30/30、30/30 |`,
`| 原始模型评分：完整保留 | ${b.full}/74 | ${c.full}/74 |`,
`| 原始模型评分：部分保留 / 完全遗漏 | ${b.partial} / ${b.missing} | ${c.partial} / ${c.missing} |`,
`| 正文复核：不完整候选仍可确认 | ${result.bodyAudit.incompleteReady.baseline} | ${result.bodyAudit.incompleteReady.candidate} |`,
`| 提取请求 | ${b.usage.requests} | ${c.usage.requests} |`,
`| 提取 token | ${b.usage.tokens} | ${c.usage.tokens} |`,
`| 输入 / 输出 token | ${b.usage.inputTokens} / ${b.usage.outputTokens} | ${c.usage.inputTokens} / ${c.usage.outputTokens} |`,
`| 输入缓存命中 token | ${b.usage.cacheHitTokens} | ${c.usage.cacheHitTokens} |`,'',
'## 新暴露的问题','',
'1. 中文指代漏拦：`Helios计划于2026-12-12启用批量导入。` 被单独放行，批准条件和境内／境外范围留在另一条“这项安排……”里。两轮共4条不完整候选仍 ready。',
'2. 英文指代漏拦：Aster 的发布日期和 `This release is contingent on ...` 被拆成两条，两轮共4条不完整候选仍 ready。',
'3. 列表引导语漏拦：Cedar、Maple 的完整限定候选已生成，但“下列变更……”这个缺少具体对象的引导语也单独进入 ready，两轮共2条。',
'4. 已知指代能拦截但未补全：Selene 的日期与“上述计划……”仍分开；两轮4条均进入待审，没有形成完整可用事实。',
'5. 分区去重仍有问题：第二轮密集测试为30个不同正文生成42个提案。12条相同正文因 topic 字段不同而未合并，例如“消息保存上限”与“消息保存上限为41小时”。不能把42条当成42个事实。','',
'对照代码可解释这些现象：指代检测采用有限前缀，缺少“这项安排”和“This release”；条件提示词没有覆盖“contingent on / restricted to”；独立列表引导语检查只匹配“以下”；去重指纹包含全部 facets，因此导航性 topic 差异也会阻止合并。上述为代码与实际输出的对应分析，未在本轮中途修改生产逻辑。','',
'## 分项结果和成本','',
'| 样本 | v7完整事实 | v8完整事实 | v7请求 / token | v8请求 / token |','| --- | ---: | ---: | ---: | ---: |',
...b.cases.map(x=>{const y=c.cases.find(y=>y.caseId===x.caseId);return `| ${x.caseId} | ${x.full}/${x.total} | ${y.full}/${y.total} | ${x.usage.requests} / ${x.usage.tokens} | ${y.usage.requests} / ${y.usage.tokens} |`;}),'',
`密集事实单项从两轮4次请求／18506 token 增至14次／47128 token，补齐36个原本完全遗漏的事实观察。全题集调用数变化为 +${pct(c.usage.requests,b.usage.requests)}%，token 变化为 ${pct(c.usage.tokens,b.usage.tokens)}%；总 token 略降部分来自不同样本的复查减少，其中包括应审未审，不能解释为质量不变下的纯效率提升。`,'',
`模型评分另消耗 ${result.judgeUsage.requests} 次、${result.judgeUsage.tokens} token。本轮总计 ${result.totalUsage.requests} 次真实请求、${result.totalUsage.tokens} token。均来自提供方 usage，未换算货币金额。`,'',
'## 证据与边界','',
'24个任务成功，12个评分完成；模型、二进制、题集、原始请求哈希、usage和逐任务累计预算一致，所有引文有效，正式记忆新增0条。原始同模型评分未覆盖；其 unsafe 标记存在漏报，因此不完整条目的结论来自另外逐条核对正文与 ready 状态。完整保留要求条件与事实在同一候选正文中关联，不能事后拼接两个草稿。','',
'本轮没有覆盖所有业务文本、PDF版面或问答环节。后续修复应优先处理指代与限定关联、列表引导语对象缺失，以及只因导航性 topic 不同导致的重复；不能直接抹去真正不同的实体、适用条件或有效期。','',
'[机器汇总及逐条候选](memory-context-fresh-summary.json)。冻结程序、题集、工作区、请求和响应保存在 `.local-data/context-fresh-live-20261028/`。复跑题集为 `crates/core/tests/fixtures/memory-context-live-fresh-v1.json`。',''
];
await writeFile(path.join(root,'docs/memory-context-fresh-summary.json'),JSON.stringify(result,null,2));
await writeFile(path.join(root,'docs/memory-context-fresh-report.md'),lines.join('\n'));
console.log(JSON.stringify({arms:result.arms,integrity:result.integrity,audit:result.bodyAudit,totalUsage:result.totalUsage},null,2));
