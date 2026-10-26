import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const qaCalibratedEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-public-live.mjs', 'scripts/memory-evaluation-round.mjs',
  'scripts/memory-public-live-judges.mjs', 'scripts/memory-public-live-options.mjs',
  'scripts/memory-public-live-io.mjs', 'scripts/score-memory-public-live.mjs', 'scripts/compare-memory-public-live.mjs',
  'scripts/check-memory-public-development.mjs', 'scripts/check-memory-qa-calibrated-development.mjs',
  'scripts/memory-qa-calibrated-evaluation-files.mjs', 'docs/memory-qa-calibrated-preregistration.json',
  'scripts/verify-memory-public-live.mjs',
  'scripts/capture-memory-evaluation-references.mjs', 'docs/memory-qa-calibrated-format-adaptation.md',
  'scripts/memory-public-live-budget.mjs', 'docs/memory-qa-calibrated-budget-addendum-1.json',
]);
export async function fingerprintQaCalibratedEvaluation(root) {
  return Object.fromEntries(await Promise.all(qaCalibratedEvaluationFiles.map(async file => [file,
    createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
}
