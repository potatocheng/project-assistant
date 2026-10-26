import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
const fixture = path.resolve(root, manifest.fixture);
const data = await readFile(fixture);
const sha = createHash('sha256').update(data).digest('hex');
if (sha !== manifest.datasetSha256) throw new Error('Public fixture fingerprint changed; regenerate and review the manifest explicitly');
const executable = path.join(homedir(), '.cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const output = path.join(root, 'docs/memory-public-retrieval-results.json');
const started = Date.now();
const child = spawn(existsSync(executable) ? executable : 'cargo', ['test', '-p', 'project-assistant-core', '--locked', '--lib',
  'memory_evaluation::measure_public_external_evidence', '--', '--ignored', '--nocapture'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, MEMORY_PUBLIC_DATASET: fixture, MEMORY_PUBLIC_REPORT: output },
});
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
if (code !== 0) process.exit(code ?? 1);
if ((await stat(output)).mtimeMs < started) throw new Error('No fresh public evaluation output');
const report = JSON.parse(await readFile(output));
if (report.datasetSha256 !== sha) throw new Error('Evaluation fingerprint mismatch');
console.log(`Saved ${output}. Evidence retrieval only; no model requests.`);
