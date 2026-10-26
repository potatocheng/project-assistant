// Deterministic acceptance evidence, recorded before any paid development run.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.local-data'), { recursive: true });
const logs = await mkdtemp(path.join(root, '.local-data/extraction-regressions-'));
const cargo = process.platform === 'win32' ? path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo';
const node = process.execPath;
const commands = [
  [cargo, ['test', '-p', 'project-assistant-core', '--locked']],
  [cargo, ['clippy', '-p', 'project-assistant-core', '--locked', '--lib', '--tests', '--', '-D', 'warnings']],
  [cargo, ['build', '-p', 'project-assistant-core', '--bin', 'pm-host', '--locked']],
  ...(process.platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-Command', 'npm run build']]] : [['npm', ['run', 'build']]]),
  [node, ['--test', 'scripts/score-memory-public-live.test.mjs', 'scripts/memory-public-live-options.test.mjs', 'scripts/evaluate-memory-quality.test.mjs', 'scripts/check-memory-public-development.test.mjs', 'scripts/report-memory-extraction-optimized.test.mjs']],
  [node, ['scripts/verify-restart.mjs']],
  [node, ['scripts/verify-extraction-recovery.mjs']],
  [node, ['scripts/verify-memory-public-live.mjs', '--no-write']],
  [cargo, ['test', '-p', 'project-assistant-core', '--lib', '--locked', 'replay_public_live_extraction_v5', '--', '--ignored', '--nocapture'], {
    MEMORY_PUBLIC_REPLAY_RECEIPTS: path.join(root, '.local-data/public-memory-live-11wyk8/receipts.jsonl'),
    MEMORY_PUBLIC_REPLAY_BASELINE: path.join(root, 'docs/memory-public-live-extraction-diagnostics.json'),
    MEMORY_PUBLIC_REPLAY_OUTPUT: path.join(root, 'docs/memory-public-live-optimized-offline-replay.json'),
  }],
];
const evidence = { version: 'extraction-optimized-regressions-v1', startedAt: new Date().toISOString(), logs: path.relative(root, logs), passed: false, commands: [] };
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
  await writeFile(path.join(root, 'docs/memory-extraction-optimized-regressions.json'), JSON.stringify(evidence, null, 2));
  if (exitCode !== 0) { process.exitCode = 1; break; }
}
console.log(JSON.stringify(evidence));
