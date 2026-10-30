// Deterministic checks for this round; never overwrites previous evidence.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fingerprintRetrievalEvaluation } from './memory-retrieval-evaluation-files.mjs';
const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(path.join(root, '.local-data'), { recursive: true });
const logs = await mkdtemp(path.join(root, '.local-data/retrieval-regressions-'));
const cargo = process.platform === 'win32' ? path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo';
const node = process.execPath;
const previousDevelopment = JSON.parse(await readFile(path.join(root, 'docs/memory-public-live-optimized-dev-v2-results.json')));
const nodeTests = ['score-memory-public-live', 'memory-public-live-options', 'evaluate-memory-quality', 'check-memory-public-development',
  'report-memory-extraction-optimized', 'check-memory-retrieval-development', 'report-memory-retrieval-optimized'].map(name => `scripts/${name}.test.mjs`);
const commands = [
  [cargo, ['test', '-p', 'project-assistant-core', '--locked']],
  [cargo, ['clippy', '-p', 'project-assistant-core', '--locked', '--lib', '--tests', '--', '-D', 'warnings']],
  [cargo, ['build', '-p', 'project-assistant-core', '--bin', 'pm-host', '--locked']],
  ...(process.platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-Command', 'npm run build']]] : [['npm', ['run', 'build']]]),
  [node, ['--test', ...nodeTests]],
  [node, ['scripts/verify-restart.mjs']],
  [node, ['scripts/verify-extraction-recovery.mjs']],
  [node, ['scripts/verify-memory-public-live.mjs', '--no-write']],
  [node, ['scripts/verify-memory-public-live.mjs', 'docs/memory-public-live-optimized-dev-v2-results.json', '--no-write']],
  [node, ['scripts/verify-memory-public-live.mjs', 'docs/memory-public-live-optimized-full-results.json', '--no-write']],
  [cargo, ['test', '-p', 'project-assistant-core', '--lib', '--locked', 'diagnose_public_live_retrieval', '--', '--ignored', '--nocapture'], {
    MEMORY_PUBLIC_LIVE_REPORT: path.resolve(root, previousDevelopment.detailFile ?? 'docs/memory-public-live-optimized-dev-v2-results.json'),
    MEMORY_PUBLIC_LIVE_ROOT: root,
    MEMORY_PUBLIC_LIVE_ABLATION: path.join(logs, 'same-memory-retrieval-diagnostic.json'),
  }],
];
const evidence = { version: 'memory-retrieval-regressions-v1', startedAt: new Date().toISOString(), logs: path.relative(root, logs), passed: false, commands: [] };
for (const [program, args, env] of commands) {
  const command = `${path.basename(program)} ${args.join(' ')}`;
  console.log(`START ${command}`);
  const start = Date.now(), chunks = [];
  const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { chunks.push(b); process.stdout.write(b); });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const log = path.join(logs, `${evidence.commands.length + 1}.log`);
  await writeFile(log, Buffer.concat(chunks));
  evidence.commands.push({ command, exitCode, elapsedMs: Date.now() - start, log: path.relative(root, log) });
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = evidence.commands.length === commands.length && evidence.commands.every(c => c.exitCode === 0);
  const files = (await readdir(path.join(root, 'crates/core/src'), { recursive: true })).filter(f => f.endsWith('.rs')).sort();
  evidence.productionSha256 = Object.fromEntries(await Promise.all(files.map(async f => [f, hash(await readFile(path.join(root, 'crates/core/src', f)))])));
  evidence.binarySha256 = hash(await readFile(path.join(root, 'target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host')));
  evidence.evaluationSha256 = await fingerprintRetrievalEvaluation(root);
  evidence.sameMemoryDiagnostic = path.relative(root, path.join(logs, 'same-memory-retrieval-diagnostic.json'));
  await writeFile(path.join(logs, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(root, 'docs/memory-retrieval-optimized-regressions.json'), JSON.stringify(evidence, null, 2));
  if (exitCode !== 0) { process.exitCode = 1; break; }
}
console.log(JSON.stringify(evidence));
