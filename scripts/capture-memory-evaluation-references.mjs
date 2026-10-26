// Post-hoc capture projection only. The original provider request is never
// mutated. Both formats carry the same complete current reference body.
export function capturedEvaluationReferences(user) {
  const references = user.references ?? user.context?.memories ?? [];
  if (!Array.isArray(references)) throw new Error('Evaluation reference capture schema');
  return references.map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('Evaluation reference capture schema');
    if (typeof reference.content === 'string') return reference;
    if (!Array.isArray(reference.content) || !reference.content.length) throw new Error('Evaluation reference capture spans');
    for (const [offset, span] of reference.content.entries()) {
      if (!span || typeof span !== 'object' || Array.isArray(span) || !Number.isSafeInteger(span.spanIndex)
          || span.spanIndex !== offset + 1 || typeof span.text !== 'string') throw new Error('Evaluation reference capture spans');
    }
    return { ...reference, content: reference.content.map(span => span.text).join('') };
  });
}

// The producer may retain its first reviewed partial after an unsuccessful
// supplement. Never reorder attempts or silently accept an arbitrary index.
export function selectedEvaluationGeneration(actual) {
  const generations = actual?.generations ?? [];
  if (!Array.isArray(generations)) throw new Error('Evaluation generation capture schema');
  const trace = actual?.result?.queryTrace;
  const index = trace?.answerGenerationIndex;
  if (!trace || !Object.hasOwn(trace, 'answerGenerationIndex')) {
    if (trace?.reviewedPartialFallback === true) throw new Error('Evaluation reviewed partial fallback without selection');
    return generations.at(-1) ?? null;
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= generations.length || generations.length > 2) throw new Error('Evaluation selected generation index');
  const receiptIds = generations.map(g => g.receiptId);
  if (receiptIds.some(id => !Number.isSafeInteger(id) || id < 1 || !actual.receiptIds?.includes(id))
      || new Set(receiptIds).size !== receiptIds.length || receiptIds.some((id, n) => n > 0 && id <= receiptIds[n - 1])) throw new Error('Evaluation generation receipt mapping');
  if (trace.reviewedPartialFallback === true) {
    const initialReview = trace.reviews?.[0];
    if (![1, 2].includes(generations.length) || index !== 0 || actual.result.grounded !== true || actual.result.status !== 'partial'
        || generations[0]?.output?.grounded !== true || initialReview?.supported !== true || initialReview?.answersQuestion !== true)
      throw new Error('Evaluation reviewed partial fallback');
  } else if (index !== generations.length - 1) throw new Error('Evaluation unreviewed generation selection');
  return generations[index];
}

export function selectedEvaluationReferences(actual) {
  return selectedEvaluationGeneration(actual)?.references ?? [];
}

export function capturedEvaluationSchema(request, user) {
  const candidate = user?.schema ?? request?.response_format?.json_schema?.schema ?? request?.format;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
}
