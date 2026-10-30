// Additional cumulative provenance for the new round; the common verifier
// continues to validate every raw provider request and production artifact.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { verifyQaTargetedRecordedBudget } from './memory-qa-targeted-budget.mjs';
const root = path.resolve(import.meta.dirname, '..'), file = process.argv[2];
if (!file || file.startsWith('--')) throw new Error('Usage: node verify-memory-qa-targeted-results.mjs REPORT [--no-write]');
const child = spawn(process.execPath, [path.join(root, 'scripts/verify-memory-public-live.mjs'), file, '--no-write'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
if (code !== 0) throw new Error(`Common live integrity failed: ${code}`);
const report = await readPublicLiveReport(path.resolve(root, file));
if (!report.outputTag.startsWith('qa-targeted-')) throw new Error('Dedicated targeted integrity accepts only its round');
const budget = await verifyQaTargetedRecordedBudget(root, report), common = JSON.parse(stdout.trim());
const result = { ...common, targetedBudget: { registration: budget.budgetRegistration, ledger: budget.ledger,
  historical: { requests: budget.historical.requests, totalTokens: budget.historical.totalTokens }, attempt: budget.attempt },
  registrationSha256: createHash('sha256').update(await readFile(path.resolve(root, budget.budgetRegistration.file))).digest('hex') };
const output = path.resolve(root, file).replace(/-results\.json$/, '-integrity.json');
if (output === path.resolve(root, file)) throw new Error('Integrity output must not overwrite its input');
if (!process.argv.includes('--no-write')) await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result));
