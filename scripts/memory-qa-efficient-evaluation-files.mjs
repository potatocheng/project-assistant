import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const qaEfficientEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-public-live.mjs', 'scripts/memory-evaluation-round.mjs',
  'scripts/memory-public-live-judges.mjs', 'scripts/memory-public-live-options.mjs',
  'scripts/memory-public-live-io.mjs', 'scripts/score-memory-public-live.mjs', 'scripts/compare-memory-public-live.mjs',
  'scripts/check-memory-public-development.mjs', 'scripts/check-memory-qa-efficient-development.mjs',
  'scripts/memory-qa-efficient-evaluation-files.mjs', 'docs/memory-qa-efficient-preregistration.json',
  'scripts/verify-memory-public-live.mjs',
  'scripts/capture-memory-evaluation-references.mjs', 'docs/memory-qa-efficient-format-adaptation.md',
]);
export async function fingerprintQaEfficientEvaluation(root) {
  return Object.fromEntries(await Promise.all(qaEfficientEvaluationFiles.map(async file => [file,
    createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
}
