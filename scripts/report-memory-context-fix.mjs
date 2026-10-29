import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const run=path.join(root,'.local-data/context-fix-final-20261028');
const bytes=await readFile(path.join(run,'comparison.json'));
const r=JSON.parse(bytes),hash=x=>createHash('sha256').update(x).digest('hex');
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const sum=(xs,fn)=>xs.reduce((n,x)=>n+fn(x),0);
const usage=xs=>({requests:xs.length,inputTokens:sum(xs,x=>x.usage.prompt_tokens),outputTokens:sum(xs,x=>x.usage.completion_tokens),tokens:sum(xs,x=>x.usage.total_tokens),cacheHitTokens:sum(xs,x=>x.usage.prompt_cache_hit_tokens??0)});
assert(r.finishedAt&&r.runs.length===16&&r.judgments.length===8,'Incomplete final run');
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
const result={version:'memory-context-fix-report-v1',rawReportSha256:hash(bytes),registration:r.registration,finishedAt:r.finishedAt,scope:'Targeted diagnostic regression, four synthetic cases, two repetitions; not blind or independently human labelled. Body checks below are post-run assistant-authored assertions, kept separate from raw same-model judgments.',integrity:{passed:true,sourceAndBinaryHashes:true,wireHashes:true,providerUsageAndJobBudgets:true,quotesValid:true,formalMemoriesWritten:0},arms:{},bodyChecks:[],judgeUsage:usage(r.receipts.filter(x=>x.phase==='judge')),finalUsage:usage(r.receipts)};
for(const arm of ['baseline','candidate']){
 const runs=r.runs.filter(x=>x.arm===arm),receipts=r.receipts.filter(x=>x.arm===arm);
 const a={usage:usage(receipts),full:0,partial:0,missing:0,readyFull:0,ready:sum(runs,x=>x.candidates.filter(c=>c.ready).length),needsReview:sum(runs,x=>x.candidates.filter(c=>!c.ready).length),cases:[]};
 for(const j of r.judgments){
  assert(j.output&&!j.error,`Judge ${j.id}`);
  const v=runs.find(x=>x.caseId===j.caseId&&x.repeat===j.repeat),o=j.output[['A','B'][j.mapping.indexOf(arm)]];
  for(const f of o.facts){a[f.fullIndices.length?'full':f.partialIndices.length?'partial':'missing']++;if(f.fullIndices.some(i=>v.candidates[i-1].ready))a.readyFull++;}
 }
 for(const doc of r.dataset.cases)a.cases.push({caseId:doc.id,usage:usage(receipts.filter(x=>x.caseId===doc.id))});
 result.arms[arm]=a;
 for(const v of runs){
  if(v.caseId==='dense_facts'){
   const ids=Array.from({length:18},(_,i)=>({service:`D${String(i+1).padStart(2,'0')}`,days:i+11}));
   const retained=ids.filter(f=>v.candidates.some(c=>c.content.includes(f.service)&&c.content.includes(`为${f.days}天`))).length;
   const check={runId:v.id,caseId:v.caseId,arm,retained,total:18,partitioned:v.batches.filter(b=>b.status==='partitioned').length};result.bodyChecks.push(check);
   if(arm==='candidate')assert(retained===18&&check.partitioned>0,`Dense regression ${v.id}`);
  }
  if(['post_boundary_condition','list_scope'].includes(v.caseId)){
   const incomplete=v.candidates.filter(c=>v.caseId==='post_boundary_condition'
    ?(c.content.includes('Atlas')&&!['安全评审通过','内部员工'].every(t=>c.content.includes(t)))||(c.content.includes('上述计划')&&!c.content.includes('Atlas'))
    :(c.content.includes('以下两项')&&!['Nimbus','Cirrus'].some(t=>c.content.includes(t)))||(['Nimbus','Cirrus'].some(t=>c.content.includes(t))&&!['测试环境','生产环境均未批准'].every(t=>c.content.includes(t))));
   const check={runId:v.id,caseId:v.caseId,arm,incomplete:incomplete.map(c=>({content:c.content,ready:c.ready,statuses:c.statuses})),incompleteReady:incomplete.filter(c=>c.ready).length};result.bodyChecks.push(check);
   if(arm==='candidate')assert(check.incompleteReady===0,`Candidate gate regression ${v.id}`);
  }
  if(v.caseId==='unrelated_neighbor'){
   assert(v.candidates.some(c=>c.content.includes('Aurora')&&!c.content.includes('法务')&&c.ready),`Unrelated scope ${v.id}`);
  }
 }
}
const development=JSON.parse(await readFile(path.join(root,'.local-data/context-fix-20261028/comparison.json'),'utf8'));
result.developmentUsage=usage(development.receipts);result.totalFixExperimentUsage=usage([...development.receipts,...r.receipts]);
const b=result.arms.baseline,c=result.arms.candidate;
const pct=(n,d)=>((n/d-1)*100).toFixed(1);
const bad=arm=>sum(result.bodyChecks.filter(x=>x.arm===arm),x=>x.incompleteReady??0);
const report=[
'# 饱和分区补提与逐条审核：v7 / v8 定向复测','',
`模型为 ${r.registration.model}，4 类合成资料，每版本各重复 2 次，共 16 个提取任务、每版本 46 个事实观察。基线为上一轮冻结的 v7；最终 v8 在本轮测试前冻结，二进制哈希见机器汇总。未确认任何正式记忆。`,
'', '| 指标 | v7 | v8 |','| --- | ---: | ---: |',
`| 密集事实（每轮） | 12/18、12/18 | ${result.bodyChecks.filter(x=>x.arm==='candidate'&&x.caseId==='dense_facts').map(x=>`${x.retained}/18`).join('、')} |`,
`| 跨段／列表中已识别的不完整条目仍可确认 | ${bad('baseline')} | ${bad('candidate')} |`,
`| 原始同模型评分：完整保留 | ${b.full}/46 | ${c.full}/46 |`,
`| 原始同模型评分：完全遗漏 | ${b.missing}/46 | ${c.missing}/46 |`,
`| 原始同模型评分：可确认候选完整保留 | ${b.readyFull}/46 | ${c.readyFull}/46 |`,
`| 提取与复查请求 | ${b.usage.requests} | ${c.usage.requests} |`,
`| 提取与复查 token | ${b.usage.tokens} | ${c.usage.tokens} |`,
`| 输入 / 输出 token | ${b.usage.inputTokens} / ${b.usage.outputTokens} | ${c.usage.inputTokens} / ${c.usage.outputTokens} |`,
`| 输入缓存命中 token | ${b.usage.cacheHitTokens} | ${c.usage.cacheHitTokens} |`,'',
'密集样本按句分成两个分区，父级已找到的有效事实保留，子级补齐其余内容并去重。跨段样本中，包含 Atlas 日期、安全前提和内部员工范围的完整候选可确认；缺条件的短句及不含所指事实的单独限定语均待审。列表样本逐条绑定测试环境和生产未批准的范围。无关邻段样本没有将 Borealis 的法务条件附加给 Aurora。','',
`本轮生产路径请求增加 ${pct(c.usage.requests,b.usage.requests)}%，token 增加 ${pct(c.usage.tokens,b.usage.tokens)}%。逐条门禁可能触发以前被批次级检查漏掉的复查，因此总体成本上升。下面两次重复合并计数：`,'',
'| 样本 | v7 请求 | v8 请求 | v7 token | v8 token |','| --- | ---: | ---: | ---: | ---: |',
...b.cases.map(x=>{const y=c.cases.find(y=>y.caseId===x.caseId);return `| ${x.caseId} | ${x.usage.requests} | ${y.usage.requests} | ${x.usage.tokens} | ${y.usage.tokens} |`;}),'',
`评分单独消耗 ${result.judgeUsage.requests} 次、${result.judgeUsage.tokens} token；最终比较共 ${result.finalUsage.requests} 次、${result.finalUsage.tokens} token。另有一轮修复开发复测（随后补上父级成果保留）消耗 ${result.developmentUsage.requests} 次、${result.developmentUsage.tokens} token，原始记录保留。本次修复全部真实模型实验共 ${result.totalFixExperimentUsage.requests} 次、${result.totalFixExperimentUsage.tokens} token。所有 token 来自提供方 usage；不按当前单价估算货币费用。`,'',
'该结果是针对已知问题的诊断回归。题集来自上一轮合成资料，两次重复不足以证明泛化或统计显著性。同模型评分仍会对限定语、单个列表条目的完整性给出不一致判断，因此逐条门禁结论另外按实际正文和状态核对；原始评分未修改。零个已识别不完整条目被放行，不代表所有语义错误都能检测。既有 v7 候选不会自动重新审核；需重新提取或人工处理。','',
'完整性检查通过：原始请求哈希、模型返回 usage、逐任务累计预算、题集和程序哈希、来源正文与引文；16 个任务成功。完整报文与候选保存在 `.local-data/context-fix-final-20261028/`，开发复测在 `.local-data/context-fix-20261028/`。','',
'[机器汇总与逐条正文检查](memory-context-fix-summary.json) · [实现与边界](memory-context-extraction.md)',''
].join('\n');
await writeFile(path.join(root,'docs/memory-context-fix-summary.json'),JSON.stringify(result,null,2));
await writeFile(path.join(root,'docs/memory-context-fix-report.md'),report);
console.log(JSON.stringify({arms:result.arms,bodyChecks:result.bodyChecks,integrity:result.integrity,totalUsage:result.totalFixExperimentUsage},null,2));
