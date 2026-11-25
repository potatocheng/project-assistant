import { execute } from '../../api';
import type { AppState, ImportResult, Project, SourceDetail, Task } from '../../types';

const DEMO_STORAGE_PREFIX = 'pa:demo-project-ids';
export const DEMO_STORAGE_KEY = DEMO_STORAGE_PREFIX;

function demoStorageKey(workspaceKey?: string): string {
  return workspaceKey ? `${DEMO_STORAGE_PREFIX}:${workspaceKey}` : DEMO_STORAGE_PREFIX;
}

function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function offsetDay(days: number, baseYmd?: string): string {
  const base = baseYmd ? new Date(`${baseYmd}T12:00:00`) : new Date();
  base.setDate(base.getDate() + days);
  return formatYmd(base);
}

export function getStoredDemoProjectIds(workspaceKey?: string): string[] {
  try {
    const raw = localStorage.getItem(demoStorageKey(workspaceKey))
      ?? (workspaceKey ? null : localStorage.getItem(DEMO_STORAGE_PREFIX));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function storeDemoProjectIds(ids: string[], workspaceKey?: string): void {
  try {
    const key = demoStorageKey(workspaceKey);
    if (ids.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(ids));
    }
  } catch {
    // Ignore storage quota issues.
  }
}

export function getDemoProjectIds(state: AppState): string[] {
  const workspaceKey = state.workspace?.dataDir;
  const stored = getStoredDemoProjectIds(workspaceKey);
  if (!stored.length) return [];
  const activeIds = new Set(state.projects.map(p => p.id));
  return stored.filter(id => activeIds.has(id));
}

async function waitForSourceSegments(sourceId: string): Promise<SourceDetail | null> {
  for (let i = 0; i < 15; i++) {
    try {
      const detail = await execute<SourceDetail>('get_source', { sourceId });
      if (detail.source.status === 'ready' && detail.segments.length > 0) {
        return detail;
      }
      if (detail.source.status === 'failed') return null;
    } catch {
      return null;
    }
    await new Promise(resolve => window.setTimeout(resolve, 120));
  }
  return null;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  goal: string;
  targetOffsetDays: number;
  milestones: Array<{
    title: string;
    description: string;
    baselineOffset: number;
    forecastOffset: number;
    status: 'planned' | 'in_progress';
  }>;
  tasks: Array<{
    title: string;
    description: string;
    category: 'action' | 'follow_up';
    assignee: string;
    priority: 'high' | 'medium' | 'low';
    status: 'todo' | 'in_progress';
    progress: number;
    plannedOffset: number | null;
    dueOffset: number;
    milestoneIndex?: number;
  }>;
  risk?: {
    title: string;
    description: string;
    impact: string;
    responsePlan: string;
    severity: 'high' | 'medium';
    dueOffset: number;
  };
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'software-release',
    name: '互联网版本交付',
    tagline: '需求冻结 → 联调测试 → 灰度上线',
    description: '适用于 App / Web 功能版本从评审、研发联调到灰度发布的全流程跟踪。',
    goal: '按期完成核心功能开发、集成测试与灰度放量，线上零 P0 故障稳定运行。',
    targetOffsetDays: 21,
    milestones: [
      { title: '需求与设计评审冻结', description: '确认 PRD、UI 稿与接口契约，无未决范围变更。', baselineOffset: 3, forecastOffset: 3, status: 'in_progress' },
      { title: '提测与集成联调完成', description: '主流程自动化与核心场景自测通过，进入 QA 验收。', baselineOffset: 12, forecastOffset: 13, status: 'planned' },
      { title: '灰度放量与全量上线', description: '完成 10%→100% 放量监控，发布公告与复盘。', baselineOffset: 21, forecastOffset: 21, status: 'planned' },
    ],
    tasks: [
      { title: '组织 PRD 与接口契约终审会', description: '对齐前后端字段定义与异常兜底逻辑。', category: 'action', assignee: '我', priority: 'high', status: 'in_progress', progress: 40, plannedOffset: 0, dueOffset: 1, milestoneIndex: 0 },
      { title: '跟进设计交付全量交互终稿', description: '重点核对空态、异常提示与移动端适配。', category: 'follow_up', assignee: '设计负责人', priority: 'high', status: 'todo', progress: 0, plannedOffset: 1, dueOffset: 3, milestoneIndex: 0 },
      { title: '协调测试账号与联调沙箱环境', description: '避免进入联调期因权限和环境阻塞进度。', category: 'follow_up', assignee: '运维/测试', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 4, dueOffset: 7, milestoneIndex: 1 },
      { title: '制定灰度发布检查清单与回滚预案', description: '明确监控指标、值班人与回滚触发条件。', category: 'action', assignee: '我', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 15, dueOffset: 19, milestoneIndex: 2 },
    ],
    risk: {
      title: '跨团队接口排期不对齐可能导致联调延期',
      description: '上游依赖服务尚未锁定提测日期。',
      impact: '提测与全量上线整体顺延 2-3 天',
      responsePlan: '在里程碑 1 冻结时同步锁定上游 Mock 与真实联调时间窗口。',
      severity: 'medium',
      dueOffset: 5,
    },
  },
  {
    id: 'client-delivery',
    name: '乙方客户实施交付',
    tagline: '蓝图确认 → 驻场部署 → UAT 终验',
    description: '适用于 ToB 项目实施、定制开发、客户培训与验收回款节点把控。',
    goal: '完成客户现场环境部署、UAT 签字验收与运维移交，确保合同节点按期达标。',
    targetOffsetDays: 28,
    milestones: [
      { title: '需求蓝图与实施方案签字', description: '双方确认业务范围、数据迁移边界与验收标准。', baselineOffset: 5, forecastOffset: 5, status: 'in_progress' },
      { title: '测试环境部署与 UAT 启动', description: '完成客户内网部署及核心用户培训，开启 UAT。', baselineOffset: 16, forecastOffset: 18, status: 'planned' },
      { title: '客户终验报告签署', description: '清零遗留问题并取得客户正式验收签章。', baselineOffset: 28, forecastOffset: 28, status: 'planned' },
    ],
    tasks: [
      { title: '输出《实施方案与范围边界确认单》', description: '明确一期范围与二期需求边界，防止范围蔓延。', category: 'action', assignee: '我', priority: 'high', status: 'in_progress', progress: 50, plannedOffset: 0, dueOffset: 1, milestoneIndex: 0 },
      { title: '跟进客户侧提供内网服务器与防火墙开通', description: '需要客户 IT 审批端口与堡垒机账号。', category: 'follow_up', assignee: '客户 IT 对接人', priority: 'high', status: 'todo', progress: 0, plannedOffset: 2, dueOffset: 6, milestoneIndex: 1 },
      { title: '整理历史数据清洗与迁移核对表', description: '请客户业务方签字确认字段映射口径。', category: 'follow_up', assignee: '客户业务负责人', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 8, dueOffset: 14, milestoneIndex: 1 },
      { title: '准备 UAT 验收测试用例与培训手册', description: '提前 3 天发给关键用户预习。', category: 'action', assignee: '我', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 18, dueOffset: 25, milestoneIndex: 2 },
    ],
    risk: {
      title: '客户内网审批周期长可能延误部署进场',
      description: '客户侧安全审计通常需 5 个工作日以上。',
      impact: 'UAT 启动顺延，影响季度验收节点',
      responsePlan: '提前发送服务器清单与端口说明，每周例会同步客户 PM 催办进度。',
      severity: 'high',
      dueOffset: 4,
    },
  },
  {
    id: 'agile-sprint',
    name: '敏捷双周迭代',
    tagline: 'Sprint 规划 → 每日卡点清理 → 演示复盘',
    description: '适用于研发团队 2 周一个 Sprint 的高频节奏管理与阻塞清理。',
    goal: '高质量交付本 Sprint 承诺的用户故事，保持燃尽节奏与线上零严重缺陷。',
    targetOffsetDays: 14,
    milestones: [
      { title: 'Sprint 中期集成检查点', description: '完成 60% 核心 Story 开发并合入主干自测。', baselineOffset: 7, forecastOffset: 7, status: 'in_progress' },
      { title: 'Sprint Demo 与回顾会', description: '向产品与业务方演示可运行增量，输出改进项。', baselineOffset: 14, forecastOffset: 14, status: 'planned' },
    ],
    tasks: [
      { title: '核对本 Sprint Story 估时与分工认领', description: '确认每人负载不超标，识别跨端依赖。', category: 'action', assignee: '我', priority: 'high', status: 'in_progress', progress: 70, plannedOffset: 0, dueOffset: 1, milestoneIndex: 0 },
      { title: '跟进研发完成核心 API 单元测试覆盖', description: '确保提测质量不拖慢后半程回归。', category: 'follow_up', assignee: '后端负责人', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 3, dueOffset: 6, milestoneIndex: 0 },
      { title: '组织 Sprint Review 演示脚本与环境准备', description: '提前准备演示账号与测试数据。', category: 'action', assignee: '我', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 11, dueOffset: 13, milestoneIndex: 1 },
    ],
  },
  {
    id: 'campaign-launch',
    name: '市场 / 运营活动筹备',
    tagline: '方案定稿 → 物料与渠道就绪 → 活动复盘',
    description: '适用于大促、发布会、跨部门品牌活动的多方物料与投放排期管理。',
    goal: '按时上线活动主会场与全部投放物料，达成既定拉新与转化目标。',
    targetOffsetDays: 18,
    milestones: [
      { title: '活动方案与预算审批通过', description: '确定玩法机制、奖池预算与法务合规审核。', baselineOffset: 4, forecastOffset: 4, status: 'in_progress' },
      { title: '全渠道物料与页面测试完成', description: 'H5、海报、推文、客服口径全部就绪。', baselineOffset: 14, forecastOffset: 15, status: 'planned' },
      { title: '活动正式上线与首日监控', description: '全量开闸并实时盯盘转化与异常工单。', baselineOffset: 18, forecastOffset: 18, status: 'planned' },
    ],
    tasks: [
      { title: '确认活动主方案、预算上限与上线时间表', description: '对齐活动玩法、目标指标与关键里程碑节点，锁定责任人。', category: 'action', assignee: '我', priority: 'high', status: 'in_progress', progress: 35, plannedOffset: 0, dueOffset: 1, milestoneIndex: 0 },
      { title: '提交活动规则法务与财务合规审核', description: '确保抽奖/优惠规则无合规风险。', category: 'follow_up', assignee: '法务/财务', priority: 'high', status: 'in_progress', progress: 30, plannedOffset: 0, dueOffset: 3, milestoneIndex: 0 },
      { title: '跟进设计输出主视觉 KV 与裂变海报', description: '需同步交付公众号头图、社群长图与小红书封面。', category: 'follow_up', assignee: '视觉设计', priority: 'high', status: 'todo', progress: 0, plannedOffset: 5, dueOffset: 10, milestoneIndex: 1 },
      { title: '组织客服团队同步活动 FAQ 与客诉预案', description: '避免活动上线后客诉响应口径不一致。', category: 'action', assignee: '我', priority: 'medium', status: 'todo', progress: 0, plannedOffset: 13, dueOffset: 16, milestoneIndex: 2 },
    ],
  },
];

