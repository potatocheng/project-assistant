// Observations only. These are trace/judge diagnostics, never new human truth.
import { createHash } from 'node:crypto';
import { budgetCanonical } from './memory-public-live-budget.mjs';
import { selectedEvaluationReferences, selectedStructuredGenerationIndices } from './memory-qa-structured-capture.mjs';
const hash=v=>createHash('sha256').update(budgetCanonical(v)).digest('hex');
const memoryId=r=>r.memoryId??r.record?.memoryId??(typeof r.id==='string'?r.id.replace(/^memory:/,''):null);
const count=values=>values.reduce((a,v)=>{a[v??'missing']=(a[v??'missing']??0)+1;return a;},{});
const usage=receipts=>({requests:receipts.length,tokens:receipts.reduce((n,r)=>n+(r.usage?.total_tokens??0),0),missingUsage:receipts.filter(r=>!Number.isSafeInteger(r.usage?.total_tokens)).length});
export function structuredOperationalObservations(report) {
  const rows=report.documents.flatMap(paper=>paper.questions.flatMap(q=>['desktop','connector'].map(entry=>{
    const value=q.entries[entry],trace=value?.result?.queryTrace??{},receipts=report.receipts.filter(r=>r.phase==='qa'&&r.questionId===q.id&&r.entry===entry);
    const reviews=receipts.filter(r=>r.task==='answer_review'),generations=value?.generations??[],selected=selectedStructuredGenerationIndices(value);
    const producerRefs=selectedEvaluationReferences(value),relevant=report.judgments.find(j=>j.id===q.id)?.relevantMemoryIds??[],relevantSet=new Set(relevant);
    const shown=refs=>new Set(refs.map(memoryId).filter(id=>relevantSet.has(id))).size;
    const reviewIndices=(trace.reviewRounds??[]).filter(m=>m.generationIndex>=1).map(m=>m.reviewIndex);
    const supplementIds=new Set([...generations.slice(1).map(g=>g.receiptId),...reviewIndices.map(i=>reviews[i]?.index).filter(Boolean)]);
    const selectedReviews=(trace.reviewRounds??[]).filter(m=>selected.includes(m.generationIndex)).map(m=>trace.reviews?.[m.reviewIndex]).filter(Boolean);
    const plan=trace.questionPlan??trace.obligationPlan??trace.questionObligations??selectedReviews.find(r=>r.questionPlan)?.questionPlan??null;
    return {paperId:paper.id,questionId:q.id,entry,answerable:q.answerable,formalMemoryCount:paper.memories.length,
      questionPlan:plan,finalStatus:value?.result?.status??'error',errorCode:value?.errorCode??null,claims:value?.result?.claims?.length??0,unknowns:value?.result?.unknowns??[],
      selectedGenerationIndices:selected,generationPackCount:generations.length,selectedProducerContextCount:selected.length,selectedUnionReferences:producerRefs.length,
      actualGenerationPacks:generations.map((g,i)=>({generationIndex:i,receiptId:g.receiptId,selected:selected.includes(i),references:g.references.length,
        referenceSha256:hash(g.references),referenceIds:g.references.map(r=>r.id??r.memoryId),bodyChars:g.references.reduce((n,r)=>n+String(r.content??'').length,0),
        judgeRelevantIdsShown:shown(g.references)})),
      judgeRelevantMemoryCount:relevant.length,judgeRelevantIdsShownInProducerUnion:shown(producerRefs),
      obligations:selectedReviews.flatMap(r=>r.obligations??r.rawProviderReview?.obligations??[]),
      claimDecisions:selectedReviews.flatMap(r=>r.claimDecisions??r.rawProviderReview?.claimDecisions??r.claimReviews??r.rawProviderReview?.claimReviews??[]),
      unknownDecisions:selectedReviews.flatMap(r=>r.unknownDecisions??r.rawProviderReview?.unknownDecisions??[]),
      reviewFailures:(trace.reviews??[]).filter(r=>r.status==='unavailable').map(r=>r.errorCode),supplementStatus:trace.supplementStatus??null,
      qa:usage(receipts),navigation:usage(receipts.filter(r=>r.task==='query_rewrite')),additionalGenerationAndReview:usage(receipts.filter(r=>supplementIds.has(r.index))),
      interpretation:'Obligation/claim decisions are the system own judgments; relevant memory IDs come from the same-model post-hoc judge. Neither is independent human truth.'};
  })));
  return {methodology:'Actual per-generation context manifests and selected union are separate. No supplied-pack freeze is claimed. All failed requests remain billed.',
    perEntry:Object.fromEntries(['desktop','connector'].map(entry=>{const r=rows.filter(r=>r.entry===entry);return [entry,{questions:r.length,statuses:count(r.map(x=>x.finalStatus)),
      selectedProducerCounts:count(r.map(x=>x.selectedProducerContextCount)),reviewFailures:count(r.flatMap(x=>x.reviewFailures)),
      qaTokens:r.reduce((n,x)=>n+x.qa.tokens,0),navigationTokens:r.reduce((n,x)=>n+x.navigation.tokens,0),additionalGenerationAndReviewTokens:r.reduce((n,x)=>n+x.additionalGenerationAndReview.tokens,0),
      unknownCount:r.reduce((n,x)=>n+x.unknowns.length,0),obligationStatuses:count(r.flatMap(x=>x.obligations.map(o=>o.status))),claimTargetStatuses:count(r.flatMap(x=>x.claimDecisions.map(o=>o.targetStatus??o.verdict??o.target??o.status)))}];})),rows};
}
export function compareActualPacks(before,after) {
 const old=new Map(before.documents.flatMap(p=>p.questions.map(q=>[q.id,q])));
 return after.documents.flatMap(p=>p.questions.flatMap(q=>['desktop','connector'].map(entry=>{
  const a=old.get(q.id)?.entries?.[entry],b=q.entries[entry];
  const first=v=>v?.generations?.[0]?.references??[];
  const oldIds=first(a).map(r=>r.id??r.memoryId),newIds=first(b).map(r=>r.id??r.memoryId);
  return {paperId:p.id,questionId:q.id,entry,firstPackIdentical:budgetCanonical(first(a))===budgetCanonical(first(b)),
    previousFirstPackSha256:hash(first(a)),currentFirstPackSha256:hash(first(b)),previousFirstPackReferenceIds:oldIds,currentFirstPackReferenceIds:newIds,
    retainedFirstPackIds:oldIds.filter(id=>newIds.includes(id)),removedFirstPackIds:oldIds.filter(id=>!newIds.includes(id)),addedFirstPackIds:newIds.filter(id=>!oldIds.includes(id)),
    previousSelectedGenerationIndices:selectedStructuredGenerationIndices(a),currentSelectedGenerationIndices:selectedStructuredGenerationIndices(b),
    note:'Offline observed pack comparison. Pack differences prevent attributing the change to generation alone; no actual fixed-supplied-pack experiment was run.'};
 })));
}
