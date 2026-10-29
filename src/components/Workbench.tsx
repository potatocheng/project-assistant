import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Link2, RefreshCw } from 'lucide-react';
import type { AppState, ManagementKind, Page, Task } from '../types';
import { KIND_LABELS, TASK_STATUS } from '../types';
import { WaterMark } from './WaterMark';
import { Dialog, Spinner } from './ui';
import { TaskCoach } from './coach/TaskCoach';
import { useDeliveryQuery } from './delivery/shared';
import type { DeliveryOverviewData, FollowUpCenterData } from './delivery/types';
import type { GovernanceWorkspaceData } from './governance/gov-types';
import type { ChangeData } from './governance/change-types';
import { collectAttention, collectTodayWork, nextMilestone, projectOrder, type AttentionItem } from './workbench-model';
import './assistant-home.css';

interface WorkbenchProps {
  state: AppState; date: string; projectId: string; onProjectChange: (id: string) => void;
  onNavigate: (page: Page) => void; onProjectOpen: (id: string) => void;
  onTaskOpen: (id: string, projectId: string) => void;
  onManagementOpen: (kind: ManagementKind, id: string, projectId: string) => void;
  onAsk: (question: string) => void; onChanged: () => Promise<unknown>;
  onConnect: () => void; onReview: () => void; onSourceOpen: (id: string) => void; onMemoryOpen: (id: string, projectId: string) => void;
}
interface SyncStatus {
  settings: { enabled: boolean; sources: Array<{ enabled: boolean; projectId: string; target: string }> };
  syncing: boolean; lastError?: string | null;
  statuses: Array<{ target: string; projectId: string; at: string; imported: number; error: string | null }>;
}
interface Maintenance {
  settings: { enabled: boolean; autoNew: boolean }; blockedReason?: string | null;
  reviews: Array<{ id: string; projectId: string; sourceId: string; proposalId: string; content: string }>;
}
const HEALTH = { on_track: '暂无延期记录', at_risk: '交付有风险', blocked: '存在阻塞', completed: '已完成' };
const INTENT = { action: '我的执行', followup: '需要跟进', decision: '等待你拍板', risk: '需要协调' };
const INITIAL_WORK = 3;
function dayLabel(value: string | null, today: string) {
  if (!value) return '日期待明确';
  if (value === today) return '今天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}
function clock(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
}

export function Workbench(props: WorkbenchProps) {
  const { state, date, projectId } = props;
  const delivery = useDeliveryQuery<DeliveryOverviewData>('get_delivery_overview', date, projectId, state, true);
  const followUps = useDeliveryQuery<FollowUpCenterData>('get_follow_up_center', date, projectId, state, true);
  const governance = useDeliveryQuery<GovernanceWorkspaceData>('get_governance_workspace', date, projectId, state, true);
  const changes = useDeliveryQuery<ChangeData>('get_change_acceptance', date, projectId, state, true);
  const sync = useDeliveryQuery<SyncStatus>('get_feishu_sources', date, projectId, state, true);
  const maintenance = useDeliveryQuery<Maintenance>('get_memory_maintenance', date, projectId, state, true);
  const [record, setRecord] = useState<Task | null>(null);
  const [allWork, setAllWork] = useState(false);
  const [allAttention, setAllAttention] = useState(false);
  const [readAt, setReadAt] = useState('');
  const activeProjects = useMemo(() => new Set(state.projects.map(project => project.id)), [state.projects]);
  const inScope = (id: string) => activeProjects.has(id) && (!projectId || id === projectId);
  const tasks = state.tasks.filter(task => inScope(task.projectId));
  const today = collectTodayWork(tasks, date, projectId);
  const todayIds = new Set(today.map(item => item.task.id));
  const attention = collectAttention({ tasks, followUps: followUps.data?.items ?? [],
    governance: (governance.data?.items ?? []).filter(item => inScope(item.projectId)),
    changes: (changes.data?.changes ?? []).filter(item => inScope(item.projectId)),
    deliverables: (changes.data?.deliverables ?? []).filter(item => inScope(item.projectId)), date, projectId,
  }).filter(item => !item.task || item.task.category === 'follow_up'
    || (!todayIds.has(item.id) && (item.task.status === 'blocked' || !!item.followUp)));
  const projects = [...(delivery.data?.projects ?? [])].filter(project => inScope(project.projectId))
    .sort((a, b) => projectOrder(a) - projectOrder(b) || a.name.localeCompare(b.name, 'zh-CN'));
  const pendingTasks = state.taskProposals.filter(item => inScope(item.projectId) && item.status === 'pending');
  const pendingMemories = state.proposals.filter(item => inScope(item.projectId) && item.status === 'pending');
  const reviews = (maintenance.data?.reviews ?? []).filter(item => inScope(item.projectId));
  const drafts = (state.extractionDrafts ?? []).filter(item => inScope(item.projectId) && item.status === 'needs_review');
  const pendingCount = pendingTasks.length + pendingMemories.length + drafts.length
    + reviews.filter(item => !pendingMemories.some(proposal => proposal.id === item.proposalId)).length;
  const sources = state.sources.filter(item => inScope(item.projectId));
  const memories = state.memories.filter(item => inScope(item.projectId));
  // An imported source is never presented as an extracted or confirmed project fact.
  const recent = [
    ...memories.filter(item => item.retention?.layer !== 'clarify' && item.retention?.layer !== 'archive').map(item => ({ key: `memory:${item.id}`, label: item.content,
      caption: `${KIND_LABELS[item.kind]}已更新 · ${item.sourceTitle}`, projectId: item.projectId, at: item.updatedAt,
      open: () => props.onMemoryOpen(item.id, item.projectId) })),
    ...sources.map(item => ({ key: `source:${item.id}`, label: item.title,
      caption: item.status === 'failed' ? '资料解析失败' : item.status === 'processing' ? '正在解析资料' : '新资料已收录',
      projectId: item.projectId, at: item.importedAt, open: () => props.onSourceOpen(item.id) })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
  const subscriptions = (sync.data?.settings.sources ?? []).filter(source => source.enabled && inScope(source.projectId));
  const syncRecords = (sync.data?.statuses ?? []).filter(status => inScope(status.projectId)
    && subscriptions.some(source => source.target === status.target && source.projectId === status.projectId));
  const latestSync = [...syncRecords].sort((a, b) => b.at.localeCompare(a.at))[0];
  const syncError = sync.data?.lastError || syncRecords.find(status => status.error)?.error;
  const running = state.jobs.filter(job => (job.status === 'queued' || job.status === 'running') && sources.some(source => source.id === job.sourceId));
  const queries = [delivery, followUps, governance, changes, sync, maintenance];
  const problems = queries.flatMap((query, index) => query.error ? [{ label: ['项目进度', '跟进', '风险决策', '变更验收', '资料同步', '自动整理'][index], query }] : []);
  const loading = queries.some(query => query.loading);
  const attentionIncomplete = followUps.loading || governance.loading || changes.loading || !!followUps.error || !!governance.error || !!changes.error;
  const riskProjects = projects.filter(project => projectOrder(project) < 2);
  const projectName = (id: string) => state.projects.find(project => project.id === id)?.name || '项目';
  const focused = today[0];
  const openAttention = (item: AttentionItem) => {
    if (item.followUp) setRecord(item.followUp.task);
    else if (item.kind === 'task') props.onTaskOpen(item.id, item.projectId);
    else props.onManagementOpen(item.kind, item.id, item.projectId);
  };
  useEffect(() => { setAllWork(false); setAllAttention(false); }, [projectId, date]);
  useEffect(() => { if (delivery.data && !delivery.error) setReadAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })); }, [delivery.data, delivery.error]);

  return <div className="assistant-home">
    <div className="ah-document">
      <header className="ah-heading"><div><p className="ah-date">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${date}T12:00:00`))}</p><h1>今天，先关注这些</h1></div><label className="ah-scope"><span className="visually-hidden">工作台项目范围</span><select value={projectId} onChange={event => props.onProjectChange(event.target.value)}><option value="">全部项目</option>{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={14}/></label></header>
      <section className="ah-brief" aria-label="今日工作摘要"><WaterMark size={28}/><div><p>{today.length ? <>你有 <strong>{today.length} 项</strong>工作需要推进。{focused?.urgent ? '先处理阻塞和逾期事项。' : '已按截止时间和优先级整理。'}</> : '当前没有已安排的个人工作。'}{!delivery.loading && !delivery.error && riskProjects.length > 0 && <>另有 <strong>{riskProjects.length} 个项目</strong>出现交付风险。</>}</p><span>{focused ? `建议先看：${focused.task.title}` : '从聊天和资料中提取的待办，确认后会进入工作安排。'}</span></div></section>
      {!sources.length && !subscriptions.length && !sync.loading && <div className="ah-start"><div><strong>先接入项目信息</strong><p>连接项目群聊与文档，或导入现有资料，让助理开始整理待办和变化。</p></div><button className="button primary compact" onClick={props.onConnect}>连接聊天与文档</button><button className="ah-link" onClick={() => props.onNavigate('sources')}>导入资料<ArrowRight size={13}/></button></div>}
      {problems.length > 0 && <details className="ah-problems"><summary><CircleAlert size={14}/>部分信息读取失败，当前内容可能不完整</summary>{problems.map(({ label, query }) => <div key={label}><span>{label}：{query.error}</span><button className="text-button" onClick={query.refresh}>重试<RefreshCw size={12}/></button></div>)}</details>}

      <div className="ah-work-grid">
        <section className="ah-today" aria-labelledby="ah-today-heading"><div className="ah-section-heading"><h2 id="ah-today-heading">我的今日工作 <small>{today.length}</small></h2><button className="ah-link" onClick={() => props.onNavigate('daily')}>工作安排<ArrowRight size={13}/></button></div><p className="ah-section-note">我的执行 · 包含之前安排但尚未完成的工作</p>
          {today.length ? <ol className="ah-task-list">{today.slice(0, allWork ? undefined : INITIAL_WORK).map(({ task, reason, urgent }, index) => <li key={task.id}><div className="coach-home-task"><button className="ah-task" onClick={() => props.onTaskOpen(task.id, task.projectId)}><span className={`ah-task-number ${urgent ? 'urgent' : ''}`}>{String(index + 1).padStart(2, '0')}</span><span className="ah-task-copy"><strong>{task.title}</strong><span className={urgent ? 'ah-urgent' : ''}>{reason}</span><small>{projectName(task.projectId)}<i>·</i>{TASK_STATUS[task.status]}{task.progress > 0 && ` ${task.progress}%`}</small></span><ChevronRight size={15}/></button><button className="text-button tiny" onClick={() => setRecord(task)}>帮我推进</button></div></li>)}</ol> : <div className="ah-empty"><Check size={21}/><p>今天的安排还是空的</p><span>把已有任务排到今天，或连接聊天和资料整理待办。</span></div>}
          {today.length > INITIAL_WORK && <button className="ah-link ah-more" onClick={() => setAllWork(!allWork)}>{allWork ? '收起' : `还有 ${today.length - INITIAL_WORK} 项工作`}<ChevronDown size={13}/></button>}
        </section>
        <section className="ah-attention" aria-labelledby="ah-attention-heading"><div className="ah-section-heading"><h2 id="ah-attention-heading">需要我介入 <small>{attention.length}{attentionIncomplete ? '+' : ''}</small></h2></div><p className="ah-section-note">等你拍板、跨人协调和到期跟进</p>
          {attention.slice(0, allAttention ? undefined : 3).map(item => <button className="ah-attention-item" key={item.key} onClick={() => openAttention(item)}><span className={`ah-intent ${item.intent}`}>{INTENT[item.intent]}{item.date && item.date < date ? ' · 已逾期' : ''}</span><strong>{item.title}</strong><span className="ah-attention-reason">{item.note || '需要核对下一步和负责人。'}</span><small>{projectName(item.projectId)} · {item.owner || '负责人待明确'}<ChevronRight size={13}/></small></button>)}
          {!attention.length && <p className="ah-quiet">{attentionIncomplete ? '关注事项尚未完整读取，暂不判断是否有遗漏。' : '当前记录中没有需要你介入的事项。'}</p>}
          {attention.length > 3 && <button className="ah-link ah-more" onClick={() => setAllAttention(!allAttention)}>{allAttention ? '收起' : `还有 ${attention.length - 3} 项需要关注`}<ChevronDown size={13}/></button>}
        </section>
      </div>

      <section className="ah-projects" aria-labelledby="ah-project-heading"><div className="ah-section-heading"><h2 id="ah-project-heading">项目进展</h2><button className="ah-link" onClick={() => props.onNavigate('overview')}>查看项目<ArrowRight size={13}/></button></div>
        {delivery.loading ? <p className="ah-quiet"><Spinner/>正在读取交付状态…</p> : delivery.error ? <p className="ah-quiet">项目进度暂未读取，请重试。</p> : projects.length ? <div className="ah-project-list">{projects.slice(0, 4).map(project => {
          const next = nextMilestone(project.milestones);
          const total = project.taskCounts.total - project.taskCounts.cancelled;
          const progress = total > 0 ? Math.round(project.taskCounts.done / total * 100) : 0;
          const inactive = project.profile.status === 'on_hold' || project.profile.status === 'cancelled';
          const basis = project.basis.find(item => item.kind !== 'project')?.label;
          return <button className="ah-project-row" key={project.projectId} onClick={() => props.onProjectOpen(project.projectId)}><span className="ah-project-main"><strong>{project.name}</strong><span className={`ah-health ${inactive ? 'inactive' : project.health}`}><i/>{project.profile.status === 'on_hold' ? '已暂缓' : project.profile.status === 'cancelled' ? '已取消' : HEALTH[project.health]}</span><small>{basis || project.profile.goal || '尚未记录项目目标'}</small></span><span className="ah-project-progress"><span>{total ? <><b>{project.taskCounts.done}</b> / {total} 项任务完成</> : '尚无已确认任务'}</span><span className="ah-progress-track"><i style={{ width: `${progress}%` }}/></span></span><span className="ah-project-next"><span>{next ? `下一步 · ${next.title}` : '下一里程碑待明确'}</span><small>{next ? dayLabel(next.forecastDate || next.baselineDate, date) : project.profile.targetDate ? `项目目标 ${dayLabel(project.profile.targetDate, date)}` : '目标日期待明确'}{next?.slipDays && next.slipDays > 0 ? ` · 预计延后 ${next.slipDays} 天` : ''}</small></span><ChevronRight size={15}/></button>;
        })}</div> : <p className="ah-quiet">这个范围内还没有项目进展记录。</p>}
        {projects.length > 4 && <p className="ah-section-note">优先展示需要关注的项目，另有 {projects.length - 4} 个项目可在「项目」查看。</p>}
      </section>

      <section className="ah-updates" aria-labelledby="ah-updates-heading"><div className="ah-section-heading"><h2 id="ah-updates-heading">聊天与资料的新变化</h2><button className="ah-link" onClick={props.onConnect}>管理来源<ArrowRight size={13}/></button></div>
        {pendingCount > 0 && <details className="ah-review"><summary><CircleAlert size={17}/><span><strong>{pendingCount} 条新内容需要确认</strong><small>尚未计入今日工作和项目进展</small></span><ChevronDown size={15}/></summary><div>
          {reviews.length > 0 && <button className="ah-link" onClick={props.onReview}>核对 {reviews.length} 条记忆变化<ArrowRight size={13}/></button>}
          {pendingTasks.length > 0 && <button className="ah-link" onClick={() => props.onSourceOpen(pendingTasks[0].sourceId)}>核对资料待办 · {pendingTasks[0].title}<ArrowRight size={13}/></button>}
          {pendingMemories.length > 0 && <button className="ah-link" onClick={() => props.onSourceOpen(pendingMemories[0].sourceId)}>核对新事实 · {pendingMemories[0].content}<ArrowRight size={13}/></button>}
          {drafts.length > 0 && <button className="ah-link" onClick={() => props.onSourceOpen(drafts[0].sourceId)}>澄清 {drafts.length} 条有歧义的内容<ArrowRight size={13}/></button>}
        </div></details>}
        {recent.length ? <div className="ah-update-list">{recent.map(entry => <button key={entry.key} onClick={entry.open}><span className="ah-update-dot"/><span><strong>{entry.label}</strong><small>{entry.caption} · {projectName(entry.projectId)}</small></span><time dateTime={entry.at}>{clock(entry.at)}</time></button>)}</div> : <p className="ah-quiet">连接项目群聊或导入资料后，提取和确认的变化会出现在这里。</p>}
        <details className="ah-sync"><summary><span className={`ah-live-dot ${sync.error || syncError || maintenance.error || maintenance.data?.blockedReason ? 'warning' : sync.data?.settings.enabled && subscriptions.length ? 'connected' : ''}`}/><span>{sync.loading ? '正在检查资料来源' : sync.error ? '暂时无法读取同步状态' : syncError ? '资料同步遇到问题' : sync.data?.syncing ? '正在同步聊天和资料' : !sync.data?.settings.enabled || !subscriptions.length ? '尚未开启此范围的自动同步' : `自动同步已开启 · ${subscriptions.length} 个来源${latestSync ? ` · 最近检查 ${clock(latestSync.at)}` : ' · 等待首次同步'}`}{running.length ? ` · ${running.length} 份资料整理中` : ''}</span><ChevronDown size={12}/></summary><div>
          <p>{latestSync ? `最近同步检查：${clock(latestSync.at)}` : '尚无此范围的同步检查记录。'}{syncError ? ` ${syncError}` : ''}</p>
          <p>{maintenance.error ? '自动整理状态暂未读取。' : maintenance.data?.blockedReason ? `整理已暂停：${maintenance.data.blockedReason}` : maintenance.data?.settings.enabled ? `空闲时自动整理资料，${maintenance.data.settings.autoNew ? '独立新事实按设置自动加入；冲突内容等待确认。' : '提取结果等待确认。'}` : '自动整理尚未开启。'}</p>
          <p>已确认的任务、记忆和进度变化会自动刷新到这里。{readAt && `项目状态读取于 ${readAt}。`}{loading && '部分信息仍在读取。'}</p><button className="ah-link" onClick={props.onConnect}><Link2 size={13}/>连接聊天与文档</button>
        </div></details>
      </section>
    </div>
    <AssistantComposer onAsk={props.onAsk}/>
    {record && <Dialog title={record.title} subtitle="先处理眼前这一步" close={() => setRecord(null)} wide><div className="dialog-body"><TaskCoach key={record.id} task={state.tasks.find(t => t.id === record.id) ?? record} date={date} autoStart onChanged={async () => { await props.onChanged(); followUps.refresh(); }} /></div></Dialog>}
  </div>;
}

function AssistantComposer({ onAsk }: { onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState('');
  return <div className="ah-compose-dock"><form className="ah-compose" onSubmit={event => { event.preventDefault(); if (question.trim()) onAsk(question.trim()); }}><WaterMark size={25}/><label className="visually-hidden" htmlFor="ah-question">向项目助理提问</label><input id="ah-question" placeholder="问问助理，例如：哪个项目可能延期？" value={question} onChange={event => setQuestion(event.target.value)} maxLength={1500}/><button aria-label="发送问题" disabled={!question.trim()}><ArrowUp size={19}/></button></form><p>根据已接入的聊天、资料和工作记录回答，附原文依据</p></div>;
}
