// Post-hoc provenance only; never modifies provider inputs, outputs or grades.
import { selectedEvaluationGeneration } from './memory-qa-structured-capture.mjs';
const protocolCode = code => /SEARCH_PLAN|CONTEXT_SELECTION|GROUNDING|SCHEMA|CLAIM_BINDING|MODEL_(?:JSON|RESPONSE|OUTPUT|INCOMPLETE|TOOLS)/.test(code ?? '');
export function structuredReviewMappings(actual) {
  const trace = actual?.result?.queryTrace;
  if (!trace || !Array.isArray(trace.reviews) || !Array.isArray(trace.reviewRounds)) throw new Error('Structured explicit review provenance missing');
  const mappings = trace.reviewRounds;
  if (mappings.length !== trace.reviews.length || mappings.some((map, index) => !map || map.reviewIndex !== index
      || !Number.isSafeInteger(map.generationIndex) || map.generationIndex < 0 || map.generationIndex >= (actual.generations?.length ?? 0)
      || !Number.isSafeInteger(map.retrievalRound) || map.retrievalRound < 0
      || !['validated', 'unavailable'].includes(map.status)
      || (trace.reviews[index]?.status === 'unavailable') !== (map.status === 'unavailable'))
      || new Set(mappings.map(map => map.generationIndex)).size !== mappings.length) throw new Error('Structured explicit review provenance invalid');
  return mappings;
}

export function selectedStructuredReview(actual) {
  if (!actual?.result) return null;
  const selected = selectedEvaluationGeneration(actual), mappings = structuredReviewMappings(actual);
  if (!selected) return null;
  const generationIndex = actual.generations.indexOf(selected), matches = mappings.filter(map => map.generationIndex === generationIndex);
  if (!matches.length) return null;
  const map = matches[0];
  return { ...map, review: actual.result.queryTrace.reviews[map.reviewIndex] };
}

export function structuredSupplementProtocolFailure(actual) {
  const trace = actual?.result?.queryTrace;
  if (!trace) return false;
  if (protocolCode(trace?.supplementStatus)) return true;
  return structuredReviewMappings(actual).some(map => map.retrievalRound >= 1 && trace.reviews[map.reviewIndex]?.status === 'unavailable'
    && protocolCode(trace.reviews[map.reviewIndex].errorCode));
}

// Compatibility names in the dedicated gate; no old module is changed.
export { structuredReviewMappings as targetedReviewMappings, structuredSupplementProtocolFailure as targetedSupplementProtocolFailure };
