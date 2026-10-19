// Protocol + persistence acceptance using a deterministic HTTP fixture, NOT a real LLM.
// Real DeepSeek quality/authentication must be checked separately with a user-supplied key.
import { startFixture } from './mock-model-server.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.local-data'), { recursive: true });
const workspace = await mkdtemp(path.join(root, '.local-data', 'ai-proof-'));
const binary = path.join(root, 'target/debug/pm-host');
const fakeKey = 'qa-only-not-a-real-key-927641';
const fixture = await startFixture({ expectedApiKey: fakeKey });
function startHost() {
  const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const reply = JSON.parse(line), item = pending.get(reply.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(reply.id);
    reply.ok ? item.resolve(reply.data) : item.reject(Object.assign(new Error(reply.error.message), reply.error));
  });
  child.on('exit', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Host exited.')); }
    pending.clear();
  });
  return {
    call(command, payload = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; lines.close();
    },
  };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let host = startHost();
async function poll(predicate, label) {
  for (let i = 0; i < 400; i++) {
    const state = await host.call('get_state');
    const result = predicate(state);
    if (result) return result;
    await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function extracted(sourceId, status = 'succeeded') {
  return poll((state) => {
    const jobs = state.jobs.filter((j) => j.sourceId === sourceId && j.kind === 'extract');
    const job = jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (job?.status === 'failed' && status !== 'failed') throw new Error(`Extraction failed: ${job.errorCode} ${job.error}`);
    return job?.status === status ? job : false;
  }, `extraction ${status}`);
}
const settings = {
  provider: 'openai_compatible', baseUrl: fixture.baseUrl, model: 'qa-fixture-not-a-model',
  outputFormat: 'json_object', timeoutSeconds: 10, autoExtract: true, remoteConsent: false,
};
const checks = [];
try {
  const saved = await host.call('save_ai_settings', { ...settings, apiKey: fakeKey });
  assert.equal(saved.hasApiKey, true);
  assert(!JSON.stringify(saved).includes(fakeKey));
  assert.equal((await host.call('test_ai_connection')).ok, true);
  checks.push('saved provider auth and structured request through actual HTTP fixture');
  const project = await host.call('create_project', { name: 'AI候选闭环验收' });
  const imported = await host.call('import_text', {
    projectId: project.id, title: 'AI自动提取验收',
    text: '会议决策：一期仅上线工单查询，批量导出推迟到二期。✅\n验收必须由业务负责人确认，开发完成不代表验收完成。',
  });
  const job = await extracted(imported.sourceId);
  assert(job.candidateCount > 0);
  let state = await host.call('get_state');
  assert.equal(state.memories.length, 0, 'AI must never write formal memory by itself.');
  const candidate = state.proposals.find((p) => p.sourceId === imported.sourceId && p.origin === 'ai');
  assert(candidate && candidate.status === 'pending');
  const source = await host.call('get_source', { sourceId: imported.sourceId });
  for (const evidence of candidate.quotes) {
    const segment = source.segments.find((s) => s.id === evidence.segmentId);
    assert(segment && evidence.quote && segment.text.includes(evidence.quote));
  }
  assert.equal(candidate.extractionJobId, job.id);
  checks.push('import automatically generates pending AI candidate with exact source quotes, never formal memory');
  const edited = await host.call('update_proposal', {
    proposalId: candidate.id, kind: 'decision', content: '一期只上线工单查询，批量导出留待二期评审。',
  });
  assert.equal(edited.edited, true);
  assert.equal(edited.origin, 'ai');
  assert.deepEqual(edited.quotes, candidate.quotes);
  const memory = await host.call('confirm_proposal', { proposalId: candidate.id });
  assert.equal((await host.call('confirm_proposal', { proposalId: candidate.id })).id, memory.id);
  await assert.rejects(host.call('update_proposal', { proposalId: candidate.id, kind: 'fact', content: '不能修改已确认候选' }));
  checks.push('candidate edit preserves provenance, explicit confirmation is idempotent');
  const before = state.proposals.length;
  const repeatedRun = await host.call('start_extraction', { sourceId: imported.sourceId });
  await poll((s) => { const j = s.jobs.find((j) => j.id === repeatedRun.id); if (j?.status === 'failed') throw new Error(j.error); return j?.status === 'succeeded' ? j : false; }, 'repeated extraction');
  state = await host.call('get_state');
  assert.equal(state.proposals.length, before, 'Repeated extraction must not duplicate prior accepted/ignored candidates.');
  checks.push('repeated extraction deduplicates original AI fingerprints even after user edit');
  fixture.state.mode = 'bad-evidence';
  const bad = await host.call('import_text', { projectId: project.id, title: '不可信引用', text: '会议决定：正式记忆必须由用户确认。' });
  const failed = await extracted(bad.sourceId, 'failed');
  assert.match(failed.errorCode, /GROUND|EVIDENCE/);
  assert.equal((await host.call('get_state')).proposals.filter((p) => p.sourceId === bad.sourceId).length, 0);
  fixture.state.mode = 'normal';
  await host.call('retry_extraction', { jobId: failed.id });
  await extracted(bad.sourceId);
  checks.push('unknown evidence fails with no candidates; explicit retry succeeds');
  fixture.state.mode = 'empty';
  const empty = await host.call('import_text', { projectId: project.id, title: '无可提取事实', text: '今天闲聊，没有项目事实。' });
  assert.equal((await extracted(empty.sourceId)).candidateCount, 0);
  checks.push('valid zero-candidate output remains a successful distinct state');
  fixture.state.mode = 'slow';
  const slow = await host.call('import_text', { projectId: project.id, title: '取消提取', text: '会议决定：取消后不得写回旧候选。' });
  const running = await poll((s) => s.jobs.find((j) => j.sourceId === slow.sourceId && j.kind === 'extract' && j.status === 'running'), 'running');
  const startedAt = Date.now();
  await host.call('get_state');
  assert(Date.now() - startedAt < 400, 'HTTP must not block the database actor.');
  await host.call('cancel_extraction', { jobId: running.id });
  await pause(1100);
  state = await host.call('get_state');
  assert.equal(state.jobs.find((j) => j.id === running.id).status, 'cancelled');
  assert.equal(state.proposals.filter((p) => p.sourceId === slow.sourceId).length, 0);
  checks.push('database stays responsive during HTTP; cancelled late result cannot write back');
  fixture.state.mode = 'normal';
  const backup = await host.call('create_backup');
  const archive = await readFile(path.join(workspace, 'backups', backup.filename));
  assert(!archive.includes(Buffer.from(fakeKey)));
  const dbBytes = await readFile(path.join(workspace, 'workspace.sqlite'));
  assert(!dbBytes.includes(Buffer.from(fakeKey)));
  const secretDir = path.join(workspace, 'secrets');
  if (process.platform !== 'win32') {
    assert.equal((await stat(secretDir)).mode & 0o777, 0o700);
    for (const name of await readdir(secretDir)) assert.equal((await stat(path.join(secretDir, name))).mode & 0o777, 0o600);
  }
  await host.stop(); host = startHost();
  assert.equal((await host.call('get_ai_settings')).hasApiKey, true);
  assert.equal((await host.call('get_state')).memories.find((m) => m.id === memory.id).content, edited.content);
  checks.push('restart preserves AI provenance and formal memory; key is private and excluded from SQLite/backup');
  const v1 = await readFile(path.join(root, 'crates/core/tests/fixtures/schema-v1.zip'));
  const payload = { filename: 'schema-v1.zip', contentBase64: v1.toString('base64') };
  assert.equal((await host.call('inspect_backup', payload)).compatible, true);
  const restore = await host.call('restore_backup', { ...payload, confirmation: 'RESTORE' });
  state = await host.call('get_state');
  assert.equal(state.workspace.schemaVersion, 7);
  assert(state.backups.some((b) => b.id === restore.safetyBackupId));
  assert(state.proposals.every((p) => p.origin === 'manual'));
  assert.equal((await host.call('get_ai_settings')).hasApiKey, true);
  checks.push('real phase-one backup restores and migrates without losing current device credentials');
  const result = { passed: true, usesRealModel: false, fixture: 'deterministic OpenAI-compatible HTTP fixture', workspace, checks };
  await writeFile(path.join(workspace, 'verification.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await host.stop();
  await fixture.close();
}
