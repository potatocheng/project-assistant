import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const retrievalEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-public-live.mjs', 'scripts/memory-public-live-judges.mjs', 'scripts/memory-public-live-options.mjs',
  'scripts/memory-public-live-io.mjs', 'scripts/score-memory-public-live.mjs', 'scripts/compare-memory-public-live.mjs',
  'scripts/check-memory-public-development.mjs', 'scripts/check-memory-retrieval-development.mjs',
  'scripts/memory-retrieval-evaluation-files.mjs', 'docs/memory-retrieval-preregistration.json',
  'scripts/verify-memory-public-live.mjs', 'docs/memory-retrieval-evaluator-amendment.md',
]);
export async function fingerprintRetrievalEvaluation(root) {
  return Object.fromEntries(await Promise.all(retrievalEvaluationFiles.map(async file => [file,
    createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
}
