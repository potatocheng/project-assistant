// Read-only integrity checks for the separately authorized reliability rerun.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { verifyStructuredReport } from './verify-memory-qa-structured-results.mjs';
import { verifyQaReliabilityRecordedBudget } from './memory-qa-reliability-evaluation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = process.argv[2];
if (!file || file.startsWith('--')) throw new Error('Usage: node verify-memory-qa-reliability-results.mjs REPORT [--no-write]');
const reportPath = path.resolve(root, file), bytes = await readFile(reportPath);
const report = await readPublicLiveReport(reportPath);
assert.equal(report.outputTag, 'qa-reliability-dev');
assert.equal(report.split, 'development');
assert.equal(report.judgeMode, 'separated');
assert.equal(report.expectedQuestions, 20);
assert.equal(report.expectedPapers, 6);
assert.equal(report.paragraphControl, false);
assert.equal(report.diagnostic, undefined);
assert.deepEqual(report.actualModels, [report.model]);
const child = spawn(process.execPath, [path.join(root, 'scripts/verify-memory-public-live.mjs'), file, '--no-write'],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
let stdout = '';
child.stdout.on('data', bytes => stdout += bytes);
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
if (code !== 0) throw new Error(`Common live integrity failed: ${code}`);
const common = JSON.parse(stdout.trim());
const transcript = await readFile(path.resolve(root, report.workspace, 'receipts.jsonl'));
const raw = transcript.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
for (const receipt of raw) {
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    assert.ok(Number.isSafeInteger(receipt.usage?.[field]) && receipt.usage[field] >= 0, `Missing usage: receipt ${receipt.index}`);
  }
  assert.equal(receipt.usage.prompt_tokens + receipt.usage.completion_tokens, receipt.usage.total_tokens);
}
const details = await verifyStructuredReport(report, bytes, raw);
const budget = await verifyQaReliabilityRecordedBudget(root, report);
const result = { version: 'memory-qa-reliability-integrity-v1', passed: true, checkedAt: new Date().toISOString(),
  report: path.relative(root, reportPath), reportSha256: hash(bytes), transcriptSha256: hash(transcript),
  ...common, structured: details, budgetRegistration: budget.budgetRegistration,
  requests: raw.length, totalTokens: report.usage.total_tokens, usageComplete: true,
  productionSha256: report.productionSha256, binarySha256: report.binarySha256,
  evaluationSha256: report.evaluationSha256 };
const output = reportPath.replace(/-results\.json$/, '-integrity.json');
if (output === reportPath) throw new Error('Integrity cannot overwrite input');
if (!process.argv.includes('--no-write')) await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, passed: true, requests: raw.length, totalTokens: result.totalTokens,
  questions: report.expectedQuestions, claimProvenanceEntries: details.finalClaimProvenance.length }));
