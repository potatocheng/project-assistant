// Public-API acceptance against a real Rust process, in an isolated workspace.
// No model or external service is contacted. The startup fixture changes only
// the paused setting while the host is stopped; it never changes the clock.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.local-data'), { recursive: true });
const workspace = await mkdtemp(path.join(root, '.local-data', 'proactive-proof-'));
const binary = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host');
const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate(new Date());
const previous = new Date();
previous.setDate(previous.getDate() - 1);
const yesterday = localDate(previous);
const checks = [];

function startHost() {
  const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  const fail = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  lines.on('line', (line) => {
    let reply;
    try { reply = JSON.parse(line); } catch (error) { fail(error); return; }
    const item = pending.get(reply.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(reply.id);
    if (reply.ok) item.resolve(reply.data);
    else item.reject(Object.assign(new Error(`${item.command}: ${reply.error?.message}`), { code: reply.error?.code }));
  });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Rust host exited before replying.')));
  return {
    call(command, payload = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 15000);
        pending.set(id, { resolve, reject, timer, command });
        child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
      lines.close();
    },
  };
}

let host = startHost();
const center = (projectId) => host.call('get_proactive_center', projectId ? { projectId } : {});
const actionFor = (value, taskId) => value.actions.find((item) => item.targetKind === 'task' && item.targetId === taskId);
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await center();
    const result = predicate(value);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
async function configure(enabled) {
  const current = (await center()).settings;
  return host.call('save_proactive_settings', { enabled, reviewMinutes: current.reviewMinutes, baseRevision: current.revision });
}
function createTask(projectId, title) {
  return host.call('create_task', {
    projectId, title, description: '主动跟进隔离验收', category: 'follow_up',
    assignee: '验收同事', priority: 'high', status: 'todo', progress: 0,
    dueDate: yesterday, plannedDate: null, workDate: today, clientRequestId: randomUUID(),
  });
}
function finishTask(task) {
  return host.call('update_task', {
    taskId: task.id, baseVersion: task.version, title: task.title,
    description: task.description, category: task.category, assignee: task.assignee,
    priority: task.priority, status: 'done', progress: 100,
    dueDate: task.dueDate, plannedDate: task.plannedDate,
    note: '已核对交付，结束该主动跟进', workDate: today, clientRequestId: randomUUID(),
  });
}

// A one-field stopped-workspace fixture is used solely to distinguish a startup
// scan from task-write and settings-write scans. Python's standard sqlite3 is
// available on the supported macOS development environment and CI runner.
async function enableStartupFixture() {
  const code = `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    cursor=db.execute("UPDATE proactive_settings SET enabled=1")
    assert cursor.rowcount == 1, "exactly one settings row expected"
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
`;
  const child = spawn('python3', ['-c', code, path.join(workspace, 'workspace.sqlite')], { stdio: ['ignore', 'inherit', 'inherit'] });
  const [codeResult] = await once(child, 'exit');
  assert.equal(codeResult, 0, 'The isolated startup settings fixture must be valid.');
}

