// Real-process persistence/backup proof, using an isolated workspace and the Rust host.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';

const project = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(project, '.local-data'), { recursive: true });
const workspace = await mkdtemp(path.join(project, '.local-data', 'restart-proof-'));
const binary = path.join(project, 'target', 'debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host');
const evidenceText = '客户确认：一期只开放账号密码登录，单点登录暂缓到二期。✅';

function startHost() {
  const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const reply = JSON.parse(line);
    const request = pending.get(reply.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.data);
    else request.reject(Object.assign(new Error(reply.error?.message), reply.error));
  });
  child.on('error', (error) => {
    for (const request of pending.values()) request.reject(error);
  });
  child.on('exit', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Rust host exited before reply.'));
    }
    pending.clear();
  });
  return {
    call(command, payload = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout: ${command}`)), 30000);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      lines.close();
    },
  };
}
async function ready(host, sourceId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await host.call('get_state');
    const source = state.sources.find((item) => item.id === sourceId);
    if (source?.status === 'failed') throw new Error(source.error);
    if (source?.status === 'ready') return host.call('get_source', { sourceId });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Import did not finish.');
}

let host = startHost();
try {
  const projectRecord = await host.call('create_project', { name: '重启验收项目', description: '隔离测试数据' });
  const imported = await host.call('import_text', {
    projectId: projectRecord.id, title: '客户范围确认', text: evidenceText, sourceAt: '2026-10-16',
  });
  const source = await ready(host, imported.sourceId);
  assert(source.segments.some((segment) => segment.text.includes('✅')));
  const proposal = await host.call('create_proposal', {
    projectId: projectRecord.id, sourceId: imported.sourceId,
    segmentIds: [source.segments[0].id], kind: 'decision', content: '一期仅支持账号密码登录，单点登录放到二期。',
  });
  const memory = await host.call('confirm_proposal', { proposalId: proposal.id });
  const repeated = await host.call('confirm_proposal', { proposalId: proposal.id });
  assert.equal(repeated.id, memory.id);
  await host.call('revise_memory', {
    memoryId: memory.id, baseRevision: 1, content: '一期仅支持账号密码登录；二期范围需另行评审。',
    reason: '本人补充：二期尚未正式排期。', segmentIds: [],
  });
  const before = await host.call('get_memory', { memoryId: memory.id });
  assert.equal(before.memory.revision, 2);
  assert.equal(before.revisions.length, 2);
  const backup = await host.call('create_backup');
  const backupBytes = await readFile(path.join(workspace, 'backups', backup.filename));

  await host.stop();
  host = startHost();
  const after = await host.call('get_memory', { memoryId: memory.id });
  assert.deepEqual(after, before, 'A new Rust process must recover the exact confirmed memory and history.');
  const restoredSource = await host.call('get_source', { sourceId: imported.sourceId });
  assert.deepEqual(restoredSource.segments, source.segments, 'Evidence must survive a process restart.');

  await host.call('revise_memory', {
    memoryId: memory.id, baseRevision: 2, content: '还原前的第三版内容', reason: '测试安全副本', segmentIds: [],
  });
  const payload = { filename: backup.filename, contentBase64: backupBytes.toString('base64') };
  const inspection = await host.call('inspect_backup', payload);
  assert.equal(inspection.compatible, true);
  const restoration = await host.call('restore_backup', { ...payload, confirmation: 'RESTORE' });
  assert(restoration.safetyBackupId, 'Restoration must retain a safety backup.');
  const restored = await host.call('get_memory', { memoryId: memory.id });
  assert.deepEqual(restored, before, 'Restore must recover both current memory and its history.');
  const state = await host.call('get_state');
  const safety = state.backups.find((item) => item.id === restoration.safetyBackupId);
  assert(safety, 'The safety backup must remain visible after restore.');
  await host.stop();
  host = startHost();
  assert.deepEqual(await host.call('get_memory', { memoryId: memory.id }), before);
  const result = {
    passed: true, workspace, projectId: projectRecord.id, sourceId: imported.sourceId,
    memoryId: memory.id, memoryRevision: 2, originalBackupId: backup.id,
    safetyBackupId: restoration.safetyBackupId,
    checks: ['中文与表情原文', '确认幂等', '修订历史', '真实进程重启', '备份校验', '还原及安全副本', '还原后再次重启'],
  };
  await writeFile(path.join(workspace, 'verification.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await host.stop();
}
