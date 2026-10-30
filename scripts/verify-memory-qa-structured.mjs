// Fresh deterministic evidence for the QA target round; no model calls.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fingerprintQaStructuredEvaluation } from './memory-qa-structured-evaluation-files.mjs';
const root = path.resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(path.join(root, '.local-data'), { recursive: true });
const logs = await mkdtemp(path.join(root, '.local-data/qa-structured-regressions-'));
const cargo = process.platform === 'win32' ? path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo', node = process.execPath;
const nodeTests = (await readdir(path.join(root, 'scripts'))).filter(f => f.endsWith('.test.mjs') && !f.includes('db-')).map(f => `scripts/${f}`);
const previous = JSON.parse(await readFile(path.join(root, 'docs/memory-public-live-qa-targeted-dev-v4-results.json')));
const commands = [
  [cargo, ['test', '-p', 'project-assistant-core', '--locked']],
  [cargo, ['clippy', '-p', 'project-assistant-core', '--locked', '--lib', '--tests', '--', '-D', 'warnings']],
  [cargo, ['build', '-p', 'project-assistant-core', '--bin', 'pm-host', '--locked']],
  ...(process.platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-Command', 'npm run build']]] : [['npm', ['run', 'build']]]),
  [node, ['--test', ...nodeTests]],
  [node, ['scripts/verify-restart.mjs']],
  [node, ['scripts/verify-extraction-recovery.mjs']],
  [node, ['scripts/verify-memory-public-live.mjs', '--no-write']],
  [node, ['scripts/verify-memory-public-live.mjs', 'docs/memory-public-live-qa-efficient-dev-v2-results.json',
    'docs/memory-public-live-qa-calibrated-dev-results.json', 'docs/memory-public-live-qa-calibrated-dev-v2-results.json', 'docs/memory-public-live-qa-calibrated-dev-v3-results.json', 'docs/memory-public-live-qa-targeted-dev-results.json', 'docs/memory-public-live-qa-targeted-dev-v2-results.json', 'docs/memory-public-live-qa-targeted-dev-v3-results.json', 'docs/memory-public-live-qa-targeted-dev-v4-results.json', '--no-write']],
  [node, ['scripts/verify-memory-public-live.mjs', 'docs/memory-public-live-qa-efficient-full-results.json', '--no-write']],
  [cargo, ['test', '-p', 'project-assistant-core', '--lib', '--locked', 'diagnose_public_live_retrieval', '--', '--ignored', '--nocapture'], {
    MEMORY_PUBLIC_LIVE_REPORT: path.resolve(root, previous.detailFile), MEMORY_PUBLIC_LIVE_ROOT: root,
    MEMORY_PUBLIC_LIVE_ABLATION: path.join(logs, 'same-memory-qa-diagnostic.json'),
  }],
];
const evidence = { version: 'memory-qa-structured-regressions-v1', startedAt: new Date().toISOString(), logs: path.relative(root, logs), passed: false, commands: [] };
for (const [program, args, env] of commands) {
  const command = `${path.basename(program)} ${args.join(' ')}`; console.log(`START ${command}`);
  const start = Date.now(), chunks = [];
  const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { chunks.push(b); process.stdout.write(b); });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const log = path.join(logs, `${evidence.commands.length + 1}.log`); await writeFile(log, Buffer.concat(chunks));
  evidence.commands.push({ command, exitCode, elapsedMs: Date.now() - start, log: path.relative(root, log) });
  evidence.finishedAt = new Date().toISOString(); evidence.passed = evidence.commands.length === commands.length && evidence.commands.every(c => c.exitCode === 0);
  const files = (await readdir(path.join(root, 'crates/core/src'), { recursive: true })).filter(f => f.endsWith('.rs')).sort();
  evidence.productionSha256 = Object.fromEntries(await Promise.all(files.map(async f => [f, hash(await readFile(path.join(root, 'crates/core/src', f)))])));
  evidence.binarySha256 = hash(await readFile(path.join(root, 'target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host')));
  evidence.evaluationSha256 = await fingerprintQaStructuredEvaluation(root);
  await writeFile(path.join(logs, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(root, 'docs/memory-qa-structured-regressions.json'), JSON.stringify(evidence, null, 2));
  if (exitCode !== 0) { process.exitCode = 1; break; }
}
console.log(JSON.stringify(evidence));
