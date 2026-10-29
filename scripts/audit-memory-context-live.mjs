// Post-run, explicitly labelled conservative audit. Never alters raw judgments.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const bytes=await readFile(path.join(root,'.local-data/context-eval-20261028/comparison.json'));
const r=JSON.parse(bytes),hash=x=>createHash('sha256').update(x).digest('hex');
const original=JSON.parse(await readFile(path.join(root,'docs/memory-context-live-summary.json')));
const audit={version:'context-extraction-posthoc-audit-v1',provenance:'Assistant review of all actual memory bodies and the declared single-body rubric; not independent human labels; post-run corrections kept separate from original automatic scores.',rawReportSha256:hash(bytes),corrections:[],arms:{},integrity:{}};
for(const arm of ['baseline','candidate']){
 const counts={full:0,partial:0,missing:0,readyFull:0,contextFull:0};
 for(const j of r.judgments){
  const label=['A','B'][j.mapping.indexOf(arm)],judgment=j.output[label];
  const run=r.runs.find(v=>v.caseId===j.caseId&&v.repeat===j.repeat&&v.arm===arm),doc=r.dataset.cases.find(d=>d.id===j.caseId);
  for(const fact of judgment.facts){
   let full=[...fact.fullIndices],partial=[...fact.partialIndices];
   const reason=j.caseId==='heading_scope'?'候选正文只有“本章标题所指的项目”，没有Vega，原评分借用了原文标题。':j.caseId==='markdown_table'?'候选正文仅为表格数据行，未包含表头或负责人、截止日期、前提的字段关系，原评分借用了表头。':j.caseId==='historical_change'&&fact.id==='historical_qualified'?'被判完整的更正候选没有张磊和2026-10-18；原评分把不同候选中的旧安排与失效关系拼在一起。':null;
   if(reason){
    const absent=i=>{const body=run.candidates[i-1].content;return j.caseId==='heading_scope'?!body.includes('Vega'):j.caseId==='markdown_table'?!['负责人','截止','前提'].every(t=>body.includes(t)):!['张磊','2026-10-18','失效'].every(t=>body.includes(t));};
    const invalid=full.filter(absent);
    if(invalid.length){audit.corrections.push({caseId:j.caseId,repeat:j.repeat,arm,factId:fact.id,from:'full',to:'partial',indices:invalid,bodies:invalid.map(i=>run.candidates[i-1].content),reason});full=full.filter(i=>!invalid.includes(i));partial=[...new Set([...partial,...invalid])];}
   }
   const state=full.length?'full':partial.length?'partial':'missing';counts[state]++;
   if(full.some(i=>run.candidates[i-1].ready))counts.readyFull++;
   if(state==='full'&&doc.facts.find(f=>f.id===fact.id).context)counts.contextFull++;
  }
 }
 audit.arms[arm]=counts;
}
const wire=(await readFile(path.join(root,'.local-data/context-eval-20261028/wire.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
const requestMap=new Map(wire.filter(x=>x.request).map(x=>[x.index,x]));const responseMap=new Map(wire.filter(x=>x.response).map(x=>[x.index,x]));
const assert=(ok,message)=>{if(!ok)throw Error(message);};
for(const receipt of r.receipts){
 assert(hash(JSON.stringify(requestMap.get(receipt.index)?.request))===receipt.requestSha256,`Request hash ${receipt.index}`);
 assert(JSON.stringify(responseMap.get(receipt.index)?.response.usage)===JSON.stringify(receipt.usage),`Usage ${receipt.index}`);
 assert(receipt.actualModel===r.registration.model,`Model ${receipt.index}`);
}
for(const run of r.runs){
 assert(run.job.status==='succeeded'&&!run.error,`Job ${run.id}`);
 assert(run.quotesValid&&run.formalMemories===0,`Memory boundary ${run.id}`);
 assert(run.sourceSha256===hash(r.dataset.cases.find(d=>d.id===run.caseId).text),`Source ${run.id}`);
 const events=r.receipts.filter(x=>x.runId===run.id);
 const requests=Math.max(...run.batches.map(b=>b.budget.requests));
 assert(requests===events.length,`Budget requests ${run.id}`);
}
for(const [arm,digest] of Object.entries(r.registration.binarySha256))assert(hash(await readFile(path.join(root,'.local-data/context-eval-20261028',`${arm}.exe`)))===digest,`Binary ${arm}`);
assert(hash(JSON.stringify(r.dataset))===r.registration.datasetSha256,'Dataset hash');
for(const [file,digest]of Object.entries(r.registration.harnessSha256))assert(hash(await readFile(path.join(root,'.local-data/context-eval-20261028',file)))===digest,`Harness ${file}`);
assert(r.runs.length===48&&r.judgments.length===24&&r.judgments.every(j=>j.output&&!j.error),'Completeness');
audit.integrity={passed:true,requests:r.receipts.length,runs:r.runs.length,judgments:r.judgments.length,wireRequestHashes:true,providerUsage:true,modelBinding:true,binaryHashes:true,fixtureHash:true,harnessHashes:true,sourceIdentity:true,perTaskRequestBudget:true,quotesValid:true,formalMemoriesWritten:0};
audit.observations=[
 {issue:'saturated_output_still_loses_facts',evidence:original.denseExact,conclusion:'18个独立事实，新旧两次均仅保留12个；v7每次多一次复查，仍受同一12条上限约束。'},
 {issue:'incomplete_sibling_remains_confirmable',evidence:r.runs.filter(v=>v.caseId==='post_boundary_condition'&&v.arm==='candidate').map(v=>({runId:v.id,candidates:v.candidates.map(c=>({content:c.content,ready:c.ready}))})),conclusion:'完整条件候选被拦为待审，但其他窗口生成的无条件短候选仍ready；批次级检查未保证每条候选完整。'},
 {issue:'review_burden',before:original.arms.baseline.needsReview,after:original.arms.candidate.needsReview,conclusion:'复查结果整体转待审，不能把草稿留存收益当作立即可用正式记忆收益。'}
];
await writeFile(path.join(root,'docs/memory-context-live-adjudication.json'),JSON.stringify(audit,null,2));
const b=audit.arms.baseline,c=audit.arms.candidate;
const appendix=`\n## 输出复核与保守修正\n\n自动评分存在将原文标题、表头和其他候选补入当前正文的偏差。助手按运行前声明的“单条正文完整表达”标准核对实际输出，另存${audit.corrections.length}个评分修正；它们是事后助手复核，不是独立人工标注。上表原始自动分数未被覆盖。\n\n| 保守复核口径 | v6 | v7 |\n| --- | ---: | ---: |\n| 完整保留 | ${b.full}/90 | ${c.full}/90 |\n| 部分保留 | ${b.partial}/90 | ${c.partial}/90 |\n| 完全遗漏 | ${b.missing}/90 | ${c.missing}/90 |\n| 上下文相关完整保留 | ${b.contextFull}/36 | ${c.contextFull}/36 |\n| 可确认候选完整保留 | ${b.readyFull}/90 | ${c.readyFull}/90 |\n\n直接核对的改善来自跨批后置条件和列表引导范围，两轮均复现。密集样本18个事实仍只保留12个；多做一次受相同输出上限约束的替换提取未补齐剩余6个。新版Atlas完整条件草稿旁边仍存在ready的无条件短候选，门禁需落实到每条事实及重叠窗口，不能仅按某批存在完整条件就放行其他候选。标题主体和表头字段关系仍未完整写入正文。\n\n生产提取 token 消耗上升30.7%，请求上升13.3%；需要人工审核的候选由4增至36。当前结果支持“部分上下文组合改善”，不支持“普遍解决漏提”或“减少人工审核”。下一步应优先对饱和批次分区补提、关联处理重叠窗口中的不完整候选，并让审核门禁定位具体候选。\n\n[逐项复核与完整性检查](memory-context-live-adjudication.json)。88个真实请求均有提供方usage，48个任务成功，24个评分完成；请求报文哈希、模型、二进制、题集、任务请求预算及引文核验通过。\n`;
const doc=path.join(root,'docs/memory-context-live-report.md');const text=await readFile(doc,'utf8');await writeFile(doc,text.split('\n## 输出复核与保守修正')[0]+appendix);
console.log(JSON.stringify({arms:audit.arms,corrections:audit.corrections.length,integrity:audit.integrity},null,2));
