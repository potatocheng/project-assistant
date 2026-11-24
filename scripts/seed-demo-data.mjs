// Seed a fresh, realistic PM demo workspace so you can preview「今日行动流」
// and test adding/completing/rescheduling tasks immediately.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const workspace = path.join(root, '.local-data', 'demo-today-stream');
const binary = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host');

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const offsetDay = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmt(d);
};

const today = offsetDay(0);
const yesterday = offsetDay(-1);
const twoDaysAgo = offsetDay(-2);
const inThreeDays = offsetDay(3);
const inSevenDays = offsetDay(7);

await rm(workspace, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });

const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const reply = JSON.parse(line);
  const item = pending.get(reply.id);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(reply.id);
  if (reply.ok) item.resolve(reply.data);
  else item.reject(new Error(`${item.command}: ${reply.error?.message || 'error'}`));
});

const call = (command, payload = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 15000);
  pending.set(id, { resolve, reject, timer, command });
  child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
});

try {
  // 1. Create two realistic projects
  const p1 = await call('create_project', {
    name: '客户服务平台一期',
    description: '面向客服团队的一期项目，统一客户信息查询与工单处理。',
  });
  const p2 = await call('create_project', {
    name: '数据看板迁移',
    description: '将旧版销售与运营日报迁移到新指标口径与实时看板。',
  });

  // 2. Seed diverse tasks covering every TodayStream section
  // (a) Overdue personal execution (urgent)
  await call('create_task', {
    projectId: p1.id,
    title: '确认工单列表与详情页面设计稿',
    description: '与设计负责人核对状态筛选交互与空态样式，确认后交付前端。',
    category: 'action',
    assignee: '我',
    priority: 'high',
    status: 'in_progress',
    progress: 60,
    dueDate: yesterday,
    plannedDate: yesterday,
    workDate: today,
    clientRequestId: randomUUID(),
  });

  // (b) Blocked follow-up task (triggers Attention + Proactive + Continuous Work)
  await call('create_task', {
    projectId: p1.id,
    title: '与运维王磊确认测试账号开通时间',
    description: '联调环境测试账号尚未开通，阻塞接口联调启动。',
    category: 'follow_up',
    assignee: '王磊',
    priority: 'high',
    status: 'blocked',
    progress: 20,
    dueDate: twoDaysAgo,
    plannedDate: null,
    workDate: today,
    clientRequestId: randomUUID(),
  });

  // (c) Planned for today (normal execution)
  await call('create_task', {
    projectId: p2.id,
    title: '销售日报迁移口径验证',
    description: '核对新旧看板近 7 天 GMV 与客单价数据差异。',
    category: 'action',
    assignee: '我',
    priority: 'medium',
    status: 'in_progress',
    progress: 40,
    dueDate: today,
    plannedDate: today,
    workDate: today,
    clientRequestId: randomUUID(),
  });

  // (d) Completed today (shows up in Evening Rhythm Bar completed count)
  await call('create_task', {
    projectId: p2.id,
    title: '导出历史客户数据校验脚本',
    description: '已完成字段映射校验并同步给测试。',
    category: 'action',
    assignee: '我',
    priority: 'medium',
    status: 'done',
    progress: 100,
    dueDate: today,
    plannedDate: today,
    workDate: today,
    clientRequestId: randomUUID(),
  });

  // (e) Future task (verifies future tasks do NOT clutter TodayStream)
  await call('create_task', {
    projectId: p1.id,
    title: '二期知识库权限方案评审',
    description: '下周启动评审，本周无需处理。',
    category: 'action',
    assignee: '林晨',
    priority: 'low',
    status: 'todo',
    progress: 0,
    dueDate: inSevenDays,
    plannedDate: inThreeDays,
    workDate: today,
    clientRequestId: randomUUID(),
  });

  // 3. Seed Governance Risk & Pending Decision
  await call('save_governance_item', {
    projectId: p1.id,
    kind: 'risk',
    title: '测试账号未开通可能影响联调延期 3 天',
    description: '如果明早仍未拿到测试账号，灰度上线节点将顺延。',
    owner: '王磊',
    severity: 'high',
    impact: '接口联调与 UAT 顺延',
    responsePlan: '今日下午升级至运维主管并准备备用 Mock 环境',
    dueDate: today,
    reviewDate: null,
    escalationTo: '运维主管',
    status: 'open',
    decisionMaker: '',
    conclusion: '',
    resolution: '',
    closureReason: '',
    links: [],
    evidenceIds: [],
    workDate: today,
    note: '初始演示风险',
  });

  await call('save_governance_item', {
    projectId: p1.id,
    kind: 'decision',
    title: '一期是否保留旧版工单 CSV 导出按钮',
    description: '客服主管希望保留过渡期导出，研发评估需增加 0.5 人日。',
    owner: '我',
    severity: 'medium',
    impact: '范围微调 0.5 人日',
    responsePlan: '今日评审会确认一期保留或二期支持',
    dueDate: today,
    reviewDate: null,
    escalationTo: '',
    status: 'open',
    decisionMaker: '产品负责人',
    conclusion: '',
    resolution: '',
    closureReason: '',
    links: [],
    evidenceIds: [],
    workDate: today,
    note: '待拍板演示事项',
  });

  // 4. Import a real source & create pending memory proposals for inline triage cards
  const imported = await call('import_text', {
    projectId: p1.id,
    title: '客户服务平台周例会纪要',
    text: '项目目标：一期面向客服团队，统一客户信息查询与工单处理。\n\n会议决策：一期优先上线工单列表和详情，知识库管理安排在二期。\n\n风险提醒：测试账号尚未开通，需要王磊与运维确认具体开通时间。',
  });
  const detail = await call('get_source', { sourceId: imported.sourceId });
  const seg0 = detail.segments[0]?.id;
  const seg1 = detail.segments[1]?.id ?? seg0;
  if (seg0) {
    await call('create_proposal', {
      projectId: p1.id,
      sourceId: imported.sourceId,
      segmentIds: [seg1],
      kind: 'decision',
      content: '一期优先上线工单列表和详情，知识库管理安排在二期。',
    });
  }

  // 5. Enable proactive & run scans so AI Proactive + Continuous Work cards appear immediately
  const proactive = await call('get_proactive_center', {});
  await call('save_proactive_settings', {
    enabled: true,
    reviewMinutes: proactive.settings.reviewMinutes || 60,
    baseRevision: proactive.settings.revision,
  });
  await call('run_proactive_scan', {});
  await call('run_assistant_work', {});

  console.log(JSON.stringify({
    ok: true,
    workspace,
    today,
    projects: [p1.name, p2.name],
  }, null, 2));
} finally {
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await ended;
  lines.close();
}
