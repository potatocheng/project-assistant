import { useDraftState, DraftStatus } from '../../drafts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CalendarPlus, Check, ChevronDown, ChevronLeft, CircleAlert, FileText, History, PencilLine, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { asError, execute } from '../../api';
import { TASK_CATEGORY, TASK_PRIORITY, TASK_STATUS } from '../../types';
import type { AppState, DailyList, Evidence, Memory, Project, Task, TaskCategory, TaskDetail, TaskPriority, TaskStatus } from '../../types';
import { Spinner } from '../ui';
import { FormDialog } from '../astryx/FormDialog';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Selector } from '@astryxdesign/core/Selector';
import { formatMoment, localDay, WorkEmpty, WorkFilters } from './shared';
import { TaskCoach } from '../coach/TaskCoach';
import { ExplainedText } from '../coach/TermHelp';
import { BatchScheduleDialog } from './BatchScheduleDialog';
import { ListPager } from '../ListPager';
import { DailyPlanning } from './DailyPlanning';
import type { PlanningOverview } from './DailyPlanning';
import './task-focus.css';

export function taskFields(task: Task) {
  return { title: task.title, description: task.description, category: task.category, assignee: task.assignee, priority: task.priority, status: task.status, progress: task.progress, dueDate: task.dueDate, plannedDate: task.plannedDate };
}
export function TaskStatusLabel({ status }: { status: TaskStatus }) { return <span className={`task-status task-status-${status}`}><i />{TASK_STATUS[status]}</span>; }

