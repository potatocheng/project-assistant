import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRhythmPhase, parseRelativeDate, planCopilotAction } from '../src/components/shell/copilot-actions.ts';

const projects = [
  { id: 'p1', name: '客户服务平台一期' },
  { id: 'p2', name: '数据看板迁移' },
];

const tasks = [
  {
    id: 't1',
    projectId: 'p1',
    title: '确认页面设计稿',
    description: '',
    category: 'action',
    assignee: '我',
    priority: 'high',
    status: 'in_progress',
    progress: 60,
    dueDate: '2026-11-23',
    plannedDate: '2026-11-23',
    version: 2,
  },
  {
    id: 't2',
    projectId: 'p2',
    title: '销售日报迁移验证',
    description: '',
    category: 'action',
    assignee: '李静',
    priority: 'medium',
    status: 'todo',
    progress: 0,
    dueDate: '2026-11-24',
    plannedDate: '2026-11-23',
    version: 1,
  },
];

const date = '2026-11-23'; // Monday

test('detectRhythmPhase classifies morning, midday, and evening cleanly', () => {
  assert.equal(detectRhythmPhase(8), 'morning');
  assert.equal(detectRhythmPhase(14), 'midday');
  assert.equal(detectRhythmPhase(18), 'evening');
  assert.equal(detectRhythmPhase(2), 'evening');
});

test('parseRelativeDate resolves relative Chinese and ISO dates', () => {
  assert.equal(parseRelativeDate('明天完成', date), '2026-11-24');
  assert.equal(parseRelativeDate('后天联调', date), '2026-11-25');
  assert.equal(parseRelativeDate('周五前确认', date), '2026-11-27');
  assert.equal(parseRelativeDate('下周二上线', date), '2026-12-01');
  assert.equal(parseRelativeDate('2026-12-05交付', date), '2026-12-05');
});

test('planCopilotAction parses task rescheduling with fuzzy match', () => {
  const plan = planCopilotAction('把确认页面设计稿延到周五', { projects, tasks, currentProjectId: '', date });
  assert.ok(plan && plan.kind === 'reschedule_task');
  assert.equal(plan.task.id, 't1');
  assert.equal(plan.newDueDate, '2026-11-27');
});

test('planCopilotAction parses task creation with assignee, date, and priority', () => {
  const plan = planCopilotAction('新建任务：明天找运维开通测试账号，负责人王磊，紧急', {
    projects,
    tasks,
    currentProjectId: 'p1',
    date,
  });
  assert.ok(plan && plan.kind === 'create_task');
  assert.equal(plan.projectId, 'p1');
  assert.equal(plan.assignee, '王磊');
  assert.equal(plan.priority, 'high');
  assert.equal(plan.dueDate, '2026-11-24');
});

test('planCopilotAction parses task completion, governance risk, and daily report', () => {
  const done = planCopilotAction('完成销售日报迁移验证', { projects, tasks, currentProjectId: '', date });
  assert.ok(done && done.kind === 'complete_task' && done.task.id === 't2');

  const risk = planCopilotAction('记录风险：测试账号未开通可能阻塞联调', { projects, tasks, currentProjectId: 'p1', date });
  assert.ok(risk && risk.kind === 'create_governance' && risk.govKind === 'risk' && risk.severity === 'high');

  const report = planCopilotAction('帮我生成今天的日报', { projects, tasks, currentProjectId: '', date });
  assert.ok(report && report.kind === 'generate_report' && report.date === date);
});

test('planCopilotAction returns null for regular Q&A questions', () => {
  const plan = planCopilotAction('哪个项目最可能延期？', { projects, tasks, currentProjectId: '', date });
  assert.equal(plan, null);
});
