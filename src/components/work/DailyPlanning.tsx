import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, GitBranch, ListChecks, RefreshCw } from 'lucide-react';
import { asError, execute } from '../../api';
import { TASK_STATUS, type Task, type TaskStatus } from '../../types';
import { Dialog, Spinner } from '../ui';
import { localDay } from './shared';
import './daily-focus.css';

type Citation = { refId: string; quote: string; label?: string };
type Change = { id: string; kind: string; taskId?: string | null; targetId?: string | null; proposalId?: string; memoryId?: string; title?: string; proposalPreview?: { title: string; description: string; assignee: string | null; dueDate: string | null; dueText: string | null; taskStatus: string; progress: number | null }; memoryPreview?: { content: string }; minutes?: number; reason: string; evidence: Citation[] };
type PlanItem = { taskId: string; title: string; category: string; minutes: number; reason: string; assumed?: boolean; beforeDate: string | null; afterDate: string | null; conditionalOn?: string[] };
type Schedule = { date: string; capacityMinutes: number; bufferMinutes: number; reservedMinutes: number; availableMinutes: number; scheduledMinutes: number; remainingMinutes: number; warning: string | null; note: string; items: PlanItem[]; deferred: PlanItem[]; commitments: Array<{ taskId: string; title: string; minutes: number; reason: string }>; durationOverrides: Record<string, number>; skipTaskIds: string[] };
type Analysis = { changes: Change[]; method: string; model?: string; note: string };
export type PlanningDraft = { id: string; kind: 'analysis' | 'schedule'; status: string; stale: boolean; createdAt: string; result: Analysis | Schedule };
type Relation = { id: string; kind: string; taskId: string; targetId: string | null; reason: string; active: boolean; createdAt: string; evidence: Citation[] };
export interface PlanningOverview {
  date: string; projectId: string | null;
  capacity: { date: string; minutes: number; bufferMinutes: number; revision: string } | null;
  tasks: Task[]; estimates: Array<{ taskId: string; minutes: number; reason: string; updatedAt: string }>;
  relations: Relation[]; allocations: Array<{ taskId: string; minutes: number; position: number; reason: string; draftId: string }>;
  drafts: PlanningDraft[]; confirmedPlan: { id: string; result: Schedule; createdAt: string } | null;
  context: { taskCount: number; proposalCount: number; memoryCount: number; sourceSegmentCount: number; truncated: boolean }; modelAvailable: boolean;
}
const labels: Record<string, string> = { merge: '归并重复任务', proposal: '核对原文任务', memory_task: '从记忆建立跟进', dependency: '确认前置依赖', blocker: '确认阻塞', estimate: '确认预计用时' };
const mins = (n: number) => `${n} 分钟`;