export function TaskWorkspace({ mode, state, day: selectedDay, setDay, projectId, setProjectId, focusTaskId, createTaskRequest, onCreateTaskConsumed, onChanged, notify, onEvidence, onReport }: {
  mode: 'daily' | 'tasks'; state: AppState; day: string; setDay: (day: string) => void;
  projectId: string; setProjectId: (id: string) => void; focusTaskId: string | null;
  createTaskRequest: number; onCreateTaskConsumed: () => void;
  onChanged: () => Promise<unknown>; notify: (message: string, error?: boolean) => void;
  onEvidence: (evidence: Evidence) => void; onReport: () => void;
}) {
  const day = mode === 'tasks' ? localDay() : selectedDay;
  const [planning, setPlanning] = useState<PlanningOverview | null>(null);
  const [showUnplanned, setShowUnplanned] = useState(false);
  const [daily, setDaily] = useState<DailyList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusTaskId);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [form, setForm] = useState<'create' | 'edit' | 'plan' | 'batch' | null>(null);
  useEffect(() => {
    if (createTaskRequest) { setForm('create'); onCreateTaskConsumed(); }
  }, [createTaskRequest, onCreateTaskConsumed]);
  const [planTask, setPlanTask] = useState<Task | null>(null);
  const listPanelRef = useRef<HTMLElement>(null);
  const revealDetail = useRef(!!focusTaskId);
  const [listPage,setListPage]=useState(0);
  useEffect(()=>setListPage(0),[query,status,projectId,day]);
  const [tick, setTick] = useState(0);
  const inspectorRef = useRef<HTMLElement>(null);
  const taskVersion = (state.tasks ?? []).map((task) => `${task.id}:${task.version}`).join(',');
  const scoped = useMemo(() => (state.tasks ?? []).filter((task) => !projectId || task.projectId === projectId), [state.tasks, projectId]);
  const currentPlanning = planning?.date === day && (planning.projectId ?? '') === projectId ? planning : null;
  const originalList = mode === 'daily' ? daily?.tasks ?? [] : scoped;
  const allocated = new Map((currentPlanning?.allocations ?? []).map((a) => [a.taskId, a.position]));
  const isConfirmed = mode === 'daily' && !!currentPlanning?.confirmedPlan;
  const belongsToday = (task: Task) => allocated.has(task.id) && task.plannedDate === day && task.status !== 'cancelled' || ['todo', 'in_progress', 'blocked'].includes(task.status) && task.plannedDate === day;
  const unplannedCount = isConfirmed ? originalList.filter((t) => !belongsToday(t)).length : 0;
  const listed = isConfirmed && !showUnplanned ? originalList.filter(belongsToday).sort((a, b) => (allocated.get(a.id) ?? 99999) - (allocated.get(b.id) ?? 99999)) : originalList;
  const rows = listed.filter((task) => (!status || task.status === status) && `${task.title} ${task.description} ${task.assignee ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const pageIndex=Math.min(listPage,Math.max(0,Math.ceil(rows.length/50)-1));
  useEffect(()=>{if(focusTaskId){const i=rows.findIndex(t=>t.id===focusTaskId);if(i>=0)setListPage(Math.floor(i/50));}},[focusTaskId]);
  const hasFilter = !!query || !!status;
  const hasUnfinishedTasks = scoped.some((task) => ['todo', 'in_progress', 'blocked'].includes(task.status));
  const selectedSnapshot = listed.find((task) => task.id === selectedId);
  const selectedCurrentVersion = state.tasks?.find((task) => task.id === selectedId)?.version;

  useEffect(() => {
    if (mode !== 'daily') return;
    let cancelled = false; setLoading(true); setError('');
    execute<DailyList>('get_daily_list', { date: day, ...(projectId ? { projectId } : {}) })
      .then((result) => { if (!cancelled) setDaily(result); })
      .catch((caught) => { if (!cancelled) setError(asError(caught).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, day, projectId, taskVersion, tick]);
  useEffect(() => { if (focusTaskId) { revealDetail.current = true; setSelectedId(focusTaskId); } }, [focusTaskId]);
  useEffect(() => {
    setSelectedId((current) => rows.some((task) => task.id === current) ? current : rows[0]?.id ?? null);
  }, [rows.map((task) => task.id).join(',')]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false; setDetailLoading(true); setDetailError('');
    execute<TaskDetail>('get_task', { taskId: selectedId }).then((result) => { if (!cancelled) setDetail(result); })
      .catch((caught) => { if (!cancelled) { setDetail(null); setDetailError(asError(caught).message); } })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, selectedCurrentVersion, tick]);

  const showInspector = () => {
    revealDetail.current = false;
    if (!window.matchMedia('(max-width: 980px)').matches) return;
    inspectorRef.current?.focus({ preventScroll: true });
    inspectorRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const selectTask = (id: string) => {
    revealDetail.current = true;
    setSelectedId(id);
    if (id === selectedId && !detailLoading) showInspector();
  };
  useEffect(() => {
    if (revealDetail.current && !detailLoading && (detail?.task.id === selectedId || detailError)) showInspector();
  }, [selectedId, detailLoading, detail?.task.id, detailError]);
  const returnToList = () => {
    const row = listPanelRef.current?.querySelector<HTMLElement>('.task-row[aria-pressed="true"]');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  const saved = async (task: Task) => {
    setForm(null); setSelectedId(task.id); setTick((value) => value + 1);
    try { await onChanged(); notify('任务已保存。'); }
    catch { notify('任务已保存，列表刷新失败，请重试。', true); }
  };
  const activeCount = rows.filter((task) => ['todo', 'in_progress', 'blocked'].includes(task.status)).length;
  const projectOptions = [{ value: '', label: '全部项目' }, ...state.projects.map(project => ({ value: project.id, label: project.name }))];
  const filterToggle = <Button label={hasFilter ? '筛选中' : '筛选'} variant="ghost" size="sm"
    className="astryx-task-filter-toggle" icon={<SlidersHorizontal size={14} />} endContent={<ChevronDown size={13} />}
    aria-expanded={filtersOpen} aria-controls="task-filter-panel" onClick={() => setFiltersOpen(open => !open)} />;
  return <div className={`work-page task-focus-page ${mode === 'daily' ? 'work-page-daily' : ''}`}>
    <div className="work-page-heading"><div><h2>{mode === 'daily' ? '每日清单' : '全部任务'}</h2></div>
      <div className="work-heading-actions">
        {mode === 'tasks' && hasUnfinishedTasks && <Button label="批量安排日期" variant="secondary" onClick={() => setForm('batch')} />}
        <Button label="新建任务" variant="primary" icon={<Plus size={15} />} onClick={() => setForm('create')} isDisabled={!state.projects.length} />
      </div>
    </div>
    <div className="task-focus-controls">
      {mode === 'daily' ? <WorkFilters day={day} onDayChange={setDay} projects={state.projects} projectId={projectId} onProjectChange={setProjectId}>{filterToggle}</WorkFilters>
        : <div className="work-filters task-project-controls"><Selector label="筛选项目" isLabelHidden containerClassName="astryx-task-project-filter"
          value={projectId} onChange={setProjectId} options={projectOptions} />{filterToggle}</div>}
      {filtersOpen && <div className="task-focus-filter-panel" id="task-filter-panel">
        <TextInput label="查找任务" isLabelHidden placeholder="搜索任务或负责人" value={query} onChange={setQuery}
          startIcon={<Search size={14} />} containerClassName="astryx-task-search" />
        <Selector label="筛选任务状态" isLabelHidden containerClassName="astryx-task-status-filter" value={status}
          onChange={value => setStatus(value as TaskStatus | '')}
          options={[{ value: '', label: '全部状态' }, ...Object.entries(TASK_STATUS).map(([value, label]) => ({ value, label }))]} />
        {hasFilter && <Button label="清除筛选" variant="ghost" size="sm" onClick={() => { setQuery(''); setStatus(''); }} />}
      </div>}
    </div>
    {mode === 'daily' && <DailyPlanning key={`${day}:${projectId}`} day={day} projectId={projectId} tasks={state.tasks} onChanged={onChanged} onOverview={setPlanning}>{hasUnfinishedTasks && <><button className="button secondary compact" onClick={() => { setPlanTask(null); setForm('plan'); }}><CalendarPlus size={15} />选择任务</button><button className="text-button" onClick={()=>setForm('batch')}>批量安排日期</button></>}</DailyPlanning>}
    {isConfirmed && <div className="planning-list-mode"><span>{showUnplanned ? '当前显示当日全部事项。' : '按已确认的排期排列。'}</span><button className="text-button tiny" onClick={() => setShowUnplanned(!showUnplanned)}>{showUnplanned ? '只看已安排任务' : `其他事项 · ${unplannedCount}`}</button></div>}
    <div className={`work-layout ${selectedSnapshot ? 'has-task-detail' : 'list-only'}`}><section className="task-list-panel" ref={listPanelRef}><div className="task-list-toolbar"><div className="task-list-heading"><h3>{mode === 'daily' ? '当天任务' : projectId ? '项目任务' : '全部任务'}</h3><span>{activeCount} 项未完成{rows.length !== activeCount && ` · 共 ${rows.length} 项`}</span></div></div>
      {mode === 'daily' && day !== localDay() && <p className="work-scope-note">清单为截至 {day} 的记录；任务详情显示最新进度。</p>}
      {loading ? <div className="loading-view"><Spinner />正在加载任务…</div> : error ? <WorkEmpty title="清单加载失败" action={<button className="button secondary" onClick={() => setTick((value) => value + 1)}>重试</button>}>{error}</WorkEmpty> : !rows.length ? <WorkEmpty title={hasFilter ? '没有匹配的任务' : !state.projects.length ? '先创建一个项目' : mode === 'daily' ? '这一天暂无任务' : '还没有任务'} action={hasFilter ? <button className="button secondary" onClick={() => { setQuery(''); setStatus(''); }}>清除筛选</button> : mode === 'daily' && hasUnfinishedTasks ? <button className="button secondary" onClick={() => { setPlanTask(null); setForm('plan'); }}><CalendarPlus size={15} />安排已有任务</button> : state.projects.length > 0 ? <button className="button secondary" onClick={() => setForm('create')}><Plus size={15} />新建任务</button> : undefined}>{hasFilter ? '试试其他关键词，或清除状态筛选。' : !state.projects.length ? '在左侧创建项目后，即可添加任务。' : mode === 'daily' ? hasUnfinishedTasks ? '选择已有任务安排到这一天，或新建事项。' : '新建这一天需要推进的事项。' : '添加需要完成或跟进的具体事项。'}</WorkEmpty> : <div className="task-table"><div className="task-table-head"><span>任务 / 负责人</span><span>截止日期</span><span>状态</span></div>{rows.slice(pageIndex*50,(pageIndex+1)*50).map((task) => {
        const allocation = mode === 'daily' ? currentPlanning?.allocations.find((a) => a.taskId === task.id) : undefined;
        const overdue = !!task.dueDate && task.dueDate < day && ['todo', 'in_progress', 'blocked'].includes(task.status);
        return <button key={task.id} className={`task-row ${selectedId === task.id ? 'task-row-selected' : ''}`} aria-pressed={selectedId === task.id} onClick={() => selectTask(task.id)}><div className="task-row-main"><div className="task-row-title">{task.priority === 'high' && <span className="priority-high" title="高优先级">高</span>}<strong>{task.title}</strong></div><div className="task-row-meta"><span>{TASK_CATEGORY[task.category]}</span><span>{task.assignee || '负责人待定'}</span>{!projectId && <span>{state.projects.find((project) => project.id === task.projectId)?.name ?? '所属项目'}</span>}</div>{allocation && <p className="planning-row-reason" title={allocation.reason}>预计 {allocation.minutes} 分钟 · {allocation.reason}</p>}</div><div className={`task-row-due ${overdue ? 'task-overdue' : ''}`}>{task.dueDate ?? '未设置'}{overdue && <small>已逾期</small>}</div><div className="task-row-state"><TaskStatusLabel status={task.status} /><span>{task.progress}%</span></div></button>;
      })}</div>}
      <ListPager page={pageIndex} total={rows.length} size={50} onChange={setListPage}/>
      {mode === 'daily' && originalList.length > 0 && <div className="daily-report-link"><span>将当天已记录的进展整理成日报。</span><button className="text-button" onClick={onReport}>查看当日日报 <ArrowRight size={14} /></button></div>}
    </section>{selectedSnapshot && <aside className="task-inspector" ref={inspectorRef} tabIndex={-1} aria-label="任务详情"><button className="task-inspector-back" onClick={returnToList}><ChevronLeft size={14} />返回任务列表</button>{detailLoading ? <div className="loading-view"><Spinner />正在读取任务…</div> : detailError ? <WorkEmpty title="任务暂时无法读取" action={<button className="button secondary" onClick={() => setTick((value) => value + 1)}>重试</button>}>{detailError}</WorkEmpty> : !detail ? <WorkEmpty title="正在读取任务详情" /> : <>
      <div className="task-detail-heading"><div className="eyebrow">最新进度 · v{detail.task.version}</div><h3><ExplainedText text={detail.task.title} context={detail.task.title} /></h3><div className="task-detail-status"><TaskStatusLabel status={detail.task.status} /><span>{detail.task.progress}%</span></div>{mode === 'daily' && selectedSnapshot && selectedSnapshot.version !== detail.task.version && <p className="task-history-notice">清单记录为 v{selectedSnapshot.version}，当前进度已更新至 v{detail.task.version}。</p>}<div className="task-detail-actions"><Button label="更新进度" variant="primary" size="sm" icon={<PencilLine size={13} />} onClick={() => setForm('edit')} /><Button label="安排日期" variant="secondary" size="sm" icon={<CalendarPlus size={13} />} onClick={() => { setPlanTask(detail.task); setForm('plan'); }} /></div></div>
      <TaskCoach state={state} key={detail.task.id} task={detail.task} date={day} onChanged={async () => { setTick(v => v + 1); await onChanged(); }} /><dl className="task-attributes"><div><dt>项目</dt><dd>{state.projects.find((project) => project.id === detail.task.projectId)?.name}</dd></div><div><dt>执行方式</dt><dd>{TASK_CATEGORY[detail.task.category]}</dd></div><div><dt>负责人</dt><dd>{detail.task.assignee || '待定'}</dd></div><div><dt>优先级</dt><dd>{TASK_PRIORITY[detail.task.priority]}</dd></div><div><dt>计划日期</dt><dd>{detail.task.plannedDate || '未安排'}</dd></div><div><dt>截止日期</dt><dd>{detail.task.dueDate || '未设置'}</dd></div></dl>
      {detail.task.description && <div className="task-description"><h4>任务说明</h4><p><ExplainedText text={detail.task.description} context={detail.task.title} /></p></div>}
      <details className="task-source-section task-source-details"><summary>原文依据{detail.evidence.length > 0 && <span>{detail.evidence.length} 处</span>}</summary>{detail.evidence.length ? detail.evidence.map((evidence) => <div className="task-evidence" key={evidence.segmentId}><strong>{evidence.sourceTitle}</strong><p>{evidence.text}</p><button className="text-button tiny" onClick={() => onEvidence(evidence)}>查看原文 · {evidence.locator} <ArrowRight size={12} /></button></div>) : <p className="panel-hint">{detail.task.memoryId ? `来自项目记忆 v${detail.task.memoryRevision}，无关联原文。` : '此任务为手动创建。'}</p>}</details>
      <details className="task-event-section task-progress-details"><summary><History size={14} />进度历史<span>{detail.events.length} 条 · v{detail.task.version}</span><ChevronDown size={13} /></summary>{detail.events.map((event) => <div className="task-event" key={event.id}><div className="task-event-meta"><strong>{event.workDate}</strong><span>v{event.version}</span></div><div className="task-event-change">{event.before ? `${TASK_STATUS[event.before.status]} ${event.before.progress}% → ` : '创建 → '}{TASK_STATUS[event.after.status]} {event.after.progress}%</div><p>{event.note}</p>{event.evidence.map((evidence) => <button key={evidence.segmentId} className="text-button tiny" onClick={() => onEvidence(evidence)}><FileText size={11} />{evidence.sourceTitle} · {evidence.locator}</button>)}<small>记录于 {formatMoment(event.recordedAt)}</small></div>)}</details>
    </>}</aside>}</div>
    {(form === 'create' || form === 'edit') && <TaskFormDialog task={form === 'edit' ? detail?.task ?? null : null} latestWorkDate={form === 'edit' ? detail?.events[0]?.workDate : undefined} projects={state.projects} projectId={projectId} workDate={day} plannedDate={mode === 'daily' && form === 'create' ? day : null} close={() => setForm(null)} onSaved={saved} />}
    {form === 'batch' && <BatchScheduleDialog tasks={scoped.filter(t=>!['done','cancelled'].includes(t.status))} day={day} close={()=>setForm(null)} onSaved={async()=>{setForm(null);setTick(v=>v+1);await onChanged();notify('批量排期已保存。');}}/>}
    {form === 'plan' && <PlanDialog tasks={(state.tasks ?? []).filter((task) => ['todo', 'in_progress', 'blocked'].includes(task.status) && (!projectId || task.projectId === projectId))} initialTask={planTask} day={day} close={() => setForm(null)} onSaved={saved} />}
  </div>;
}

export function TaskFormDialog({ task: initialTask, latestWorkDate, projects, projectId, workDate, plannedDate, close, onSaved, memory }: {
  task: Task | null; latestWorkDate?: string; projects: Project[]; projectId: string;
  workDate: string; plannedDate: string | null; close: () => void; onSaved: (task: Task) => Promise<void>;
  memory?: Memory;
}) {
  const [task, setTask] = useState(initialTask);
  const [baseWorkDate, setBaseWorkDate] = useState(latestWorkDate);
  const draftState = useDraftState(`task:${initialTask?.id ?? `new:${memory?.id ?? projectId}:${workDate}`}`, { baseVersion: initialTask?.version ?? 0, projectId: task?.projectId ?? memory?.projectId ?? (projectId || projects[0]?.id || ''), title: task?.title ?? (memory?.content.slice(0, 300) ?? ''), description: task?.description ?? memory?.content ?? '', category: task?.category ?? 'action' as TaskCategory, assignee: task?.assignee ?? '', priority: task?.priority ?? 'medium' as TaskPriority, status: task?.status ?? 'todo' as TaskStatus, progress: task?.progress ?? 0, dueDate: task?.dueDate ?? '', plannedDate: task?.plannedDate ?? plannedDate ?? '', workDate, note: '' });
  const { value: draft, setValue: setDraft } = draftState;
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draftState.ready) titleInput.current?.focus({ preventScroll: true });
  }, [draftState.ready]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const patch = (value: Partial<typeof draft>) => { requestId.current = crypto.randomUUID(); setDraft((current) => ({ ...current, ...value })); setError(''); };
  const invalidDate = !!task && !!baseWorkDate && draft.workDate < baseWorkDate;
  const disabled = !draftState.ready || busy;
  const additionalFields = <>
    <Selector label="优先级" aria-label="任务优先级" value={draft.priority} onChange={value => patch({ priority: value as TaskPriority })}
      isDisabled={disabled} options={Object.entries(TASK_PRIORITY).map(([value, label]) => ({ value, label }))} />
    <Selector label={task ? '状态' : '初始状态'} aria-label="任务状态" value={draft.status}
      onChange={value => patch({ status: value as TaskStatus, ...(value === 'done' ? { progress: 100 } : {}) })}
      isDisabled={disabled} options={Object.entries(TASK_STATUS).map(([value, label]) => ({ value, label }))} />
    <label><span className="field-label">进度（%）</span><input aria-label="任务进度百分比" type="number" min={0} max={100} step={1} value={draft.progress} onChange={(event) => patch({ progress: Number(event.target.value) })} disabled={disabled || draft.status === 'done'} required /></label>
    <label><span className="field-label">进展日期</span><input aria-label="任务记录发生日期" type="date" value={draft.workDate} min={task ? baseWorkDate : undefined} onChange={(event) => patch({ workDate: event.target.value })} required disabled={disabled} /></label>
  </>;
  return <FormDialog title={task ? '更新任务' : '新建任务'} subtitle={task ? '更新状态与进度，并记录本次变化。' : memory ? `从项目记忆 v${memory.revision} 创建，保留来源。` : '写清要做什么，再设置负责人和日期。'} close={close} busy={busy} wide><form onSubmit={async (event) => {
    event.preventDefault(); if (disabled || !draft.title.trim() || !draft.projectId || !draft.workDate || invalidDate || (task && !draft.note.trim())) return; setBusy(true); setError('');
    try {
      const fields = { title: draft.title.trim(), description: draft.description.trim(), category: draft.category, assignee: draft.assignee.trim() || null, priority: draft.priority, status: draft.status, progress: draft.progress, dueDate: draft.dueDate || null, plannedDate: draft.plannedDate || null, workDate: draft.workDate, clientRequestId: requestId.current };
      const result = task ? await execute<Task>('update_task', { ...fields, taskId: task.id, baseVersion: draft.baseVersion, note: draft.note.trim() }) : await execute<Task>('create_task', { ...fields, projectId: draft.projectId, ...(memory ? { memoryId: memory.id } : {}) });
      await draftState.clear(); await onSaved(result);
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(false); }
  }}><div className="dialog-body task-form-body"><DraftStatus status={draftState.status} discard={draftState.discard} /><fieldset disabled={!draftState.ready || busy} className="draft-fields astryx-task-fields">
    {!task && <Selector id="task-project" label="所属项目" value={draft.projectId} onChange={value => patch({ projectId: value })}
      isDisabled={disabled || !!memory} isRequired options={projects.map(project => ({ value: project.id, label: project.name }))} />}
    <TextInput ref={titleInput} id="task-title" label="任务标题" value={draft.title} onChange={value => patch({ title: value.slice(0, 300) })}
      isRequired isDisabled={disabled} placeholder="写清楚需要交付或推进的具体结果" />
    <TextArea id="task-description" label="任务说明" isOptional rows={3} value={draft.description}
      onChange={value => patch({ description: value.slice(0, 10000) })} isDisabled={disabled} />
    <div className="task-form-grid">
      <Selector label="执行方式" aria-label="任务执行方式" value={draft.category} onChange={value => patch({ category: value as TaskCategory })}
        isDisabled={disabled} options={Object.entries(TASK_CATEGORY).map(([value, label]) => ({ value, label }))} />
      <TextInput label="负责人" aria-label="任务负责人" value={draft.assignee} onChange={value => patch({ assignee: value.slice(0, 300) })}
        isDisabled={disabled} placeholder="未确认可留空" />
      {task && additionalFields}
      <label><span className="field-label">计划日期</span><input aria-label="任务计划日期" type="date" value={draft.plannedDate} onChange={(event) => patch({ plannedDate: event.target.value })} disabled={disabled} /></label>
      <label><span className="field-label">截止日期</span><input aria-label="任务截止日期" type="date" value={draft.dueDate} onChange={(event) => patch({ dueDate: event.target.value })} disabled={disabled} /></label>
    </div>
    {!task && <details className="advanced-settings"><summary>更多设置<ChevronDown size={14} /></summary><div className="task-form-grid">{additionalFields}</div><p className="field-hint">完成任务时，请同步将状态设为“完成”。</p></details>}
    {task && <p className="field-hint">完成任务时，请同步将状态设为“完成”。</p>}
    {task && <TextArea id="task-note" label="本次进展说明" isRequired rows={3} value={draft.note}
      onChange={value => patch({ note: value.slice(0, 10000) })} placeholder="记录实际发生的变化、当前阻塞或调整原因" isDisabled={disabled} />}
    {invalidDate && <div className="form-error"><CircleAlert size={17} /><p>进展日期不能早于最近一条记录：{baseWorkDate}。</p></div>}{error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
    {task && <div className="revision-version-check"><span>当前编辑 v{task.version}。重新加载会替换任务字段，并保留本次进展说明。</span><button type="button" className="text-button tiny" disabled={busy} onClick={async () => { setBusy(true); try { const current = await execute<TaskDetail>('get_task', { taskId: task.id }); setTask(current.task); setBaseWorkDate(current.events[0]?.workDate); setDraft((value) => ({ ...value, baseVersion:current.task.version, ...taskFields(current.task), assignee: current.task.assignee ?? '', dueDate: current.task.dueDate ?? '', plannedDate: current.task.plannedDate ?? '' })); requestId.current = crypto.randomUUID(); setError(''); } catch (caught) { setError(asError(caught).message); } finally { setBusy(false); } }}>重新加载</button></div>}
  </fieldset></div><div className="dialog-footer"><span className="footer-note">{task ? `校验版本 v${task.version}` : '保存后建立任务历史'}</span><Button label="取消" variant="secondary" onClick={close} isDisabled={busy} />
    <Button type="submit" label={task ? '保存进展' : '创建任务'} variant="primary" icon={<Check size={15} />}
      isLoading={busy} isDisabled={disabled || invalidDate || !draft.title.trim() || !draft.projectId || !draft.workDate || (!!task && !draft.note.trim())} /></div></form></FormDialog>;
}

function PlanDialog({ tasks, initialTask, day, close, onSaved }: { tasks: Task[]; initialTask: Task | null; day: string; close: () => void; onSaved: (task: Task) => Promise<void> }) {
  const [taskId, setTaskId] = useState(initialTask?.id ?? tasks[0]?.id ?? '');
  const [plannedDate, setPlannedDate] = useState(day); const [workDate, setWorkDate] = useState(localDay());
  const [note, setNote] = useState(`安排到 ${day} 的工作清单`); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const pendingPayload = useRef<Record<string, unknown> | null>(null);
  const touch = () => { requestId.current = crypto.randomUUID(); pendingPayload.current = null; setError(''); };
  return <FormDialog title="安排任务日期" subtitle="选择任务与计划日期，加入当天清单。" close={close} busy={busy}><form onSubmit={async (event) => {
    event.preventDefault(); if (busy || !taskId || !plannedDate || !workDate || !note.trim()) return; setBusy(true); setError('');
    try {
      if (!pendingPayload.current) {
        const current = await execute<TaskDetail>('get_task', { taskId });
        if (['done', 'cancelled'].includes(current.task.status)) throw new Error('该任务当前已完成或取消，请先核对最新状态。');
        pendingPayload.current = { taskId, baseVersion: current.task.version, ...taskFields(current.task), plannedDate, note: note.trim(), workDate, clientRequestId: requestId.current };
      }
      const result = await execute<Task>('update_task', pendingPayload.current); await onSaved(result);
    }
    catch (caught) { setError(asError(caught).message); } finally { setBusy(false); }
  }}><div className="dialog-body astryx-task-fields">
    <Selector id="plan-task" label="选择任务" value={taskId} isRequired isDisabled={busy || !!initialTask}
      onChange={value => { setTaskId(value); touch(); }} options={(initialTask ? [initialTask] : tasks).map(task => ({ value: task.id, label: task.title }))} />
    <label><span className="field-label">计划日期</span><input id="plan-day" type="date" aria-label="计划日期" value={plannedDate} required onChange={event => { setPlannedDate(event.target.value); touch(); }} disabled={busy} /></label>
    <label><span className="field-label">进展日期</span><input id="plan-work-date" type="date" aria-label="进展日期" value={workDate} required onChange={event => { setWorkDate(event.target.value); touch(); }} disabled={busy} /></label>
    <TextArea id="plan-note" label="安排说明" rows={2} value={note} isRequired onChange={value => { setNote(value.slice(0, 10000)); touch(); }} isDisabled={busy} />
    {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
  </div><div className="dialog-footer">
    <Button label="取消" variant="secondary" isDisabled={busy} onClick={close} />
    <Button type="submit" label="保存安排" variant="primary" icon={<CalendarPlus size={15} />} isLoading={busy}
      isDisabled={busy || !taskId || !plannedDate || !workDate || !note.trim()} />
  </div></form></FormDialog>;
}
