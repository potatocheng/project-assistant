// Structured-round capture only. Does not mutate any production input or old evaluator.
import { selectedEvaluationGeneration as legacySelectedGeneration, capturedEvaluationReferences, capturedEvaluationSchema } from './capture-memory-evaluation-references.mjs';
import { budgetCanonical } from './memory-public-live-budget.mjs';
export { capturedEvaluationReferences, capturedEvaluationSchema };
const canonicalId = r => r?.id ?? r?.memoryId ?? (r?.record?.memoryId ? `memory:${r.record.memoryId}` : null);
const equivalentId = (a,b) => typeof a==='string' && typeof b==='string' && a.replace(/^memory:/,'')===b.replace(/^memory:/,'');
export function selectedStructuredGenerationIndices(actual) {
  const generations=actual?.generations??[], trace=actual?.result?.queryTrace;
  if (!Array.isArray(generations)) throw new Error('Structured generation capture schema');
  if (!Object.hasOwn(trace??{},'answerGenerationIndices')) {
    const g=legacySelectedGeneration(actual); return g ? [generations.indexOf(g)] : [];
  }
  const indices=trace.answerGenerationIndices;
  if (!Array.isArray(indices) || indices.length>2 || indices.some((n,i)=>!Number.isSafeInteger(n)||n<0||n>=generations.length||(i>0&&n<=indices[i-1]))
      || generations.length>2 || (indices.length && trace.answerGenerationIndex!==indices.at(-1))) throw new Error('Structured selected generation indices invalid');
  const receiptIds=generations.map(g=>g.receiptId);
  if(receiptIds.some((id,i)=>!Number.isSafeInteger(id)||id<1||!actual.receiptIds?.includes(id)||(i>0&&id<=receiptIds[i-1]))) throw new Error('Structured generation receipt mapping invalid');
  return indices;
}
export function selectedStructuredGenerations(actual) { return selectedStructuredGenerationIndices(actual).map(i=>actual.generations[i]); }
export function selectedEvaluationGeneration(actual) { return selectedStructuredGenerations(actual).at(-1)??null; }
export function selectedEvaluationReferences(actual) {
  const seen=new Set(), refs=[];
  for (const g of selectedStructuredGenerations(actual)) for (const r of g.references??[]) {
    const key=budgetCanonical(r); if (!seen.has(key)) { seen.add(key); refs.push(r); }
  }
  return refs;
}
export function validateStructuredClaimProvenance(actual) {
  const trace=actual?.result?.queryTrace, claims=actual?.result?.claims??[], selected=selectedStructuredGenerationIndices(actual);
  if (!Object.hasOwn(trace??{},'answerGenerationIndices')) return { mode:'legacy-single-producer', claimCount:claims.length, generationIndices:selected };
  const provenance=trace.answerClaimProvenance;
  if (!Array.isArray(provenance)||provenance.length!==claims.length) throw new Error('Structured final claim provenance count');
  const seen=new Set();
  for (const p of provenance) {
    if (!Number.isSafeInteger(p.claimIndex)||p.claimIndex<1||p.claimIndex>claims.length||seen.has(p.claimIndex)||!selected.includes(p.generationIndex)
        || !Number.isSafeInteger(p.sourceClaimIndex)||p.sourceClaimIndex<1||!Number.isSafeInteger(p.retrievalRound)||p.retrievalRound<0) throw new Error('Structured final claim provenance index');
    seen.add(p.claimIndex);
    const claim=claims[p.claimIndex-1], g=actual.generations[p.generationIndex], raw=g?.output?.claims?.[p.sourceClaimIndex-1];
    if (!raw||typeof raw.text!=='string'||claim.text!==raw.text.trim()||p.text!==claim.text) throw new Error('Structured final claim text differs from raw producer');
    const round=trace.generationRounds?.find(r=>r.generationIndex===p.generationIndex);
    if (!round||round.retrievalRound!==p.retrievalRound) throw new Error('Structured producer retrieval round mismatch');
    const support=raw.supportSpans;
    if (!Array.isArray(support)||!support.length||!Array.isArray(g.rawReferences)) throw new Error('Structured raw support spans absent');
    const expected=support.map(s=>{
      if (!Number.isSafeInteger(s.referenceIndex)||s.referenceIndex<1||!Number.isSafeInteger(s.spanIndex)||s.spanIndex<1) throw new Error('Structured raw support index');
      const r=g.rawReferences[s.referenceIndex-1]; if (!r) throw new Error('Structured raw reference missing');
      const span=Array.isArray(r.content)?r.content.find(t=>t.spanIndex===s.spanIndex):s.spanIndex===1?{text:r.content}:null;
      if (!span||typeof span.text!=='string') throw new Error('Structured raw support span missing');
      return {citationId:canonicalId(r),quote:span.text};
    });
    const quotes=claim.supportQuotes;
    if (!Array.isArray(quotes)||quotes.length!==expected.length||expected.some(e=>!quotes.some(q=>equivalentId(q.citationId,e.citationId)&&q.quote===e.quote))
        || quotes.some(q=>!expected.some(e=>equivalentId(q.citationId,e.citationId)&&q.quote===e.quote))) throw new Error('Structured final support quote differs from actual producer span');
    const ids=claim.citationIds;
    if (!Array.isArray(ids)||ids.some(id=>!expected.some(e=>equivalentId(id,e.citationId)))||expected.some(e=>!ids.some(id=>equivalentId(id,e.citationId)))) throw new Error('Structured final citation differs from actual producer');
  }
  const actualProducers=[...new Set(provenance.map(p=>p.generationIndex))].sort((a,b)=>a-b);
  const expectedProducers=claims.length?actualProducers:Number.isSafeInteger(trace.answerGenerationIndex)?[trace.answerGenerationIndex]:[];
  if(budgetCanonical(selected)!==budgetCanonical(expectedProducers)) throw new Error('Structured selected producers differ from actual final claim producers');
  return {mode:'explicit-multiple-producers',claimCount:claims.length,generationIndices:selected};
}