export async function applyProjectTemplate(projectId: string, templateId: string, baseYmd?: string): Promise<void> {
  const tpl = PROJECT_TEMPLATES.find(t => t.id === templateId);
  if (!tpl) return;
  const today = baseYmd || formatYmd(new Date());

  await execute('save_project_profile', {
    projectId,
    goal: tpl.goal,
    status: 'active',
    targetDate: offsetDay(tpl.targetOffsetDays, today),
    baseVersion: 0,
  });

  const milestoneTaskMap = new Map<number, string[]>();
  for (const item of tpl.tasks) {
    const created = await execute<Task>('create_task', {
      projectId,
      title: item.title,
      description: item.description,
      category: item.category,
      assignee: item.assignee,
      priority: item.priority,
      status: item.status,
      progress: item.progress,
      plannedDate: item.plannedOffset !== null ? offsetDay(item.plannedOffset, today) : null,
      dueDate: offsetDay(item.dueOffset, today),
      workDate: today,
      clientRequestId: crypto.randomUUID(),
    });
    if (item.milestoneIndex !== undefined) {
      const list = milestoneTaskMap.get(item.milestoneIndex) ?? [];
      list.push(created.id);
      milestoneTaskMap.set(item.milestoneIndex, list);
    }
  }

  for (let i = 0; i < tpl.milestones.length; i++) {
    const m = tpl.milestones[i];
    await execute('save_milestone', {
      projectId,
      title: m.title,
      description: m.description,
      status: m.status,
      baselineDate: offsetDay(m.baselineOffset, today),
      forecastDate: offsetDay(m.forecastOffset, today),
      taskIds: milestoneTaskMap.get(i) ?? [],
    });
  }

  if (tpl.risk) {
    await execute('save_governance_item', {
      projectId,
      kind: 'risk',
      title: tpl.risk.title,
      description: tpl.risk.description,
      owner: '我',
      severity: tpl.risk.severity,
      impact: tpl.risk.impact,
      responsePlan: tpl.risk.responsePlan,
      dueDate: offsetDay(tpl.risk.dueOffset, today),
      reviewDate: null,
      escalationTo: '',
      status: 'open',
      decisionMaker: '',
      conclusion: '',
      resolution: '',
      closureReason: '',
      links: [],
      evidenceIds: [],
      workDate: today,
      note: `来自模板「${tpl.name}」初始风险`,
    });
  }
}