export function DailyPlanning({ day, projectId, tasks, onChanged, onOverview }: { day: string; projectId: string; tasks: Task[]; onChanged: () => Promise<unknown>; onOverview: (data: PlanningOverview) => void }) {
  const [data, setData] = useState<PlanningOverview | null>(null);
  const [minutes, setMinutes] = useState(''); const [buffer, setBuffer] = useState('0');
  const [capacityBase, setCapacityBase] = useState<string | null>(null);
  const [useModel, setUseModel] = useState(true);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<PlanningDraft | null>(null);
  const [remove, setRemove] = useState<Relation | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [relationKind, setRelationKind] = useState('dependency'); const [from, setFrom] = useState(''); const [target, setTarget] = useState(''); const [reason, setReason] = useState('');
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const alive = useRef(true); const initial = useRef(false); const sequence = useRef(0); const polling = useRef(false);
  const onOverviewRef = useRef(onOverview); onOverviewRef.current = onOverview;
  const scope = { date: day, ...(projectId ? { projectId } : {}) };
  const refresh = useCallback(async () => {
    const run = ++sequence.current;
    const next = await execute<PlanningOverview>('get_daily_planning', { date: day, ...(projectId ? { projectId } : {}) });
    if (!alive.current || run !== sequence.current) return;
    setData(next); onOverviewRef.current(next);
    if (!initial.current) { initial.current = true; setMinutes(next.capacity ? String(next.capacity.minutes) : ''); setBuffer(String(next.capacity?.bufferMinutes ?? 0)); setCapacityBase(next.capacity?.revision ?? null); setUseModel(next.modelAvailable); }
  }, [day, projectId]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => { if (alive.current) setError(asError(e).message); });
    const timer = window.setInterval(() => {
      if (polling.current || document.visibilityState !== 'visible') return;
      polling.current = true;
      void refresh().catch((e) => { if (alive.current) setError(asError(e).message); }).finally(() => { polling.current = false; });
    }, 7000);
    return () => { alive.current = false; sequence.current++; window.clearInterval(timer); };
  }, [refresh]);
  const action = async (name: string, op: () => Promise<void>) => {
    if (busy) return; setBusy(name); setError(''); setNotice('');
    try { await op(); if (alive.current) { await refresh(); await onChanged(); } } catch (caught) { if (alive.current) setError(asError(caught).message); } finally { if (alive.current) setBusy(''); }
  };
  const historical = day < localDay();
  const capacityDirty = !!data && (minutes !== (data.capacity ? String(data.capacity.minutes) : '') || buffer !== String(data.capacity?.bufferMinutes ?? 0));
  const capacityValid = minutes !== '' && Number.isInteger(Number(minutes)) && Number(minutes) >= 0 && Number(minutes) <= 960 && buffer !== '' && Number.isInteger(Number(buffer)) && Number(buffer) >= 0 && Number(buffer) <= Number(minutes);
  const names = new Map(tasks.map((t) => [t.id, t.title]));
  const currentRelations = data?.relations.filter((r) => r.active && r.kind !== 'merge' && data.tasks.some((t) => t.id === r.taskId)) ?? [];
  const pendingDrafts = data?.drafts.filter((item) => item.status === 'pending') ?? [];
  const openDraft = async (command: string, payload: Record<string, unknown>) => {
    const next = await execute<PlanningDraft>(command, payload); if (alive.current) setDraft(next);
  };
  const approved = async () => { setDraft(null); setNotice('已应用所选变更。'); await refresh(); await onChanged(); };
  const freshDrafts = pendingDrafts.filter((item) => !item.stale);
  const latestDraft = freshDrafts[0];
  const availableMinutes = data?.capacity ? data.capacity.minutes - data.capacity.bufferMinutes : null;
  return <section className={`daily-planning daily-focus ${expanded ? 'daily-planning-expanded' : ''}`} aria-label="时间与排期">
    <div className="planning-heading">
      <div className="daily-focus-heading">
        <h3><ListChecks size={17} />时间与排期</h3>
        <p>{availableMinutes !== null ? <><strong>可排 {mins(availableMinutes)}</strong><span>{freshDrafts.length ? `${freshDrafts.length} 份草案待确认` : pendingDrafts.length ? '草案需重新生成' : data?.confirmedPlan ? `已安排 ${mins(data.confirmedPlan.result.scheduledMinutes)}` : '时间已设置，可以开始排期'}</span></> : historical ? '这一天未设置可用时间。' : '设置可用时间，再安排任务。'}</p>
      </div>
      <div className="planning-heading-actions">
        {data?.confirmedPlan && !pendingDrafts.length && <span className="planning-confirmed"><Check size={13} />已确认</span>}
        {!expanded && !historical && <button className={`button ${latestDraft ? 'primary' : 'secondary'} compact`} disabled={!!busy || !data} onClick={() => {
          if (latestDraft) { setDraft(latestDraft); return; }
          if (!data?.capacity || capacityDirty) { setExpanded(true); return; }
          void action('schedule', () => openDraft('generate_daily_plan', scope));
        }}>{busy === 'schedule' ? <Spinner /> : latestDraft ? <Check size={13} /> : <ListChecks size={14} />}{latestDraft ? '核对草案' : data?.capacity ? data.confirmedPlan ? '重新排期' : '生成排期草案' : '设置可用时间'}</button>}
        {(expanded || historical || data?.capacity || latestDraft) && <button className="text-button tiny daily-focus-toggle" aria-expanded={expanded} aria-controls="daily-planning-controls" onClick={() => setExpanded(!expanded)}>{expanded ? '收起设置' : historical ? '查看排期' : '调整设置'}<ChevronDown size={13} /></button>}
      </div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="planning-notice" role="status">{notice}</p>}
    {expanded && <div id="daily-planning-controls" className="planning-controls">
    <div className="planning-capacity"><label>当天可用时间<span className="daily-focus-input"><input aria-label="每日可用分钟" type="number" min={0} max={960} placeholder="例如 480" value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={!!busy || historical} /><span>分钟</span></span></label><label>会议与临时事项<span className="daily-focus-input"><input aria-label="预留分钟" type="number" min={0} max={Number(minutes) || 960} value={buffer} onChange={(e) => setBuffer(e.target.value)} disabled={!!busy || historical} /><span>分钟</span></span></label><div><span>留给任务 <strong>{capacityValid ? mins(Number(minutes) - Number(buffer)) : '待填写'}</strong></span><button className={`button ${capacityDirty ? 'primary' : 'secondary'} compact`} disabled={!!busy || historical || !capacityValid || !capacityDirty} onClick={() => void action('capacity', async () => { const next = await execute<NonNullable<PlanningOverview['capacity']>>('save_daily_capacity', { date: day, minutes: Number(minutes), bufferMinutes: Number(buffer), baseRevision: capacityBase }); setCapacityBase(next.revision); setMinutes(String(next.minutes)); setBuffer(String(next.bufferMinutes)); setNotice('可用时间已保存。'); })}>{busy === 'capacity' && <Spinner />}保存时间</button></div></div>
    {data?.capacity && data.capacity.revision !== capacityBase && <p className="planning-warning">可用时间已更新，请先<button className="text-button tiny" onClick={() => { setMinutes(String(data.capacity!.minutes)); setBuffer(String(data.capacity!.bufferMinutes)); setCapacityBase(data.capacity!.revision); }}>加载最新设置</button>再编辑。</p>}
    <div className="planning-actions daily-focus-generate"><button className={`button ${capacityDirty ? 'secondary' : 'primary'} compact`} disabled={!!busy || historical || !data?.capacity || capacityDirty} onClick={() => void action('schedule', () => openDraft('generate_daily_plan', scope))}>{busy === 'schedule' ? <Spinner /> : <ListChecks size={14} />}生成排期草案</button><p className="planning-context">{!data?.capacity || capacityDirty ? '先保存时间，即可生成草案。' : '核对并确认后，才会更新任务安排。'}</p></div>
    {pendingDrafts.length > 0 && <div className="planning-drafts daily-focus-drafts"><span>待确认草案</span>{pendingDrafts.slice(0, 4).map((d) => <button key={d.id} className="text-button tiny" onClick={() => setDraft(d)} disabled={!!busy}>{d.kind === 'analysis' ? '任务整理' : '时间排期'}{d.stale ? ' · 已过期' : ''}</button>)}</div>}
    <details className="planning-details daily-focus-advanced"><summary>整理任务、依赖与用时<ChevronDown size={13} /></summary>
    <p className="planning-context">发现重复任务、前置依赖或阻塞时，在这里调整。</p>
    <div className="planning-actions daily-focus-secondary-actions"><button className="button secondary compact" disabled={!!busy || historical || !data} onClick={() => void action('analysis', () => openDraft('analyze_task_workload', { ...scope, useModel }))}>{busy === 'analysis' ? <Spinner /> : <GitBranch size={14} />}整理任务与依赖</button><button className="text-button tiny" disabled={!!busy || historical || !data?.tasks.length} onClick={() => setShowManual(!showManual)} aria-expanded={showManual}>{showManual ? '收起关系设置' : '手动添加依赖或阻塞'}</button></div>
    {data && <details className="planning-details"><summary>分析设置与参考资料<ChevronDown size={13} /></summary><label className="planning-model"><input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} disabled={!!busy || !data.modelAvailable} />使用 AI 结合飞书资料与项目记忆整理任务</label><p className="planning-context">{data.context.taskCount} 项未完成任务 · {data.context.proposalCount} 条待确认任务 · {data.context.memoryCount} 条项目记忆 · {data.context.sourceSegmentCount} 段飞书资料{data.context.truncated ? '。仅使用最近资料，建议按项目核对。' : ''}{!data.modelAvailable ? '。配置模型后可启用 AI 分析。' : ''}</p></details>}
    {showManual && data && <div className="planning-manual"><div className="planning-form-grid"><label>关系类型<select aria-label="填写关系类型" value={relationKind} onChange={(e) => setRelationKind(e.target.value)}><option value="dependency">前置依赖</option><option value="blocker">具体阻塞</option></select></label><label>需要推进的任务<select aria-label="关系任务" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">请选择</option>{data.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>{relationKind === 'dependency' && <label>必须先完成的任务<select aria-label="前置任务" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">请选择</option>{data.tasks.filter((t) => t.id !== from && t.projectId === data.tasks.find((t) => t.id === from)?.projectId).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}</div><label>依赖或阻塞说明<textarea aria-label="关系理由" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：完成接口交付后才能联调" /></label><button className="button secondary compact" disabled={!!busy || !from || !reason.trim() || (relationKind === 'dependency' && !target)} onClick={() => void action('manual', () => openDraft('preview_task_relation', { ...scope, kind: relationKind, taskId: from, targetId: relationKind === 'dependency' ? target : null, reason: reason.trim() }))}>预览变更</button></div>}
    {!!currentRelations.length && <details className="planning-details"><summary>已确认依赖与阻塞 · {currentRelations.length}<ChevronDown size={13} /></summary>{currentRelations.map((r) => <div className="planning-relation" key={r.id}><strong>{names.get(r.taskId)}{r.kind === 'dependency' ? ` ← 等待 ${names.get(r.targetId ?? '') ?? '前置任务'}` : ' · 存在阻塞'}</strong><p>{r.reason}</p><button className="text-button tiny" disabled={!!busy || historical} onClick={() => setRemove(r)}>解除此关系</button></div>)}</details>}
    {!!data?.tasks.length && <details className="planning-details"><summary>任务预计用时<ChevronDown size={13} /></summary><p className="field-hint">填写你预计投入的时间。跟进交付只计沟通用时；未填写时会使用临时估算。</p>{data.tasks.map((task) => { const current = data.estimates.find((e) => e.taskId === task.id); return <div className="planning-effort" key={task.id}><span>{task.title}<small>{task.category === 'follow_up' ? '跟进交付' : '亲自执行'}</small></span><input type="number" aria-label={`${task.title} 预计分钟`} min={5} max={1440} placeholder={current ? String(current.minutes) : '未估时'} value={efforts[task.id] ?? (current ? String(current.minutes) : '')} onChange={(e) => setEfforts({ ...efforts, [task.id]: e.target.value })} disabled={!!busy || historical} /><button className="text-button tiny" disabled={!!busy || historical || !(Number(efforts[task.id]) >= 5)} onClick={() => void action(task.id, async () => { await execute('save_task_estimate', { taskId: task.id, baseVersion: task.version, baseUpdatedAt: current?.updatedAt ?? null, minutes: Number(efforts[task.id]) }); setNotice('预计用时已保存，可重新生成排期。'); })}>保存用时</button></div>; })}</details>}
    </details>
    {data?.confirmedPlan && <div className="planning-approved-summary">本次安排 {mins(data.confirmedPlan.result.scheduledMinutes)} · 其他安排与已完成事项 {mins(data.confirmedPlan.result.reservedMinutes)} · 预留 {mins(data.confirmedPlan.result.bufferMinutes)}</div>}
    {historical && <p className="field-hint">历史排期仅供查看。</p>}
    </div>}
    {draft && <PlanningReview key={draft.id} draft={draft} tasks={tasks} overview={data} close={() => setDraft(null)} onApproved={approved} regenerate={(extra) => execute<PlanningDraft>('generate_daily_plan', { ...scope, ...extra })} />}
    {remove && <Dialog title="确认解除关系" subtitle="解除后，新的排期建议会重新判断任务是否具备条件。" close={() => setRemove(null)} busy={!!busy}><div className="dialog-body"><strong>{names.get(remove.taskId)}</strong><p>{remove.reason}</p><p className="field-hint">只解除这一条关系，已有任务状态和其他阻塞原因保留。若任务仍标记为阻塞，需在任务中核实并更新状态。</p></div><div className="dialog-footer"><button className="button secondary" disabled={!!busy} onClick={() => setRemove(null)}>保留</button><button className="button primary" disabled={!!busy} onClick={() => void action('remove', async () => { await execute('remove_task_relation', { relationId: remove.id, createdAt: remove.createdAt }); setRemove(null); setNotice('关系已解除，可重新试排。'); })}>确认解除</button></div></Dialog>}
  </section>;
}

