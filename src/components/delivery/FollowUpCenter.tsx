import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, CalendarClock, Check, Copy, History, PencilLine, Plus, RefreshCw } from 'lucide-react';
import { asError, execute } from '../../api';
import type { Task } from '../../types';
import { TASK_STATUS } from '../../types';
import { Dialog, Spinner } from '../ui';
import { formatMoment, localDay, shiftDay, WorkEmpty } from '../work/shared';
import { DeliveryError, DeliveryLoad, useAlive, useDeliveryQuery } from './shared';
import type { DeliveryProps, FollowUpCenterData, FollowUpItem, FollowUpReasonKind, FollowUpTaskState } from './types';
import './delivery.css';

const REASONS: Record<FollowUpReasonKind, string> = { overdue: '已逾期', due_soon: '即将到期', stale: '缺少更新', follow_up: '约定跟进' };

export function FollowUpCenter({ state, projectId, date, onChanged, onTaskOpen, notify }: DeliveryProps) {
  const query = useDeliveryQuery<FollowUpCenterData>('get_follow_up_center', date, projectId, state, true);
  const [selectedId, setSelectedId] = useState('');
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [reason, setReason] = useState<FollowUpReasonKind | ''>('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ kind: 'record' | 'snooze'; item: FollowUpItem } | null>(null);
  const [recordOther, setRecordOther] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const copyRequest = useRef(0);
  const alive = useAlive();
  const items = (query.data?.items ?? []).filter((item) => item.snoozed === showSnoozed && (!reason || item.reasons.some((entry) => entry.kind === reason)) && `${item.task.title} ${item.task.assignee ?? ''} ${item.projectName}`.toLowerCase().includes(search.toLowerCase()));
  const selected = items.find((item) => item.taskId === selectedId) ?? items[0];
  useEffect(() => { setSelectedId(''); setForm(null); setRecordOther(false); setCopyMessage(''); }, [projectId, date]);
  useEffect(() => { copyRequest.current += 1; setCopyMessage(''); setCopying(false); }, [selected?.taskId, selected?.draft, projectId, date]);
  const saved = async (message: string) => {
    setForm(null); setRecordOther(false); query.refresh();
    try { await onChanged(); notify(message); } catch { notify(`${message} 工作区刷新失败，请重试。`, true); }
  };
  const copyDraft = async () => {
    if (!selected) return;
    const requestId = ++copyRequest.current;
    setCopying(true); setCopyMessage('');
    try { await navigator.clipboard.writeText(selected.draft); if (alive.current && requestId === copyRequest.current) setCopyMessage('催办草稿已复制'); }
    catch {
      if (alive.current && requestId === copyRequest.current) {
        draftRef.current?.focus(); draftRef.current?.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch { /* The selected draft remains available for manual copying. */ }
        setCopyMessage(copied ? '催办草稿已复制' : '已选中草稿，请按 Ctrl+C 复制');
      }
    } finally { if (alive.current && requestId === copyRequest.current) setCopying(false); }
  };
  const counts = query.data?.counts;
  const history = query.data?.history.filter((entry) => entry.taskId === selected?.taskId) ?? [];
  const recordableTasks = state.tasks.filter((task) => !['done', 'cancelled'].includes(task.status) && (!projectId || task.projectId === projectId) && query.data?.taskStates.some((entry) => entry.taskId === task.id));
  const upcoming = (query.data?.taskStates ?? []).filter((entry) => entry.nextFollowUpDate && entry.nextFollowUpDate > date).sort((a, b) => a.nextFollowUpDate!.localeCompare(b.nextFollowUpDate!));
  return <div className="work-page delivery-page">
    <div className="work-page-heading"><div><div className="eyebrow">推进交付</div><h2>提醒与跟进</h2><p>集中处理到期、逾期、长期无更新和已约定的跟进事项。</p></div><div className="work-heading-actions"><button className="button secondary" onClick={query.refresh} disabled={query.loading}><RefreshCw size={14} />刷新提醒</button><button className="button primary" onClick={() => setRecordOther(true)} disabled={query.loading || !query.data || !recordableTasks.length}><Plus size={14} />记录跟进</button></div></div>
    <div className="delivery-scroll">
      <div className="delivery-runtime-note"><Bell size={14} /><span>按 {date} 评估当前记录。应用运行期间每分钟刷新，回到窗口时重新检查。</span></div>
      <DeliveryLoad loading={query.loading} error={query.error} retry={query.refresh} title="跟进事项" />
      {!query.loading && !query.error && <>
        {counts && <div className="delivery-metrics delivery-followup-metrics"><div><strong>{counts.actionable}</strong><span>当前待跟进</span></div><div className={counts.overdue ? 'delivery-warning' : ''}><strong>{counts.overdue}</strong><span>已逾期</span></div><div><strong>{counts.dueSoon}</strong><span>即将到期</span></div><div><strong>{counts.stale}</strong><span>缺少更新</span></div><div><strong>{counts.followUp}</strong><span>约定跟进</span></div></div>}
        <div className="delivery-followup-toolbar"><div className="delivery-segmented" aria-label="提醒处理状态"><button className={!showSnoozed ? 'active' : ''} aria-pressed={!showSnoozed} onClick={() => setShowSnoozed(false)}>待跟进 <span>{counts?.actionable ?? 0}</span></button><button className={showSnoozed ? 'active' : ''} aria-pressed={showSnoozed} onClick={() => setShowSnoozed(true)}>已暂缓 <span>{counts?.snoozed ?? 0}</span></button></div><div><select aria-label="筛选提醒原因" value={reason} onChange={(event) => setReason(event.target.value as FollowUpReasonKind | '')}><option value="">全部提醒原因</option>{Object.entries(REASONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input aria-label="搜索跟进事项" placeholder="搜索任务、负责人或项目" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
        {!items.length ? <WorkEmpty title={search || reason ? '没有匹配的跟进事项' : showSnoozed ? '没有暂缓的提醒' : '当前没有需要提醒的事项'} action={search || reason ? <button className="button secondary" onClick={() => { setReason(''); setSearch(''); }}>清除筛选</button> : undefined}>{search || reason ? '试试其他关键词或提醒原因。' : showSnoozed ? '暂缓的提醒会在指定日期自动恢复。' : '为任务设置截止日期，并持续记录进展；满足条件时会在这里提醒。'}</WorkEmpty> : <div className="delivery-followup-layout"><section className="delivery-followup-list" aria-label="跟进事项列表">{items.map((item) => <button key={item.taskId} className={`delivery-followup-row ${selected?.taskId === item.taskId ? 'selected' : ''}`} aria-pressed={selected?.taskId === item.taskId} onClick={() => setSelectedId(item.taskId)}><div className="delivery-followup-title"><strong>{item.task.title}</strong><span>{item.task.progress}%</span></div><p>{item.task.assignee || '负责人待定'} · {item.projectName}</p><div className="delivery-reason-tags">{item.reasons.map((entry) => <span key={entry.kind} className={entry.kind === 'overdue' ? 'delivery-warning' : ''}>{entry.label}</span>)}</div>{item.snoozed && <small>暂缓至 {item.snoozedUntil}</small>}{item.lastFollowUp && <small>上次跟进 {item.lastFollowUp.workDate}</small>}</button>)}</section>
          {selected && <aside className="delivery-followup-detail"><div className="delivery-section-heading"><div><div className="eyebrow">跟进详情</div><h3>{selected.task.title}</h3></div><button className="text-button" onClick={() => onTaskOpen(selected.taskId, selected.projectId)}>打开任务 <ArrowRight size={13} /></button></div><div className="delivery-profile-meta"><span>{selected.task.assignee || '负责人待定'}</span><span>{TASK_STATUS[selected.task.status]} · {selected.task.progress}%</span><span>截止 {selected.task.dueDate || '未设置'}</span></div><dl className="delivery-followup-dates"><div><dt>最近进展</dt><dd>{selected.lastProgressDate}</dd></div><div><dt>上次跟进</dt><dd>{selected.lastFollowUp?.workDate || '尚未跟进'}</dd></div><div><dt>下次跟进</dt><dd>{selected.nextFollowUpDate || '未约定'}</dd></div><div><dt>提醒状态</dt><dd>{selected.snoozed ? `暂缓至 ${selected.snoozedUntil}` : '待处理'}</dd></div></dl>
            <div className="delivery-followup-actions"><button className="button primary compact" onClick={() => setForm({ kind: 'record', item: selected })}><PencilLine size={13} />记录跟进</button><button className="button secondary compact" onClick={() => setForm({ kind: 'snooze', item: selected })}><CalendarClock size={13} />{selected.snoozed ? '调整暂缓' : '暂缓提醒'}</button></div>
            <section className="delivery-draft"><div className="delivery-section-heading"><h4>催办草稿</h4><button className="text-button" onClick={copyDraft} disabled={copying}>{copying ? <Spinner /> : copyMessage === '催办草稿已复制' ? <Check size={13} /> : <Copy size={13} />}{copyMessage === '催办草稿已复制' ? '已复制' : '复制草稿'}</button></div><textarea ref={draftRef} aria-label="催办草稿" value={selected.draft} readOnly rows={7} /><p className="delivery-inline-hint">复制后自行确认内容并发送。</p>{copyMessage && <p className="delivery-inline-hint" role="status">{copyMessage}</p>}</section>
            <section className="delivery-followup-history"><h4><History size={14} />跟进记录</h4>{history.length ? history.map((entry) => <article key={entry.id}><div><strong>{entry.workDate}</strong><span>记录于 {formatMoment(entry.recordedAt)}</span></div><p>{entry.note}</p>{entry.nextFollowUpDate && <small>约定下次跟进：{entry.nextFollowUpDate}</small>}</article>) : <p className="delivery-inline-hint">还没有跟进记录。跟进后记下回复、承诺和下次检查日期。</p>}</section>
          </aside>}
        </div>}
        {upcoming.length > 0 && <section className="delivery-attention"><div className="delivery-section-heading"><h3><CalendarClock size={15} />已约定的后续跟进</h3><span>{upcoming.length} 项</span></div>{upcoming.map((entry) => { const task = state.tasks.find((task) => task.id === entry.taskId); return task && <div className="delivery-upcoming-row" key={entry.taskId}><button className="text-button" onClick={() => onTaskOpen(task.id, task.projectId)}>{task.title}<ArrowRight size={12} /></button><span>{entry.nextFollowUpDate}</span><button className="button secondary compact" onClick={() => { setSelectedId(task.id); setRecordOther(true); }}>记录跟进</button></div>; })}</section>}
        {!!query.data?.history.length && <details className="delivery-all-history"><summary><History size={14} />最近跟进记录 <span>{Math.min(query.data.history.length, 30)} 条</span></summary><div className="delivery-followup-history">{query.data.history.slice(0, 30).map((entry) => { const task = state.tasks.find((value) => value.id === entry.taskId); return <article key={entry.id}><div><strong>{entry.workDate}</strong><button className="text-button" onClick={() => onTaskOpen(entry.taskId, entry.projectId)}>{task?.title || '查看任务'}<ArrowRight size={12} /></button>{!projectId && <span>{state.projects.find((project) => project.id === entry.projectId)?.name}</span>}</div><p>{entry.note}</p><small>{entry.nextFollowUpDate ? `下次跟进：${entry.nextFollowUpDate} · ` : ''}记录于 {formatMoment(entry.recordedAt)}</small></article>; })}</div></details>}
        <p className="delivery-footnote">同一任务可能触发多个原因，原因数量会有重叠。跟进记录与任务进展分别保存。</p>
      </>}
    </div>
    {form?.kind === 'record' && <RecordFollowUpDialog item={form.item} date={date} close={() => setForm(null)} onSaved={() => saved('跟进记录已保存。')} />}
    {form?.kind === 'snooze' && <SnoozeDialog item={form.item} date={date} close={() => setForm(null)} onSaved={() => saved('提醒暂缓设置已保存。')} />}
    {recordOther && <RecordFollowUpDialog tasks={recordableTasks} taskStates={query.data?.taskStates ?? []} initialTaskId={selectedId} date={date} close={() => setRecordOther(false)} onSaved={() => saved('跟进记录已保存。')} />}
  </div>;
}

function RecordFollowUpDialog({ item, tasks = [], taskStates = [], initialTaskId, date, close, onSaved }: { item?: FollowUpItem; tasks?: Task[]; taskStates?: FollowUpTaskState[]; initialTaskId?: string; date: string; close: () => void; onSaved: () => Promise<void> }) {
  const [selectedTaskId, setSelectedTaskId] = useState(item?.taskId ?? (tasks.some((task) => task.id === initialTaskId) ? initialTaskId! : tasks[0]?.id ?? ''));
  const [pinnedState, setPinnedState] = useState(() => taskStates.find((entry) => entry.taskId === selectedTaskId));
  const initialNextDate = item?.nextFollowUpDate ?? pinnedState?.nextFollowUpDate;
  const [draft, setDraft] = useState({ workDate: date > localDay() ? localDay() : date, note: '', nextFollowUpDate: initialNextDate && initialNextDate > date ? initialNextDate : shiftDay(date, 1) });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const alive = useAlive();
  const selectedTask = item?.task ?? tasks.find((task) => task.id === selectedTaskId);
  const baseVersion = item?.followUpVersion ?? pinnedState?.followUpVersion;
  const invalid = !!draft.nextFollowUpDate && draft.nextFollowUpDate < draft.workDate;
  return <Dialog title="记录跟进" subtitle={selectedTask?.title ?? '选择任务并约定下一次跟进'} close={close} busy={busy}><form onSubmit={async (event) => { event.preventDefault(); if (!draft.note.trim() || invalid || baseVersion === undefined || !selectedTask) return; setBusy(true); setError(''); try { await execute('record_follow_up', { taskId: selectedTask.id, baseVersion, workDate: draft.workDate, note: draft.note.trim(), nextFollowUpDate: draft.nextFollowUpDate || null }); if (alive.current) await onSaved(); } catch (caught) { if (alive.current) setError(asError(caught).message); } finally { if (alive.current) setBusy(false); } }}><div className="dialog-body delivery-form">{!item && <label><span className="field-label">跟进任务</span><select aria-label="跟进任务" value={selectedTaskId} onChange={(event) => { const nextState = taskStates.find((entry) => entry.taskId === event.target.value); setSelectedTaskId(event.target.value); setPinnedState(nextState); setDraft({ ...draft, nextFollowUpDate: nextState?.nextFollowUpDate && nextState.nextFollowUpDate > date ? nextState.nextFollowUpDate : shiftDay(date, 1) }); setError(''); }} required disabled={busy}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}{task.assignee ? ` · ${task.assignee}` : ''}</option>)}</select></label>}<label><span className="field-label">跟进结果</span><textarea aria-label="跟进结果" value={draft.note} maxLength={10000} rows={5} placeholder="记录对方回复、交付承诺、待确认事项…" onChange={(event) => setDraft({ ...draft, note: event.target.value })} required disabled={busy} /></label><div className="delivery-form-grid"><label><span className="field-label">跟进日期</span><input aria-label="跟进日期" type="date" value={draft.workDate} max={localDay()} onChange={(event) => setDraft({ ...draft, workDate: event.target.value })} required disabled={busy} /></label><label><span className="field-label">下次跟进日期 <span>可选</span></span><input aria-label="下次跟进日期" type="date" min={draft.workDate} value={draft.nextFollowUpDate} onChange={(event) => setDraft({ ...draft, nextFollowUpDate: event.target.value })} disabled={busy} /></label></div><p className="delivery-inline-hint">保存跟进后，暂缓设置会解除。任务状态和进度请在任务详情中更新。</p>{invalid && <DeliveryError message="下次跟进日期不能早于本次跟进日期。" />}<DeliveryError message={error} /></div><div className="dialog-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !selectedTask || !draft.note.trim() || invalid || baseVersion === undefined}>{busy && <Spinner />}保存跟进</button></div></form></Dialog>;
}

