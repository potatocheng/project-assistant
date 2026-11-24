import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, ArrowUp, Check, CheckCircle2, ChevronRight, CircleAlert, FilePlus2,
  Plus, RefreshCw, Sparkles, Zap,
} from 'lucide-react';
import type { AppState, ManagementKind, Page, Task } from '../../types';
import { TASK_STATUS } from '../../types';
import { Dialog, Spinner } from '../ui';
import { TaskCoach } from '../coach/TaskCoach';
import { useDeliveryQuery } from '../delivery/shared';
import type { DeliveryOverviewData, FollowUpCenterData } from '../delivery/types';
import type { GovernanceWorkspaceData } from '../governance/gov-types';
import type { ChangeData } from '../governance/change-types';
import { collectAttention, collectTodayWork, nextMilestone, projectOrder, type AttentionItem } from '../workbench-model';
import { pendingContent, projectHealth } from '../workspace-model';
import { TodayBrief } from '../assistance/TodayBrief';
import type { ProactiveCenterData } from '../proactive/types';
import type { AssistantWorkData } from '../proactive/work-types';
import { asError, execute } from '../../api';
import {
  InlineMemoryProposalCard,
  InlineTaskProposalCard,
  ProactiveOneClickCard,
  WorkOneClickCard,
} from './ActionExecutionCard';
import { WorkRhythmBar } from './WorkRhythmBar';
import { archiveDemoProjects, getDemoProjectIds } from './demo-seed';

type StreamFilter = 'all' | 'work' | 'attention' | 'proactive' | 'pending';

interface MaintenanceData {
  settings: { enabled: boolean; idleSeconds: number; dailyCalls: number; autoNew: boolean };
  callsToday: number;
  blockedReason?: string | null;
}

interface Props {
  state: AppState;
  date: string;
  projectId: string;
  pendingCount: number;
  onProjectChange: (id: string) => void;
  onNavigate: (page: Page) => void;
  onProjectOpen: (id: string) => void;
  onTaskOpen: (id: string, projectId: string) => void;
  onManagementOpen: (kind: ManagementKind, id: string, projectId: string) => void;
  onSourceOpen: (id: string) => void;
  onAskCopilot: (question: string) => void;
  onChanged: () => Promise<unknown>;
  onCreateTask: () => void;
  onImport: () => void;
  onModelSettings: () => void;
  onOpenFeishu: () => void;
  onConnect: () => void;
  onReview: () => void;
  notify: (message: string, error?: boolean) => void;
}

const INTENT_LABEL = {
  action: '待推进',
  followup: '需跟进',
  decision: '待你拍板',
  risk: '需协调风险',
};

