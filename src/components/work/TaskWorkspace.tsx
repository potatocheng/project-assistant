import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CalendarPlus, Check, CircleAlert, FileText, History, PencilLine, Plus, Search } from 'lucide-react';
import { asError, execute } from '../../api';
import { TASK_CATEGORY, TASK_PRIORITY, TASK_STATUS } from '../../types';
import type { AppState, DailyList, Evidence, Memory, Project, Task, TaskCategory, TaskDetail, TaskPriority, TaskStatus } from '../../types';
import { Dialog, Spinner } from '../ui';
import { formatMoment, localDay, WorkEmpty, WorkFilters } from './shared';

export function taskFields(task: Task) {
  return { title: task.title, description: task.description, category: task.category, assignee: task.assignee, priority: task.priority, status: task.status, progress: task.progress, dueDate: task.dueDate, plannedDate: task.plannedDate };
}
export function TaskStatusLabel({ status }: { status: TaskStatus }) { return <span className={`task-status task-status-${status}`}><i />{TASK_STATUS[status]}</span>; }

export function TaskWorkspace({ mode, state, day, setDay, projectId, setProjectId, focusTaskId, onChanged, notify, onEvidence, onReport }: {
  mode: 'daily' | 'tasks'; state: AppState; day: string; setDay: (day: string) => void;
  projectId: string; setProjectId: (id: string) => void; focusTaskId: string | null;
  onChanged: () => Promise<unknown>; notify: (message: string, error?: boolean) => void;
  onEvidence: (evidence: Evidence) => void; onReport: () => void;
}) {
  const [daily, setDaily] = useState<DailyList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(focusTaskId);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [form, setForm] = useState<'create' | 'edit' | 'plan' | null>(null);
  const [planTask, setPlanTask] = useState<Task | null>(null);
  const [tick, setTick] = useState(0);
  const taskVersion = (state.tasks ?? []).map((task) => `${task.id}:${task.version}`).join(',');
  const scoped = useMemo(() => (state.tasks ?? []).filter((task) => !projectId || task.projectId === projectId), [state.tasks, projectId]);
  const listed = mode === 'daily' ? daily?.tasks ?? [] : scoped;
  const rows = listed.filter((task) => (!status || task.status === status) && `${task.title} ${task.description} ${task.assignee ?? ''}`.toLowerCase().includes(query.toLowerCase()));
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
  useEffect(() => { if (focusTaskId) setSelectedId(focusTaskId); }, [focusTaskId]);
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

  const saved = async (task: Task) => {
    setForm(null); setSelectedId(task.id); setTick((value) => value + 1);
    try { await onChanged(); notify('任务记录已保存。'); }
    catch { notify('任务已保存，但列表未能刷新，请重新读取工作区。', true); }
  };
  const activeCount = listed.filter((task) => ['todo', 'in_progress', 'blocked'].includes(task.status)).length;
  return <div className="work-page">
    <div className="work-page-heading"><div><div className="eyebrow">{mode === 'daily' ? '按日期安排与回看' : '项目执行与交付跟进'}</div><h2>{mode === 'daily' ? '每日清单' : '任务'}</h2><p>{mode === 'daily' ? '清单按所选日期的任务快照展示，未结事项会保留。' : '任务池展示当前状态，未安排日期的事项也保留在这里。'}</p></div><div className="work-heading-actions">{mode === 'daily' && <button className="button secondary" onClick={() => { setPlanTask(null); setForm('plan'); }} disabled={!state.tasks?.some((task) => ['todo', 'in_progress', 'blocked'].includes(task.status))}><CalendarPlus size={15} />加入清单</button>}<button className="button primary" onClick={() => setForm('create')} disabled={!state.projects.length}><Plus size={15} />新建任务</button></div></div>
    <WorkFilters day={day} onDayChange={setDay} projects={state.projects} projectId={projectId} onProjectChange={setProjectId}><select aria-label="筛选任务状态" value={status} onChange={(event) => setStatus(event.target.value as TaskStatus | '')}><option value="">全部状态</option>{Object.entries(TASK_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></WorkFilters>
    <div className="work-layout"><section className="task-list-panel"><div className="task-list-toolbar"><div><strong>{rows.length}</strong> 项{mode === 'daily' ? '日期内事项' : '任务'}<span>·</span>{activeCount} 项未结</div><label><Search size={14} /><input aria-label="查找任务" placeholder="查找任务或负责人…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
      {mode === 'daily' && <p className="work-scope-note">截至 {day} 的快照。点击任务可查看当前状态与完整历史。</p>}
      {loading ? <div className="loading-view"><Spinner />正在读取日期内的任务…</div> : error ? <WorkEmpty title="清单暂时无法读取" action={<button className="button secondary" onClick={() => setTick((value) => value + 1)}>重新读取</button>}>{error}</WorkEmpty> : !rows.length ? <WorkEmpty title={query || status ? '没有符合筛选的任务' : mode === 'daily' ? '这一天还没有安排事项' : '还没有任务'} action={<button className="button secondary" onClick={() => setForm('create')} disabled={!state.projects.length}><Plus size={15} />新建任务</button>}>{mode === 'daily' ? '可将任务加入这一天的清单，或记录当天实际发生的进展。' : '无需模型密钥，可以直接创建、安排并跟进任务。'}</WorkEmpty> : <div className="task-table"><div className="task-table-head"><span>任务 / 负责人</span><span>截止日期</span><span>状态</span></div>{rows.map((task) => {
        const overdue = !!task.dueDate && task.dueDate < day && ['todo', 'in_progress', 'blocked'].includes(task.status);
        return <button key={task.id} className={`task-row ${selectedId === task.id ? 'task-row-selected' : ''}`} onClick={() => setSelectedId(task.id)}><div className="task-row-main"><div className="task-row-title">{task.priority === 'high' && <span className="priority-high">高</span>}<strong>{task.title}</strong></div><div className="task-row-meta"><span>{TASK_CATEGORY[task.category]}</span><span>{task.assignee || '负责人待确认'}</span>{!projectId && <span>{state.projects.find((project) => project.id === task.projectId)?.name ?? '所属项目'}</span>}</div></div><div className={`task-row-due ${overdue ? 'task-overdue' : ''}`}>{task.dueDate ?? '未设截止日'}{overdue && <small>已逾期</small>}</div><div className="task-row-state"><TaskStatusLabel status={task.status} /><span>{task.progress}%</span></div></button>;
      })}</div>}
      {mode === 'daily' && <div className="daily-report-link"><span>日报只整理已记录的任务事件，不调用模型。</span><button className="text-button" onClick={onReport}>查看这一天的日报 <ArrowRight size={14} /></button></div>}
    </section><aside className="task-inspector">{detailLoading ? <div className="loading-view"><Spinner />正在读取任务…</div> : detailError ? <WorkEmpty title="任务暂时无法读取" action={<button className="button secondary" onClick={() => setTick((value) => value + 1)}>重试</button>}>{detailError}</WorkEmpty> : !detail ? <WorkEmpty title="选择一个任务">查看当前进度、原文依据与每次变化。</WorkEmpty> : <>
      <div className="task-detail-heading"><div className="eyebrow">当前任务 · v{detail.task.version}</div><h3>{detail.task.title}</h3><div className="task-detail-status"><TaskStatusLabel status={detail.task.status} /><span>{detail.task.progress}%</span></div>{mode === 'daily' && selectedSnapshot && selectedSnapshot.version !== detail.task.version && <p className="task-history-notice">清单显示 v{selectedSnapshot.version} 的历史快照；这里显示当前 v{detail.task.version}，不会改写过去记录。</p>}<div className="task-detail-actions"><button className="button primary compact" onClick={() => setForm('edit')}><PencilLine size={13} />更新进度</button><button className="button secondary compact" onClick={() => { setPlanTask(detail.task); setForm('plan'); }}><CalendarPlus size={13} />安排日期</button></div></div>
      <dl className="task-attributes"><div><dt>项目</dt><dd>{state.projects.find((project) => project.id === detail.task.projectId)?.name}</dd></div><div><dt>责任类型</dt><dd>{TASK_CATEGORY[detail.task.category]}</dd></div><div><dt>负责人</dt><dd>{detail.task.assignee || '待确认'}</dd></div><div><dt>优先级</dt><dd>{TASK_PRIORITY[detail.task.priority]}</dd></div><div><dt>计划日期</dt><dd>{detail.task.plannedDate || '未安排'}</dd></div><div><dt>截止日期</dt><dd>{detail.task.dueDate || '未设置'}</dd></div></dl>
      {detail.task.description && <div className="task-description"><h4>任务说明</h4><p>{detail.task.description}</p></div>}
      <div className="task-source-section"><h4>任务原始依据</h4>{detail.evidence.length ? detail.evidence.map((evidence) => <div className="task-evidence" key={evidence.segmentId}><strong>{evidence.sourceTitle}</strong><p>{evidence.text}</p><button className="text-button tiny" onClick={() => onEvidence(evidence)}>{evidence.locator} <ArrowRight size={12} /></button></div>) : <p className="panel-hint">{detail.task.memoryId ? `关联记忆 v${detail.task.memoryRevision}，该版本未引用原文。` : '手动创建，未附加原文依据。'}</p>}</div>
      <div className="task-event-section"><h4><History size={14} />进度历史</h4>{detail.events.map((event) => <div className="task-event" key={event.id}><div className="task-event-meta"><strong>{event.workDate}</strong><span>v{event.version}</span></div><div className="task-event-change">{event.before ? `${TASK_STATUS[event.before.status]} ${event.before.progress}% → ` : '创建 → '}{TASK_STATUS[event.after.status]} {event.after.progress}%</div><p>{event.note}</p>{event.evidence.map((evidence) => <button key={evidence.segmentId} className="text-button tiny" onClick={() => onEvidence(evidence)}><FileText size={11} />{evidence.sourceTitle} · {evidence.locator}</button>)}<small>记录于 {formatMoment(event.recordedAt)}</small></div>)}</div>
    </>}</aside></div>
    {(form === 'create' || form === 'edit') && <TaskFormDialog task={form === 'edit' ? detail?.task ?? null : null} latestWorkDate={form === 'edit' ? detail?.events[0]?.workDate : undefined} projects={state.projects} projectId={projectId} workDate={day} plannedDate={mode === 'daily' && form === 'create' ? day : null} close={() => setForm(null)} onSaved={saved} />}
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
  const [draft, setDraft] = useState({ projectId: task?.projectId ?? memory?.projectId ?? (projectId || projects[0]?.id || ''), title: task?.title ?? (memory?.content.slice(0, 300) ?? ''), description: task?.description ?? memory?.content ?? '', category: task?.category ?? 'action' as TaskCategory, assignee: task?.assignee ?? '', priority: task?.priority ?? 'medium' as TaskPriority, status: task?.status ?? 'todo' as TaskStatus, progress: task?.progress ?? 0, dueDate: task?.dueDate ?? '', plannedDate: task?.plannedDate ?? plannedDate ?? '', workDate, note: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const patch = (value: Partial<typeof draft>) => { requestId.current = crypto.randomUUID(); setDraft((current) => ({ ...current, ...value })); setError(''); };
  const invalidDate = !!task && !!baseWorkDate && draft.workDate < baseWorkDate;
  return <Dialog title={task ? '更新任务与进度' : '新建任务'} subtitle={task ? `基于当前版本 v${task.version} 保存，每次改动会记录原因。` : memory ? `关联项目记忆 v${memory.revision}，保留该版本的原文依据。` : '手动记录，无需配置模型或提供密钥。'} close={close} busy={busy} wide><form onSubmit={async (event) => {
    event.preventDefault(); if (!draft.title.trim() || !draft.workDate || invalidDate) return; setBusy(true); setError('');
    try {
      const fields = { title: draft.title.trim(), description: draft.description.trim(), category: draft.category, assignee: draft.assignee.trim() || null, priority: draft.priority, status: draft.status, progress: draft.progress, dueDate: draft.dueDate || null, plannedDate: draft.plannedDate || null, workDate: draft.workDate, clientRequestId: requestId.current };
      const result = task ? await execute<Task>('update_task', { ...fields, taskId: task.id, baseVersion: task.version, note: draft.note.trim() }) : await execute<Task>('create_task', { ...fields, projectId: draft.projectId, ...(memory ? { memoryId: memory.id } : {}) });
      await onSaved(result);
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(false); }
  }}><div className="dialog-body task-form-body">
    {!task && <><label className="field-label" htmlFor="task-project">所属项目</label><select id="task-project" value={draft.projectId} onChange={(event) => patch({ projectId: event.target.value })} disabled={busy || !!memory} required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></>}
    <label className={`field-label ${!task ? 'spaced' : ''}`} htmlFor="task-title">任务标题</label><input id="task-title" value={draft.title} onChange={(event) => patch({ title: event.target.value })} required maxLength={300} disabled={busy} placeholder="写清楚需要交付或推进的具体结果" />
    <label className="field-label spaced" htmlFor="task-description">任务说明 <span>可选</span></label><textarea id="task-description" rows={3} value={draft.description} onChange={(event) => patch({ description: event.target.value })} maxLength={10000} disabled={busy} />
    <div className="task-form-grid"><label><span className="field-label">责任类型</span><select aria-label="任务责任类型" value={draft.category} onChange={(event) => patch({ category: event.target.value as TaskCategory })} disabled={busy}>{Object.entries(TASK_CATEGORY).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span className="field-label">负责人</span><input aria-label="任务负责人" value={draft.assignee} onChange={(event) => patch({ assignee: event.target.value })} disabled={busy} placeholder="未确认可留空" maxLength={300} /></label><label><span className="field-label">优先级</span><select aria-label="任务优先级" value={draft.priority} onChange={(event) => patch({ priority: event.target.value as TaskPriority })} disabled={busy}>{Object.entries(TASK_PRIORITY).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span className="field-label">状态</span><select aria-label="任务状态" value={draft.status} onChange={(event) => patch({ status: event.target.value as TaskStatus, ...(event.target.value === 'done' ? { progress: 100 } : {}) })} disabled={busy}>{Object.entries(TASK_STATUS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span className="field-label">进度（%）</span><input aria-label="任务进度百分比" type="number" min={0} max={100} step={1} value={draft.progress} onChange={(event) => patch({ progress: Number(event.target.value) })} disabled={busy || draft.status === 'done'} required /></label><label><span className="field-label">截止日期</span><input aria-label="任务截止日期" type="date" value={draft.dueDate} onChange={(event) => patch({ dueDate: event.target.value })} disabled={busy} /></label><label><span className="field-label">加入清单日期</span><input aria-label="任务计划日期" type="date" value={draft.plannedDate} onChange={(event) => patch({ plannedDate: event.target.value })} disabled={busy} /></label><label><span className="field-label">本次记录发生日期</span><input aria-label="任务记录发生日期" type="date" value={draft.workDate} min={task ? baseWorkDate : undefined} onChange={(event) => patch({ workDate: event.target.value })} required disabled={busy} /></label></div>
    <p className="field-hint">“亲自执行”与“跟进交付”由你选择，不根据负责人姓名推断。进度 100% 不会自动改为完成。</p>
    {task && <><label className="field-label spaced" htmlFor="task-note">本次进展与修改原因 <span>必填</span></label><textarea id="task-note" rows={3} value={draft.note} onChange={(event) => patch({ note: event.target.value })} placeholder="记录实际发生的变化、当前阻塞或调整原因" required maxLength={10000} disabled={busy} /></>}
    {invalidDate && <div className="form-error"><CircleAlert size={17} /><p>该任务已有 {baseWorkDate} 的进度。新的记录日期不能早于它；过去的快照会继续保留。</p></div>}{error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
    {task && <div className="revision-version-check"><span>基于 v{task.version} 编辑，版本冲突时需重新核对。重新载入会替换上方任务字段，保留原因文字。</span><button type="button" className="text-button tiny" disabled={busy} onClick={async () => { setBusy(true); try { const current = await execute<TaskDetail>('get_task', { taskId: task.id }); setTask(current.task); setBaseWorkDate(current.events[0]?.workDate); setDraft((value) => ({ ...value, ...taskFields(current.task), assignee: current.task.assignee ?? '', dueDate: current.task.dueDate ?? '', plannedDate: current.task.plannedDate ?? '' })); requestId.current = crypto.randomUUID(); setError(''); } catch (caught) { setError(asError(caught).message); } finally { setBusy(false); } }}>重新载入当前任务字段</button></div>}
  </div><div className="dialog-footer"><span className="footer-note">{task ? `校验版本 v${task.version}` : '保存后建立任务历史'}</span><button type="button" className="button secondary" onClick={close} disabled={busy}>取消</button><button className="button primary" disabled={busy || invalidDate || !draft.title.trim() || !draft.projectId || !draft.workDate || (!!task && !draft.note.trim())}>{busy ? <Spinner /> : <Check size={15} />}{task ? '保存进展' : '创建任务'}</button></div></form></Dialog>;
}

function PlanDialog({ tasks, initialTask, day, close, onSaved }: { tasks: Task[]; initialTask: Task | null; day: string; close: () => void; onSaved: (task: Task) => Promise<void> }) {
  const [taskId, setTaskId] = useState(initialTask?.id ?? tasks[0]?.id ?? '');
  const [plannedDate, setPlannedDate] = useState(day); const [workDate, setWorkDate] = useState(localDay());
  const [note, setNote] = useState(`安排到 ${day} 的工作清单`); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const pendingPayload = useRef<Record<string, unknown> | null>(null);
  const touch = () => { requestId.current = crypto.randomUUID(); pendingPayload.current = null; setError(''); };
  return <Dialog title="加入某天的清单" subtitle="安排日期与实际记录日期分开保存。" close={close} busy={busy}><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!pendingPayload.current) {
        const current = await execute<TaskDetail>('get_task', { taskId });
        if (['done', 'cancelled'].includes(current.task.status)) throw new Error('该任务当前已完成或取消，请先核对最新状态。');
        pendingPayload.current = { taskId, baseVersion: current.task.version, ...taskFields(current.task), plannedDate, note: note.trim(), workDate, clientRequestId: requestId.current };
      }
      const result = await execute<Task>('update_task', pendingPayload.current); await onSaved(result);
    }
    catch (caught) { setError(asError(caught).message); } finally { setBusy(false); }
  }}><div className="dialog-body"><label className="field-label" htmlFor="plan-task">选择任务</label><select id="plan-task" value={taskId} required disabled={busy || !!initialTask} onChange={(event) => { setTaskId(event.target.value); touch(); }}>{(initialTask ? [initialTask] : tasks).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><label className="field-label spaced" htmlFor="plan-day">加入清单日期</label><input id="plan-day" type="date" value={plannedDate} required onChange={(event) => { setPlannedDate(event.target.value); touch(); }} disabled={busy} /><label className="field-label spaced" htmlFor="plan-work-date">本次记录发生日期</label><input id="plan-work-date" type="date" value={workDate} required onChange={(event) => { setWorkDate(event.target.value); touch(); }} disabled={busy} /><label className="field-label spaced" htmlFor="plan-note">安排说明</label><textarea id="plan-note" rows={2} value={note} required maxLength={10000} onChange={(event) => { setNote(event.target.value); touch(); }} disabled={busy} />{error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}</div><div className="dialog-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !taskId || !plannedDate || !workDate || !note.trim()}>{busy ? <Spinner /> : <CalendarPlus size={15} />}保存安排</button></div></form></Dialog>;
}