export async function seedDemoWorkspace(workspaceKey?: string): Promise<string> {
  const today = formatYmd(new Date());
  const yesterday = offsetDay(-1, today);
  const twoDaysAgo = offsetDay(-2, today);
  const threeDaysAgo = offsetDay(-3, today);
  const inTwoDays = offsetDay(2, today);
  const inFourDays = offsetDay(4, today);
  const inSevenDays = offsetDay(7, today);
  const inFourteenDays = offsetDay(14, today);

  const p1 = await execute<Project>('create_project', {
    name: '客户服务平台一期（示例）',
    description: '面向客服团队的一期交付项目，统一客户信息查询与工单流转。',
  });
  const p2 = await execute<Project>('create_project', {
    name: '数据看板迁移（示例）',
    description: '将旧版销售与运营日报迁移到新指标口径与实时看板。',
  });

  storeDemoProjectIds([p1.id, p2.id], workspaceKey);

  await execute('save_project_profile', {
    projectId: p1.id,
    goal: '一期完成工单列表、详情处理与客服工作台联调，保障客服团队按期灰度上线。',
    status: 'active',
    targetDate: inFourteenDays,
    baseVersion: 0,
  });
  await execute('save_project_profile', {
    projectId: p2.id,
    goal: '完成核心 GMV 与客单价指标双跑校验，下线旧版手工日报脚本。',
    status: 'active',
    targetDate: inSevenDays,
    baseVersion: 0,
  });

  const t1 = await execute<Task>('create_task', {
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
    clientRequestId: crypto.randomUUID(),
  });
  const t2 = await execute<Task>('create_task', {
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
    clientRequestId: crypto.randomUUID(),
  });
  const t3 = await execute<Task>('create_task', {
    projectId: p2.id,
    title: '销售日报迁移口径验证',
    description: '核对新旧看板近 7 天 GMV 与客单价数据差异。',
    category: 'action',
    assignee: '我',
    priority: 'medium',
    status: 'in_progress',
    progress: 45,
    dueDate: today,
    plannedDate: today,
    workDate: today,
    clientRequestId: crypto.randomUUID(),
  });
  const t4 = await execute<Task>('create_task', {
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
    clientRequestId: crypto.randomUUID(),
  });
  const t5 = await execute<Task>('create_task', {
    projectId: p1.id,
    title: '评审灰度发布检查清单与回滚预案',
    description: '确认值班表、核心告警阈值和紧急回滚脚本。',
    category: 'action',
    assignee: '我',
    priority: 'medium',
    status: 'todo',
    progress: 0,
    dueDate: inFourDays,
    plannedDate: inTwoDays,
    workDate: today,
    clientRequestId: crypto.randomUUID(),
  });
  const t6 = await execute<Task>('create_task', {
    projectId: p1.id,
    title: '二期知识库权限方案预研',
    description: '下周启动评审，本周无需处理。',
    category: 'action',
    assignee: '林晨',
    priority: 'low',
    status: 'todo',
    progress: 0,
    dueDate: inSevenDays,
    plannedDate: inFourDays,
    workDate: today,
    clientRequestId: crypto.randomUUID(),
  });

  await execute('save_milestone', {
    projectId: p1.id,
    title: 'M1 · 设计定稿与测试环境就绪',
    description: 'UI 终稿交付开发且联调测试账号开通可用。',
    status: 'in_progress',
    baselineDate: yesterday,
    forecastDate: inTwoDays,
    taskIds: [t1.id, t2.id],
  });
  await execute('save_milestone', {
    projectId: p1.id,
    title: 'M2 · 灰度发布上线',
    description: '客服一组 10% 灰度验证通过，无 P0/P1 缺陷。',
    status: 'planned',
    baselineDate: inSevenDays,
    forecastDate: inSevenDays,
    taskIds: [t5.id, t6.id],
  });
  await execute('save_milestone', {
    projectId: p2.id,
    title: 'M1 · 指标口径双跑一致性验收',
    description: '连续 7 天差异率小于 0.1%。',
    status: 'in_progress',
    baselineDate: threeDaysAgo,
    forecastDate: inTwoDays,
    taskIds: [t3.id, t4.id],
  });

  await execute('save_governance_item', {
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
    note: '示例演示风险',
  });
  await execute('save_governance_item', {
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
    note: '示例待拍板决策',
  });

  const imported = await execute<ImportResult>('import_text', {
    projectId: p1.id,
    title: '客户服务平台周例会纪要（示例）',
    text: '项目目标：一期面向客服团队，统一客户信息查询与工单处理。\n\n会议决策：一期优先上线工单列表和详情，知识库管理安排在二期。\n\n风险提醒：测试账号尚未开通，需要王磊与运维确认具体开通时间。',
  });
  const detail = await waitForSourceSegments(imported.sourceId);
  if (detail && detail.segments.length > 0) {
    const seg1 = detail.segments[1]?.id ?? detail.segments[0].id;
    await execute('create_proposal', {
      projectId: p1.id,
      sourceId: imported.sourceId,
      segmentIds: [seg1],
      kind: 'decision',
      content: '一期优先上线工单列表和详情，知识库管理安排在二期。',
    });
  }

  await execute('generate_daily_report', {
    date: today,
    clientRequestId: crypto.randomUUID(),
  }).catch(() => undefined);

  try {
    const proactive = await execute<{ settings: { reviewMinutes: number; revision: number } }>('get_proactive_center', {});
    await execute('save_proactive_settings', {
      enabled: true,
      reviewMinutes: proactive.settings.reviewMinutes || 60,
      baseRevision: proactive.settings.revision,
    });
    await execute('run_proactive_scan', {});
    await execute('run_assistant_work', {});
  } catch {
    // Proactive scan failure should never block demo onboarding.
  }

  return p1.id;
}

export interface ArchiveDemoResult {
  archived: number;
  skippedRunning: number;
  archivedIds: string[];
}

export async function archiveDemoProjects(state: AppState): Promise<ArchiveDemoResult> {
  const workspaceKey = state.workspace?.dataDir;
  const demoIds = getDemoProjectIds(state);
  const archivedIds: string[] = [];
  const keptIds: string[] = [];
  let skippedRunning = 0;

  for (const id of demoIds) {
    const impact = await execute<{
      kind: 'project';
      id: string;
      title: string;
      memories: number;
      runningJobs: number;
      version: number;
      fingerprint: string;
    }>('lifecycle_impact', { kind: 'project', id });
    if (impact.runningJobs > 0) {
      skippedRunning++;
      keptIds.push(id);
      continue;
    }
    await execute('set_lifecycle', {
      ...impact,
      archived: true,
      replacementId: null,
      reason: '结束示例体验，归档示例项目并开始正式项目',
    });
    archivedIds.push(id);
  }
  storeDemoProjectIds(keptIds, workspaceKey);
  if (workspaceKey && keptIds.length === 0) {
    storeDemoProjectIds([], undefined);
  }
  return { archived: archivedIds.length, skippedRunning, archivedIds };
}