function PlanningReview({ draft: initial, tasks, overview, close, onApproved, regenerate }: { draft: PlanningDraft; tasks: Task[]; overview: PlanningOverview | null; close: () => void; onApproved: () => Promise<void>; regenerate: (extra: Record<string, unknown>) => Promise<PlanningDraft> }) {
  const [draft, setDraft] = useState(initial); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({}); const [skips, setSkips] = useState<Set<string>>(new Set(draft.kind === 'schedule' ? (draft.result as Schedule).skipTaskIds : []));
  const names = new Map(tasks.map((t) => [t.id, t.title])); const byId = new Map(tasks.map((t) => [t.id, t]));
  const stale = draft.stale || !!overview?.drafts.find((d) => d.id === draft.id)?.stale;
  const schedule = draft.kind === 'schedule' ? draft.result as Schedule : null; const analysis = draft.kind === 'analysis' ? draft.result as Analysis : null;
  const dirty = Object.keys(overrides).length > 0 || (!!schedule && JSON.stringify([...skips].sort()) !== JSON.stringify([...schedule.skipTaskIds].sort()));
  const toggle = (id: string) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const changeTitle = (c: Change) => c.kind === 'merge' ? `${names.get(c.taskId ?? '')} → ${names.get(c.targetId ?? '')}` : c.kind === 'dependency' ? `${names.get(c.taskId ?? '')} 必须等待 ${names.get(c.targetId ?? '')}` : c.kind === 'proposal' ? (c.taskId ? `将原文任务关联到：${names.get(c.taskId)}` : '从原文候选建立新跟进任务') : c.kind === 'memory_task' ? c.title : `${names.get(c.taskId ?? '')}${c.kind === 'estimate' ? ` · ${c.minutes} 分钟` : ''}`;
  const act = async (op: () => Promise<void>) => { setBusy(true); setError(''); try { await op(); } catch (e) { setError(asError(e).message); } finally { setBusy(false); } };
  const renderItem = (item: PlanItem, index: number, deferred: boolean) => <article className={`planning-item ${deferred ? 'planning-item-deferred' : ''}`} key={item.taskId}>
    <div className="planning-item-heading"><strong>{deferred ? '' : `${index + 1}. `}{item.title}</strong><span className="daily-focus-duration">{mins(Number(overrides[item.taskId] ?? item.minutes))}</span></div>
    <p className="daily-focus-item-reason">{item.reason}</p>
    <div className="daily-focus-item-meta"><span>{item.category === 'follow_up' ? '跟进交付' : '亲自执行'}</span><span>{item.beforeDate ?? '未安排'} → {item.afterDate ?? '保留在任务池'}</span>{item.assumed && <span>用时为临时估算</span>}</div>
    <details className="daily-focus-item-adjust"><summary>调整用时与安排<ChevronDown size={12} /></summary><div className="planning-item-fields"><label>预计占用（分钟）<input aria-label={`${item.title} 试排分钟`} type="number" min={5} max={1440} value={overrides[item.taskId] ?? String(item.minutes)} onChange={(e) => setOverrides({ ...overrides, [item.taskId]: e.target.value })} disabled={busy || stale} /></label><label className="planning-check"><input type="checkbox" checked={skips.has(item.taskId)} disabled={busy || stale} onChange={() => setSkips((old) => { const next = new Set(old); next.has(item.taskId) ? next.delete(item.taskId) : next.add(item.taskId); return next; })} />本次暂不安排</label></div></details>
  </article>;
  return <Dialog title={analysis ? '核对任务整理建议' : '核对排期草案'} subtitle={analysis ? '勾选需要应用的变更，确认前请核对依据。' : `${schedule?.date} · 先核对时间、先后关系和日期变化，再确认应用。`} close={close} busy={busy} wide>
    <div className="dialog-body planning-review daily-focus-review">{error && <p className="form-error" role="alert">{error}</p>}{stale && <p className="planning-warning">任务、资料或可用时间已更新，请关闭并重新生成草案。</p>}
      {analysis && <><p className="field-hint">{analysis.note}{analysis.model ? ` · ${analysis.model}` : ''}</p>{!analysis.changes.length && <p className="planning-empty">未发现需要归并或新增的关系。可以手动填写依赖、保存用时，再按容量试排。</p>}{analysis.changes.map((c) => <article className="planning-change" key={c.id}><label className="planning-check"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} disabled={busy || stale} /><strong>{labels[c.kind] ?? c.kind}</strong></label><h4>{changeTitle(c)}</h4><p>{c.reason}</p>{c.kind === 'merge' && <div className="planning-before-after"><span>来源：{byId.get(c.taskId ?? '')?.assignee ?? '负责人待确认'} · 截止 {byId.get(c.taskId ?? '')?.dueDate ?? '未设置'}</span><span>目标：{byId.get(c.targetId ?? '')?.assignee ?? '负责人待确认'} · 截止 {byId.get(c.targetId ?? '')?.dueDate ?? '未设置'}</span><p>确认后来源任务标记为已取消并注明归并目标，历史保留；目标任务负责人和日期保留，原有依赖随归并调整。</p></div>}{c.proposalPreview && <div className="planning-before-after"><strong>{c.proposalPreview.title}</strong><p>{c.proposalPreview.description}</p><p>负责人：{c.proposalPreview.assignee ?? '待确认'} · 截止：{c.proposalPreview.dueDate ?? c.proposalPreview.dueText ?? '未明确'}</p><p>状态：{c.taskId ? `${TASK_STATUS[byId.get(c.taskId)?.status as TaskStatus] ?? '未知'} / ${byId.get(c.taskId)?.progress ?? 0}% → ` : ''}{TASK_STATUS[c.proposalPreview.taskStatus as TaskStatus] ?? c.proposalPreview.taskStatus} / {c.proposalPreview.progress ?? (c.proposalPreview.taskStatus === 'done' ? 100 : c.taskId ? byId.get(c.taskId)?.progress ?? 0 : 0)}%</p></div>}{c.memoryPreview && <blockquote>{c.memoryPreview.content}</blockquote>}{c.kind === 'proposal' && <p className="planning-warning">{c.taskId ? '确认关联会应用原文候选中的状态与进度，其他任务字段保留。请核对候选原文。' : '确认后建立未排期的跟进任务，负责人和期限沿用原文候选；具体日期不明则保留待确认。'}</p>}{c.kind === 'memory_task' && <p className="field-hint">建立待办跟进，负责人、截止日和计划日留空，不代替你作出承诺。</p>}<details><summary>原文 / 任务依据</summary>{c.evidence.map((e, i) => <blockquote key={i}><small>{e.label ?? '原文依据'}</small><p>{e.quote}</p></blockquote>)}</details></article>)}<p className="field-hint">确认后的依赖与阻塞将用于后续排期。</p></>}
      {schedule && <>
        <div className="planning-budget daily-focus-budget"><div><span>本次安排</span><strong>{schedule.scheduledMinutes}<small>分钟</small></strong></div><div className="daily-focus-budget-context"><span>{schedule.items.length} 项任务 · 剩余 {mins(schedule.remainingMinutes)}</span><span>当天可用 {mins(schedule.capacityMinutes)} · 预留 {mins(schedule.bufferMinutes)}</span><span>其他安排与已完成 {mins(schedule.reservedMinutes)}</span></div></div>
        {schedule.warning && <p className="planning-warning">{schedule.warning}</p>}
        <p className="field-hint">{schedule.note}</p>
        {schedule.commitments.length > 0 && <details className="daily-focus-commitments"><summary>查看已占用的时间<ChevronDown size={12} /></summary>{schedule.commitments.map((c) => <p key={c.taskId}>{c.title} · {mins(c.minutes)} · {c.reason}</p>)}</details>}
        <h3>安排到这一天 <span className="daily-focus-count">{schedule.items.length}</span></h3>
        {schedule.items.length ? schedule.items.map((item, i) => renderItem(item, i, false)) : <p className="planning-empty">暂时没有满足时间与前置条件的任务。可展开下方事项，查看原因并调整。</p>}
        {schedule.deferred.length > 0 && <details className="daily-focus-deferred"><summary><span>未排入这一天 <span className="daily-focus-count">{schedule.deferred.length}</span></span><ChevronDown size={13} /></summary><p className="field-hint">保留在任务池，可查看原因或调整本次安排。</p>{schedule.deferred.map((item, i) => renderItem(item, i, true))}</details>}
        {dirty && <div className="daily-focus-retry"><p className="planning-warning">调整后需重新试排，再确认本次安排。</p><button className="button secondary compact" disabled={busy || stale} onClick={() => void act(async () => { const converted = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, Number(v)])); if (Object.values(converted).some((v) => !Number.isInteger(v) || v < 5 || v > 1440)) throw new Error('预计用时应为 5–1440 的整数分钟。'); const next = await regenerate({ durationOverrides: { ...schedule.durationOverrides, ...converted }, skipTaskIds: [...skips].sort() }); setDraft(next); setOverrides({}); setSkips(new Set((next.result as Schedule).skipTaskIds)); })}><RefreshCw size={13} />按调整重新试排</button></div>}
      </>}
    </div><div className="dialog-footer"><span className="field-hint">{analysis ? `已选择 ${selected.size} 项变更` : '确认后更新计划日期与预计用时'}</span><button className="button secondary" disabled={busy} onClick={() => void act(async () => { await execute('dismiss_planning_draft', { draftId: draft.id }); close(); })}>暂不采用</button><button className="button primary" disabled={busy || stale || (!!analysis && !selected.size) || (!!schedule && dirty)} onClick={() => void act(async () => { await execute('confirm_planning_draft', { draftId: draft.id, selectedIds: analysis ? [...selected].sort() : [] }); await onApproved(); })}>{busy ? <Spinner /> : <Check size={14} />}{analysis ? '确认所选变更' : '确认排期'}</button></div>
  </Dialog>;
}
