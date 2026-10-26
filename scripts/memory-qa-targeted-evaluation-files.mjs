import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const qaTargetedEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-public-live.mjs', 'scripts/memory-evaluation-round.mjs',
  'scripts/memory-public-live-judges.mjs', 'scripts/memory-public-live-options.mjs',
  'scripts/memory-public-live-io.mjs', 'scripts/score-memory-public-live.mjs', 'scripts/compare-memory-public-live.mjs',
  'scripts/check-memory-public-development.mjs', 'scripts/check-memory-qa-targeted-development.mjs',
  'scripts/memory-qa-targeted-evaluation-files.mjs', 'docs/memory-qa-targeted-preregistration.json',
  'scripts/verify-memory-public-live.mjs', 'scripts/capture-memory-evaluation-references.mjs',
  'docs/memory-qa-targeted-format-adaptation.md', 'scripts/memory-public-live-budget.mjs',
  'scripts/memory-qa-targeted-budget.mjs', 'scripts/verify-memory-qa-targeted-results.mjs',
  'scripts/memory-qa-targeted-capture.mjs',
]);
export async function fingerprintQaTargetedEvaluation(root) {
  return Object.fromEntries(await Promise.all(qaTargetedEvaluationFiles.map(async file => [file,
    createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
}