function dayLabel(value: string | null, today: string) {
  if (!value) return '日期待明确';
  if (value === today) return '今天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

export function TodayStream(props: Props) {
  const { state, date, projectId } = props;
  const delivery = useDeliveryQuery<DeliveryOverviewData>('get_delivery_overview', date, projectId, state, true);
  const followUps = useDeliveryQuery<FollowUpCenterData>('get_follow_up_center', date, projectId, state, true);
  const governance = useDeliveryQuery<GovernanceWorkspaceData>('get_governance_workspace', date, projectId, state, true);
  const changes = useDeliveryQuery<ChangeData>('get_change_acceptance', date, projectId, state, true);

  const [proactiveData, setProactiveData] = useState<ProactiveCenterData | null>(null);
  const [workData, setWorkData] = useState<AssistantWorkData | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceData | null>(null);
  const [streamTick, setStreamTick] = useState(0);
  const [filter, setFilter] = useState<StreamFilter>('all');
  const [coachTask, setCoachTask] = useState<Task | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newDueDate, setNewDueDate] = useState(date);
  const [newPriority, setNewPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [newAssignee, setNewAssignee] = useState('我');
  const [creatingTask, setCreatingTask] = useState(false);
  const [question, setQuestion] = useState('');
  const [busyTaskId, setBusyTaskId] = useState('');
  const [busyAuto, setBusyAuto] = useState(false);
  const [archivingDemo, setArchivingDemo] = useState(false);
  const demoProjectIds = useMemo(() => getDemoProjectIds(state), [state]);

  const reloadProactive = useCallback(async () => {
    setStreamTick(v => v + 1);
    await props.onChanged();
    followUps.refresh();
  }, [props.onChanged, followUps.refresh]);

  useEffect(() => {
    let active = true;
    const payload = projectId ? { projectId } : {};
    void Promise.allSettled([
      execute<ProactiveCenterData>('get_proactive_center', payload),
      execute<AssistantWorkData>('get_assistant_work', payload),
      execute<MaintenanceData>('get_memory_maintenance'),
    ]).then(([proactiveRes, workRes, maintRes]) => {
      if (!active) return;
      if (proactiveRes.status === 'fulfilled') setProactiveData(proactiveRes.value);
      if (workRes.status === 'fulfilled') setWorkData(workRes.value);
      if (maintRes.status === 'fulfilled') setMaintenance(maintRes.value);
    });
    return () => { active = false; };
  }, [projectId, state.workspace.revision, streamTick]);

  const activeProjects = useMemo(() => new Set(state.projects.map(p => p.id)), [state.projects]);
  const inScope = (id: string) => activeProjects.has(id) && (!projectId || id === projectId);
  const tasks = state.tasks.filter(t => inScope(t.projectId));
  const today = collectTodayWork(tasks, date, projectId);
  const todayIds = new Set(today.map(item => item.task.id));
  const attention = collectAttention({
    tasks,
    followUps: followUps.data?.items ?? [],
    governance: (governance.data?.items ?? []).filter(item => inScope(item.projectId)),
    changes: (changes.data?.changes ?? []).filter(item => inScope(item.projectId)),
    deliverables: (changes.data?.deliverables ?? []).filter(item => inScope(item.projectId)),
    date,
    projectId,
  }).filter(item =>
    !item.task || item.task.category === 'follow_up'
    || (!todayIds.has(item.id) && (item.task.status === 'blocked' || !!item.followUp))
  );

  const readyWorks = useMemo(
    () => (workData?.works ?? []).filter(w => w.status === 'ready').slice(0, 4),
    [workData]
  );
  const readyWorkTargets = useMemo(() => new Set(readyWorks.map(w => w.targetId)), [readyWorks]);
  const readyProactive = useMemo(
    () => (proactiveData?.actions ?? []).filter(a => a.status === 'ready' && !readyWorkTargets.has(a.targetId)).slice(0, 4),
    [proactiveData, readyWorkTargets]
  );
  const proactiveTotal = readyWorks.length + readyProactive.length;

  const projects = [...(delivery.data?.projects ?? [])]
    .filter(p => inScope(p.projectId))
    .sort((a, b) => projectOrder(a) - projectOrder(b) || a.name.localeCompare(b.name, 'zh-CN'));
  const riskProjects = projects.filter(p => projectOrder(p) < 2);
  const pending = pendingContent(state, projectId);

  const projectName = (id: string) => state.projects.find(p => p.id === id)?.name || '项目';
  const openAttention = (item: AttentionItem) => {
    if (item.followUp) setCoachTask(item.followUp.task);
    else if (item.kind === 'task') props.onTaskOpen(item.id, item.projectId);
    else props.onManagementOpen(item.kind, item.id, item.projectId);
  };

  const openQuickCreate = () => {
    setNewTitle('');
    setNewProjectId(projectId || state.projects[0]?.id || '');
    setNewDueDate(date);
    setNewPriority('medium');
    setNewAssignee('我');
    setQuickCreateOpen(true);
  };

  const submitQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingTask || !newTitle.trim() || !newProjectId) return;
    setCreatingTask(true);
    try {
      await execute('create_task', {
        projectId: newProjectId,
        title: newTitle.trim(),
        description: '',
        category: 'action',
        assignee: newAssignee.trim(),
        priority: newPriority,
        status: 'todo',
        progress: 0,
        dueDate: newDueDate || null,
        plannedDate: date,
        workDate: date,
        clientRequestId: crypto.randomUUID(),
      });
      setQuickCreateOpen(false);
      setFilter('all');
      await reloadProactive();
      props.notify(`已添加今日任务「${newTitle.trim()}」。`);
    } catch (caught) {
      props.notify(asError(caught).message, true);
    } finally {
      setCreatingTask(false);
    }
  };

  const quickCompleteTask = async (task: Task) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      await execute('update_task', {
        taskId: task.id,
        baseVersion: task.version,
        title: task.title,
        description: task.description,
        category: task.category,
        assignee: task.assignee,
        priority: task.priority,
        status: 'done',
        progress: 100,
        dueDate: task.dueDate,
        plannedDate: task.plannedDate,
        note: '在今日行动流一键标记完成',
      });
      await reloadProactive();
      props.notify(`已完成「${task.title}」。`);
    } catch (caught) {
      props.notify(asError(caught).message, true);
    } finally {
      setBusyTaskId('');
    }
  };

  const enableSilentAutoOrganize = async () => {
    if (busyAuto || !maintenance) return;
    setBusyAuto(true);
    try {
      const next = await execute<MaintenanceData['settings']>('save_memory_maintenance', {
        ...maintenance.settings,
        enabled: true,
        autoNew: true,
      });
      setMaintenance(prev => prev ? { ...prev, settings: next } : prev);
      props.notify('已开启静默自动整理：常规新事实将自动入库，仅冲突与风险推到首页。');
    } catch (caught) {
      props.notify(asError(caught).message, true);
    } finally {
      setBusyAuto(false);
    }
  };

  const runAutoOrganizeNow = async () => {
    if (busyAuto) return;
    setBusyAuto(true);
    try {
      await execute('run_memory_maintenance');
      props.notify('已触发后台自动整理，结果将静默同步到工作区。');
    } catch (caught) {
      props.notify(asError(caught).message, true);
    } finally {
      setBusyAuto(false);
    }
  };

  const doneTodayCount = useMemo(
    () => tasks.filter(t => t.status === 'done' && (t.updatedAt?.startsWith(date) || t.plannedDate === date)).length,
    [tasks, date]
  );

  const formattedDate = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(`${date}T12:00:00`));

  const showWork = filter === 'all' || filter === 'work';
  const showAttention = filter === 'all' || filter === 'attention';
  const showProactive = filter === 'all' || filter === 'proactive';
  const showPending = filter === 'all' || filter === 'pending';

  const inlineTaskProposals = pending.tasks.slice(0, 3);
  const inlineMemoryProposals = pending.memories.slice(0, 2);
  const remainingPending = Math.max(0, props.pendingCount - inlineTaskProposals.length - inlineMemoryProposals.length);

  const hasAnyItem =
    (showWork && today.length > 0) ||
    (showAttention && attention.length > 0) ||
    (showProactive && proactiveTotal > 0) ||
    (showPending && props.pendingCount > 0);

  const silentEnabled = !!maintenance?.settings.enabled && !!maintenance?.settings.autoNew;

  return (
    <div className="today-stream">
      <div className="today-stream-scroll">
        <div className="today-stream-inner">
          <header className="today-header">
            <div>
              <p className="today-header-date">{formattedDate}</p>
              <h1>今日行动流</h1>
            </div>
            <div className="today-header-controls">
              <select
                aria-label="项目范围"
                className="today-scope-select"
                value={projectId}
                onChange={e => props.onProjectChange(e.target.value)}
              >
                <option value="">全部项目</option>
                {state.projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button className="button secondary compact" onClick={props.onImport}>
                <FilePlus2 size={14} />
                导入资料
              </button>
              <button className="button primary compact" onClick={openQuickCreate}>
                <Plus size={14} />
                新建任务
              </button>
            </div>
          </header>

          {/* Demo workspace banner */}
          {demoProjectIds.length > 0 && (
            <div className="demo-workspace-banner" role="region" aria-label="示例模式提示">
              <div>
                <strong>正在体验完整示例工作区（{demoProjectIds.length} 个示例项目）</strong>
                <span>你可以随意点击「完成 / 帮我推进 / 一键日报」体验全部流程，随时可一键归档示例开始正式项目。</span>
              </div>
              <button
                type="button"
                className="button secondary compact"
                disabled={archivingDemo}
                onClick={() => {
                  setArchivingDemo(true);
                  void archiveDemoProjects(state)
                    .then(async count => {
                      await props.onChanged();
                      props.notify(count > 0 ? `已归档 ${count} 个示例项目，工作区已清空。` : '已清理示例标记。');
                    })
                    .catch(caught => props.notify(asError(caught).message, true))
                    .finally(() => setArchivingDemo(false));
                }}
              >
                {archivingDemo ? <Spinner /> : null}
                一键归档示例，开始真实项目
              </button>
            </div>
          )}

          {/* Morning / Midday / Evening Work Rhythm Bar */}
          <WorkRhythmBar
            date={date}
            projectId={projectId}
            todayCount={today.length}
            doneTodayCount={doneTodayCount}
            urgentCount={attention.length + proactiveTotal}
            riskProjectCount={riskProjects.length}
            onFilterWork={() => setFilter('work')}
            onFilterAttention={() => setFilter(attention.length > 0 ? 'attention' : 'proactive')}
            onAskCopilot={props.onAskCopilot}
            onReportGenerated={async () => {
              await reloadProactive();
              props.onNavigate('reports');
            }}
            notify={props.notify}
          />

          {/* Top 4 Metric Pills */}
          <section className="today-summary-strip" aria-label="今日关键指标">
            <button
              className={`today-metric-pill ${filter === 'work' ? 'is-active' : ''}`}
              onClick={() => setFilter(f => f === 'work' ? 'all' : 'work')}
            >
              <span>我的今日执行</span>
              <strong>{today.length}</strong>
            </button>
            <button
              className={`today-metric-pill ${attention.length > 0 ? 'is-attention' : ''} ${filter === 'attention' ? 'is-active' : ''}`}
              onClick={() => setFilter(f => f === 'attention' ? 'all' : 'attention')}
            >
              <span>需协调与拍板</span>
              <strong>{attention.length}</strong>
            </button>
            <button
              className={`today-metric-pill ${proactiveTotal > 0 ? 'is-attention' : ''} ${filter === 'proactive' ? 'is-active' : ''}`}
              onClick={() => setFilter(f => f === 'proactive' ? 'all' : 'proactive')}
            >
              <span>AI 主动行动</span>
              <strong>{proactiveTotal}</strong>
            </button>
            <button
              className={`today-metric-pill ${props.pendingCount > 0 ? 'is-attention' : ''} ${filter === 'pending' ? 'is-active' : ''}`}
              onClick={() => setFilter(f => f === 'pending' ? 'all' : 'pending')}
            >
              <span>待确认内容</span>
              <strong>{props.pendingCount}</strong>
            </button>
          </section>

          {/* AI Daily Brief */}
          <TodayBrief
            state={state}
            date={date}
            projectId={projectId}
            onTaskOpen={props.onTaskOpen}
            onModelSettings={props.onModelSettings}
          />

          {/* Unified 1-Click Action Stream */}
          <section className="stream-section" aria-label="统一待处理行动流">
            <div className="stream-section-header">
              <h2>
                <Zap size={15} />
                待处理与一键执行
                <small>点一下即完成，无需跳转填表</small>
              </h2>
              <div className="stream-filters" role="tablist" aria-label="筛选行动类型">
                {([
                  ['all', '全部'],
                  ['work', '我的执行'],
                  ['attention', '协调拍板'],
                  ['proactive', 'AI 主动'],
                  ['pending', '待确认'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={filter === key}
                    className={`stream-filter-btn ${filter === key ? 'is-active' : ''}`}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {!hasAnyItem ? (
              <div className="stream-card">
                <div className="stream-card-main">
                  <h3 className="stream-card-title">
                    <Check size={15} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} />
                    当前视图下没有待处理事项
                  </h3>
                  <p className="stream-card-desc">
                    你可以新建任务、导入会议纪要，或直接在底部向 AI 副驾驶提问。
                  </p>
                </div>
                <div className="stream-card-actions">
                  <button className="button secondary compact" onClick={props.onCreateTask}>新建任务</button>
                </div>
              </div>
            ) : (
              <div className="stream-card-list">
                {/* 1. Today's Execution Work FIRST (above the fold, with 1-Click Complete) */}
                {showWork && today.map(({ task, reason, urgent }) => (
                  <article key={`task-${task.id}`} className={`stream-card ${urgent ? 'is-urgent' : ''}`}>
                    <div className="stream-card-main">
                      <div className="stream-card-meta">
                        <span className={`stream-tag ${urgent ? 'is-urgent' : 'is-neutral'}`}>
                          {urgent ? '优先执行' : '今日任务'}
                        </span>
                        <span>{projectName(task.projectId)}</span>
                        <span>· {TASK_STATUS[task.status]}{task.progress > 0 ? ` ${task.progress}%` : ''}</span>
                      </div>
                      <h3 className="stream-card-title">{task.title}</h3>
                      <p className="stream-card-desc">{reason}</p>
                    </div>
                    <div className="stream-card-actions">
                      <button
                        className="button secondary compact"
                        disabled={!!busyTaskId}
                        onClick={() => void quickCompleteTask(task)}
                        title="一键标记此任务已完成"
                      >
                        {busyTaskId === task.id ? <Spinner /> : <CheckCircle2 size={13} />}
                        完成
                      </button>
                      <button className="button secondary compact" onClick={() => setCoachTask(task)}>
                        <Sparkles size={13} />
                        帮我推进
                      </button>
                      <button className="text-button tiny" onClick={() => props.onTaskOpen(task.id, task.projectId)}>
                        详情
                      </button>
                    </div>
                  </article>
                ))}

                {/* 2. Unified AI Continuous Work + Proactive 1-Click Cards */}
                {showProactive && readyWorks.map(work => (
                  <WorkOneClickCard
                    key={`work-${work.id}`}
                    work={work}
                    date={date}
                    onExecuted={reloadProactive}
                    onOpenRecord={() =>
                      work.kind === 'memory_conflict'
                        ? props.onReview()
                        : props.onTaskOpen(work.targetId, work.projectId)
                    }
                    notify={props.notify}
                  />
                ))}
                {showProactive && readyProactive.map(action => (
                  <ProactiveOneClickCard
                    key={`proactive-${action.id}`}
                    action={action}
                    onExecuted={reloadProactive}
                    onOpenDetail={() => props.onNavigate('proactive')}
                    onOpenFeishu={props.onOpenFeishu}
                    notify={props.notify}
                  />
                ))}

                {/* 3. Attention / Decisions / Blockers / Follow-ups */}
                {showAttention && attention.map(item => (
                  <article
                    key={`att-${item.key}`}
                    className={`stream-card ${item.date && item.date < date ? 'is-urgent' : ''}`}
                  >
                    <div className="stream-card-main">
                      <div className="stream-card-meta">
                        <span className={`stream-tag ${item.date && item.date < date ? 'is-urgent' : 'is-attention'}`}>
                          {INTENT_LABEL[item.intent]}{item.date && item.date < date ? ' · 已逾期' : ''}
                        </span>
                        <span>{projectName(item.projectId)}</span>
                        {item.owner && <span>· {item.owner}</span>}
                      </div>
                      <h3 className="stream-card-title">{item.title}</h3>
                      <p className="stream-card-desc">{item.note || '需要核对下一步和负责人。'}</p>
                    </div>
                    <div className="stream-card-actions">
                      <button className="button secondary compact" onClick={() => openAttention(item)}>
                        {item.followUp ? 'AI 帮我跟进' : '立即处理'}
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  </article>
                ))}

                {/* 4. Inline Pending Triage Cards (Task & Memory Proposals) */}
                {showPending && inlineTaskProposals.map(proposal => (
                  <InlineTaskProposalCard
                    key={`tp-${proposal.id}`}
                    proposal={proposal}
                    projectName={projectName(proposal.projectId)}
                    date={date}
                    onExecuted={reloadProactive}
                    onOpenSource={() => props.onSourceOpen(proposal.sourceId)}
                    notify={props.notify}
                  />
                ))}
                {showPending && inlineMemoryProposals.map(proposal => (
                  <InlineMemoryProposalCard
                    key={`mp-${proposal.id}`}
                    proposal={proposal}
                    projectName={projectName(proposal.projectId)}
                    onExecuted={reloadProactive}
                    onOpenSource={() => props.onSourceOpen(proposal.sourceId)}
                    notify={props.notify}
                  />
                ))}
                {showPending && remainingPending > 0 && (
                  <div className="stream-card">
                    <div className="stream-card-main">
                      <p className="stream-card-desc">
                        还有 {remainingPending} 条待澄清或到期复核内容等待处理。
                      </p>
                    </div>
                    <div className="stream-card-actions">
                      <button className="text-button tiny" onClick={() => props.onNavigate('inbox')}>
                        查看全部待确认 <ArrowRight size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Silent Auto-Organize Control Bar */}
          {maintenance && (
            <section className={`silent-auto-bar ${silentEnabled ? 'is-enabled' : ''}`} aria-label="静默自动整理">
              <div className="silent-auto-status">
                <span className="silent-auto-dot" />
                <span>
                  {silentEnabled
                    ? `静默自动整理已开启 · 常规新事实自动归档，仅冲突与风险推到首页（今日已用 ${maintenance.callsToday}/${maintenance.settings.dailyCalls} 次）`
                    : '静默自动整理未开启 · 开启后常规资料自动入库，大幅减少人工审核负担'}
                </span>
              </div>
              <div className="silent-auto-actions">
                {silentEnabled ? (
                  <button className="text-button tiny" disabled={busyAuto} onClick={() => void runAutoOrganizeNow()}>
                    {busyAuto ? <Spinner /> : <RefreshCw size={12} />}
                    立即整理
                  </button>
                ) : (
                  <button className="button secondary compact" disabled={busyAuto} onClick={() => void enableSilentAutoOrganize()}>
                    {busyAuto ? <Spinner /> : <Sparkles size={13} />}
                    一键开启静默整理
                  </button>
                )}
                <button className="text-button tiny" onClick={props.onConnect}>
                  管理规则
                </button>
              </div>
            </section>
          )}

          {/* Compact Project Health Strip */}
          <section className="stream-section" aria-label="项目健康度">
            <div className="stream-section-header">
              <h2>
                项目进展
                {riskProjects.length > 0 && <small>· {riskProjects.length} 个项目需关注</small>}
              </h2>
              <button className="text-button tiny" onClick={() => props.onNavigate('overview')}>
                进入项目空间 <ArrowRight size={12} />
              </button>
            </div>
            {delivery.error ? (
              <div className="stream-card">
                <div className="stream-card-main">
                  <p className="stream-card-desc"><CircleAlert size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />项目进度暂未读取。</p>
                </div>
                <button className="text-button tiny" onClick={delivery.refresh}><RefreshCw size={12} />重试</button>
              </div>
            ) : projects.length > 0 ? (
              <div className="stream-card-list">
                {projects.slice(0, 4).map(project => {
                  const next = nextMilestone(project.milestones);
                  const total = project.taskCounts.total - project.taskCounts.cancelled;
                  const health = projectHealth(project);
                  return (
                    <button
                      key={project.projectId}
                      className="stream-card"
                      style={{ textAlign: 'left', width: '100%' }}
                      onClick={() => props.onProjectOpen(project.projectId)}
                    >
                      <div className="stream-card-main">
                        <div className="stream-card-meta">
                          <span className={`stream-tag ${health.state === 'on_track' ? 'is-neutral' : health.state === 'blocked' ? 'is-urgent' : 'is-attention'}`}>
                            {health.label}
                          </span>
                          <span>{total ? `${project.taskCounts.done} / ${total} 任务完成` : '尚无任务'}</span>
                          <span>· {next ? `下一里程碑：${next.title} (${dayLabel(next.forecastDate || next.baselineDate, date)})` : '下一里程碑待明确'}</span>
                        </div>
                        <h3 className="stream-card-title">{project.name}</h3>
                      </div>
                      <ChevronRight size={15} style={{ color: 'var(--text-faint)', alignSelf: 'center' }} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="stream-card-desc">还没有项目进展记录。</p>
            )}
          </section>
        </div>
      </div>

      {/* Bottom Quick Copilot Bar */}
      <div className="today-compose-dock">
        <form
          className="today-compose-form"
          onSubmit={e => {
            e.preventDefault();
            if (!question.trim()) return;
            props.onAskCopilot(question.trim());
            setQuestion('');
          }}
        >
          <Sparkles className="ai-mark" size={16} aria-hidden="true" />
          <label className="visually-hidden" htmlFor="today-copilot-input">向 AI 副驾驶提问</label>
          <input
            id="today-copilot-input"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="问问或直接下指令，例如：把设计稿延到周五 / 新建任务：明天对接口 / 生成今天日报（⌘J）"
            maxLength={1500}
          />
          <button type="submit" aria-label="发送给 AI 副驾驶" disabled={!question.trim()}>
            <ArrowUp size={16} />
          </button>
        </form>
      </div>

      {quickCreateOpen && (
        <Dialog title="快速新建今日任务" subtitle="创建后立即加入当前「今日行动流」顶部" close={() => setQuickCreateOpen(false)} busy={creatingTask}>
          <form onSubmit={e => void submitQuickCreate(e)}>
            <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label>
                <span className="field-label">任务标题</span>
                <input
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="例如：评审灰度发布检查清单"
                  maxLength={200}
                  autoFocus
                  required
                  disabled={creatingTask}
                />
              </label>
              <div className="onboarding-form-row">
                <label>
                  <span className="field-label">所属项目</span>
                  <select value={newProjectId} onChange={e => setNewProjectId(e.target.value)} disabled={creatingTask}>
                    {state.projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">优先级</span>
                  <select value={newPriority} onChange={e => setNewPriority(e.target.value as 'low' | 'medium' | 'high')} disabled={creatingTask}>
                    <option value="high">高优先级</option>
                    <option value="medium">普通</option>
                    <option value="low">低优先级</option>
                  </select>
                </label>
              </div>
              <div className="onboarding-form-row">
                <label>
                  <span className="field-label">截止日期</span>
                  <input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} disabled={creatingTask} />
                </label>
                <label>
                  <span className="field-label">负责人</span>
                  <input value={newAssignee} onChange={e => setNewAssignee(e.target.value)} placeholder="我" disabled={creatingTask} />
                </label>
              </div>
            </div>
            <div className="dialog-footer">
              <button type="button" className="button secondary" onClick={() => setQuickCreateOpen(false)} disabled={creatingTask}>取消</button>
              <button type="submit" className="button primary" disabled={creatingTask || !newTitle.trim() || !newProjectId}>
                {creatingTask ? <Spinner /> : <Plus size={14} />}
                立即加入今日
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {coachTask && (
        <Dialog title={coachTask.title} subtitle="AI 帮你推进当前一步" close={() => setCoachTask(null)} wide>
          <div className="dialog-body">
            <TaskCoach
              state={state}
              onModelSettings={props.onModelSettings}
              key={coachTask.id}
              task={state.tasks.find(t => t.id === coachTask.id) ?? coachTask}
              date={date}
              autoStart
              onChanged={async () => {
                await reloadProactive();
              }}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
