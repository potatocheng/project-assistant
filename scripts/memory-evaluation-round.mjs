import { retrievalEvaluationFiles, fingerprintRetrievalEvaluation } from './memory-retrieval-evaluation-files.mjs';
import { qaEfficientEvaluationFiles, fingerprintQaEfficientEvaluation } from './memory-qa-efficient-evaluation-files.mjs';
import { qaCalibratedEvaluationFiles, fingerprintQaCalibratedEvaluation } from './memory-qa-calibrated-evaluation-files.mjs';
import { qaTargetedEvaluationFiles, fingerprintQaTargetedEvaluation } from './memory-qa-targeted-evaluation-files.mjs';

// Only evidence manifests differ. Provider calls, captured references and all
// separated judge inputs/parsing/scoring remain on the common harness path.
export function evaluationRoundForTag(tag) {
  if (typeof tag === 'string' && tag.startsWith('qa-targeted-'))
    return { name: 'qa-targeted', files: qaTargetedEvaluationFiles, fingerprint: fingerprintQaTargetedEvaluation };
  if (typeof tag === 'string' && tag.startsWith('qa-calibrated-'))
    return { name: 'qa-calibrated', files: qaCalibratedEvaluationFiles, fingerprint: fingerprintQaCalibratedEvaluation };
  return typeof tag === 'string' && tag.startsWith('qa-efficient-')
    ? { name: 'qa-efficient', files: qaEfficientEvaluationFiles, fingerprint: fingerprintQaEfficientEvaluation }
    : { name: 'retrieval', files: retrievalEvaluationFiles, fingerprint: fingerprintRetrievalEvaluation };
}