try {
  const initial = await center();
  assert.equal(initial.settings.enabled, true);
  assert.equal(initial.settings.reviewMinutes, 60);
  assert.equal((await host.call('get_state')).workspace.schemaVersion, 8);
  await assert.rejects(host.call('_proactive_tick'), 'Internal timer commands must not be public.');
  await assert.rejects(host.call('save_proactive_settings', { enabled: true, reviewMinutes: 4, baseRevision: initial.settings.revision }));
  await configure(false);

  const project = await host.call('create_project', { name: '主动跟进验收' });
  const other = await host.call('create_project', { name: '项目隔离验收' });
  const startupTask = await createTask(project.id, '应用重开时发现待跟进交付');
  assert.equal(actionFor(await center(), startupTask.id), undefined, 'Disabled writes must not create actions.');
  await host.stop();
  await enableStartupFixture();
  host = startHost();
  const startupAction = await waitFor((value) => actionFor(value, startupTask.id), 'automatic startup scan');
  assert.equal(startupAction.status, 'ready');
  assert(startupAction.reason && startupAction.suggestedAction && startupAction.draft);
  assert(startupAction.evidence.length > 0, 'Actions must explain the recorded basis.');
  checks.push('enabled startup scans existing work without a renderer or manual scan');

  const eventTask = await createTask(other.id, '业务变化后自动准备跟进');
  const eventAction = await waitFor((value) => actionFor(value, eventTask.id), 'task-write triggered scan');
  assert.equal(eventAction.status, 'ready');
  const originalState = await host.call('get_state');
  const beforeRepeat = await center();
  const ids = beforeRepeat.actions.map((item) => item.id).sort();
  await host.call('run_proactive_scan');
  await host.call('run_proactive_scan');
  const repeated = await center();
  assert.deepEqual(repeated.actions.map((item) => item.id).sort(), ids, 'Repeated scans must reuse actions.');
  assert.deepEqual(repeated.actions.map((item) => [item.id, item.version]), beforeRepeat.actions.map((item) => [item.id, item.version]), 'Unchanged scans must not create new notification versions.');
  assert.deepEqual(repeated.history, beforeRepeat.history, 'Unchanged ready reviews must not duplicate action history.');
  assert.equal(repeated.actions.filter((item) => item.targetId === eventTask.id).length, 1);
  assert.deepEqual((await host.call('get_state')).tasks, originalState.tasks, 'Preparing actions must not alter tasks.');
  checks.push('task changes trigger prepared evidence and drafts; repeated scans deduplicate without changing tasks');

  const scoped = await center(project.id);
  assert(scoped.actions.length > 0);
  assert(scoped.actions.every((item) => item.projectId === project.id));
  assert(!scoped.actions.some((item) => item.targetId === eventTask.id));
  const scopedIds = new Set(scoped.actions.map((item) => item.id));
  assert(scoped.history.every((item) => scopedIds.has(item.actionId)), 'Scoped history must also remain in the project.');
  const scopedScan = await host.call('run_proactive_scan', { projectId: project.id });
  assert(scopedScan.actions.every((item) => item.projectId === project.id));
  await assert.rejects(center('missing-project'));
  checks.push('project-scoped actions, history and manual scan do not disclose other projects');

  const due = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const beforeWatch = actionFor(await center(), startupTask.id);
  await assert.rejects(host.call('update_proactive_action', { actionId: beforeWatch.id, baseVersion: beforeWatch.version, operation: 'watch', note: '已沟通', nextCheckAt: new Date(Date.now() - 1000).toISOString() }));
  const watching = await host.call('update_proactive_action', { actionId: beforeWatch.id, baseVersion: beforeWatch.version, operation: 'watch', note: '同事承诺一小时内交付，到时复查', nextCheckAt: due });
  assert.equal(watching.status, 'watching');
  assert.equal(Date.parse(watching.nextCheckAt), Date.parse(due));
  const manualRecheck = actionFor(await host.call('run_proactive_scan'), startupTask.id);
  assert.equal(manualRecheck.status, 'watching', 'Manual scanning must respect an agreed future review.');
  assert.equal(Date.parse(manualRecheck.nextCheckAt), Date.parse(due));
  assert.equal(manualRecheck.version, watching.version);
  await assert.rejects(host.call('update_proactive_action', { actionId: beforeWatch.id, baseVersion: beforeWatch.version, operation: 'dismiss', note: '过期版本不能覆盖' }));
  const beforeSnooze = actionFor(await center(), eventTask.id);
  const snoozed = await host.call('update_proactive_action', { actionId: beforeSnooze.id, baseVersion: beforeSnooze.version, operation: 'snooze', note: '等对方会议结束再处理', nextCheckAt: due });
  assert.equal(snoozed.status, 'snoozed');
  await host.stop();
  host = startHost();
  const restarted = await center();
  assert.equal(actionFor(restarted, startupTask.id).id, watching.id);
  assert.equal(actionFor(restarted, startupTask.id).status, 'watching');
  assert.equal(Date.parse(actionFor(restarted, startupTask.id).nextCheckAt), Date.parse(due));
  assert.equal(actionFor(restarted, eventTask.id).status, 'snoozed');
  assert(restarted.history.some((item) => item.actionId === watching.id && item.note.includes('一小时')));
  checks.push('watch and snooze require a future review, reject stale edits and persist with their notes across restart');

  await finishTask(startupTask);
  const resolved = await waitFor((value) => {
    const action = actionFor(value, startupTask.id);
    return action?.status === 'resolved' && action;
  }, 'completion closes watched action');
  assert.equal(resolved.id, watching.id);
  assert(resolved.outcome, 'Automatic resolution must record its outcome.');
  checks.push('confirmed completion automatically resolves the watched action before its next review');

  await configure(false);
  const pausedTask = await createTask(project.id, '巡检关闭时不生成行动');
  assert.equal(actionFor(await center(), pausedTask.id), undefined);
  assert.equal(actionFor(await host.call('run_proactive_scan'), pausedTask.id), undefined);
  await configure(true);
  await waitFor((value) => actionFor(value, pausedTask.id), 'reenabling scans accumulated work');
  checks.push('disabled automatic and manual scans remain paused; enabling immediately reevaluates accumulated work');

  const beforeBackup = await center();
  const backup = await host.call('create_backup');
  const bytes = await readFile(path.join(workspace, 'backups', backup.filename));
  const archive = { filename: backup.filename, contentBase64: bytes.toString('base64') };
  assert.equal((await host.call('inspect_backup', archive)).compatible, true);
  const restoration = await host.call('restore_backup', { ...archive, confirmation: 'RESTORE' });
  assert(restoration.safetyBackupId);
  const restored = await center();
  assert.equal(restored.settings.enabled, false, 'Restored archives must not silently resume proactive work.');
  assert.deepEqual(restored.actions.map((item) => item.id).sort(), beforeBackup.actions.map((item) => item.id).sort());
  assert.equal(actionFor(restored, startupTask.id).status, 'resolved');
  assert(restored.history.some((item) => item.id === beforeBackup.history[0].id), 'Archive restoration must retain action history.');
  const restoredTask = await createTask(project.id, '还原暂停后等待重新启用');
  assert.equal(actionFor(await center(), restoredTask.id), undefined);
  await host.stop();
  host = startHost();
  assert.equal((await center()).settings.enabled, false);
  assert.equal(actionFor(await center(), restoredTask.id), undefined);
  await configure(true);
  await waitFor((value) => actionFor(value, restoredTask.id), 'post-restore explicit reenable');
  checks.push('verified backup preserves records and history, pauses across restart, and resumes only after explicit enable');

  const beforeDismiss = actionFor(await center(), eventTask.id);
  const dismissed = await host.call('update_proactive_action', { actionId: beforeDismiss.id, baseVersion: beforeDismiss.version, operation: 'dismiss', note: '该关注由线下流程接手' });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(actionFor(await host.call('run_proactive_scan'), eventTask.id).status, 'dismissed', 'Repeated scans must respect an explicit dismissal.');
  const reopened = await host.call('update_proactive_action', { actionId: dismissed.id, baseVersion: dismissed.version, operation: 'reopen', note: '恢复由助理持续跟进' });
  assert.equal(reopened.status, 'ready');
  assert.equal(reopened.id, eventAction.id);
  checks.push('explicit dismissal remains respected and reopening reuses the same action and audit trail');

  const result = { passed: true, workspace, date: today, projectId: project.id, checks,
    timingCoverage: 'Elapsed-time review transitions are covered by Rust tests; no public clock override or long process sleep is used.' };
  await writeFile(path.join(workspace, 'verification.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await host.stop();
}