function SnoozeDialog({ item, date, close, onSaved }: { item: FollowUpItem; date: string; close: () => void; onSaved: () => Promise<void> }) {
  const [until, setUntil] = useState(item.snoozedUntil && item.snoozedUntil > date ? item.snoozedUntil : shiftDay(date, 1));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const alive = useAlive();
  const save = async (value: string | null) => {
    setBusy(true); setError('');
    try { await execute('snooze_follow_up', { taskId: item.taskId, baseVersion: item.followUpVersion, snoozedUntil: value, date }); if (alive.current) await onSaved(); }
    catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(false); }
  };
  return <Dialog title="暂缓提醒" subtitle={item.task.title} close={close} busy={busy}><form onSubmit={(event) => { event.preventDefault(); if (until > date) void save(until); }}><div className="dialog-body delivery-form"><p className="delivery-description">暂缓期间从待跟进列表中收起，到指定日期恢复提醒。</p><label><span className="field-label">恢复提醒日期</span><input aria-label="恢复提醒日期" type="date" min={shiftDay(date, 1)} value={until} onChange={(event) => setUntil(event.target.value)} required disabled={busy} /></label><div className="delivery-quick-dates">{[1, 3, 7].map((days) => <button type="button" className="button secondary compact" key={days} onClick={() => setUntil(shiftDay(date, days))} disabled={busy}>{days} 天后</button>)}</div><DeliveryError message={error} /></div><div className="dialog-footer">{item.snoozedUntil && <button type="button" className="text-button" disabled={busy} onClick={() => void save(null)}>立即恢复提醒</button>}<button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !until || until <= date}>{busy && <Spinner />}保存暂缓</button></div></form></Dialog>;
}
