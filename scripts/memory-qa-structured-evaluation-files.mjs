import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const qaStructuredEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-qa-structured-live.mjs','scripts/memory-qa-structured-options.mjs',
  'scripts/memory-qa-structured-pre-live.mjs','scripts/memory-qa-structured-judges.mjs','scripts/memory-qa-structured-capture.mjs','scripts/memory-qa-structured-freeze.mjs',
  'scripts/memory-qa-structured-budget.mjs','scripts/memory-qa-structured-review-mapping.mjs','scripts/memory-qa-structured-observations.mjs',
  'scripts/memory-qa-structured-evaluation-files.mjs','scripts/score-memory-qa-structured-live.mjs',
  'scripts/check-memory-qa-structured-development.mjs','scripts/verify-memory-qa-structured-results.mjs',
  'docs/memory-qa-structured-preregistration.json','docs/memory-qa-structured-format-adaptation.md',
  'scripts/memory-public-live-judges.mjs','scripts/memory-public-live-options.mjs','scripts/memory-public-live-io.mjs',
  'scripts/score-memory-public-live.mjs','scripts/compare-memory-public-live.mjs','scripts/check-memory-public-development.mjs',
  'scripts/verify-memory-public-live.mjs','scripts/capture-memory-evaluation-references.mjs','scripts/memory-public-live-budget.mjs'
]);
export async function fingerprintQaStructuredEvaluation(root) {
  return Object.fromEntries(await Promise.all(qaStructuredEvaluationFiles.map(async file=>[file,
    createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
}
