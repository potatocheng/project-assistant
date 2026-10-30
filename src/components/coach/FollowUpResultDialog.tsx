import { useEffect, useState } from 'react';
import { asError, execute } from '../../api';
import { DraftStatus, useDraftState } from '../../drafts';
import type { Task, TaskDetail } from '../../types';
import { TASK_STATUS } from '../../types';
import { Dialog, Spinner } from '../ui';
import { localDay, shiftDay } from '../work/shared';
import type { FollowUpCenterData, FollowUpTaskState } from '../delivery/types';
import { followUpNote, outcomeUpdate, OUTCOMES, type Outcome } from './coach-model';
import './coach.css';

export function FollowUpResultDialog({ tasks, initialTaskId, date, close, onSaved }: {
  tasks: Task[]; initialTaskId?: string; date: string; close: () => void; onSaved: () => Promise<void>;
}) {
  const [taskId, setTaskId] = useState(initialTaskId || tasks[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const task = tasks.find(t => t.id === taskId);
  return <Dialog title="记录跟进结果" subtitle="写下实际发生的情况，再决定下一步。" close={close} busy={busy} wide>
    {tasks.length > 1 && <div className="dialog-body"><label className="field-label" htmlFor="coach-task">这次跟进哪件事？</label><select id="coach-task" value={taskId} disabled={busy} onChange={e => setTaskId(e.target.value)}>{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>}
    {task ? <ResultForm key={task.id} initialTask={task} date={date} close={close} onSaved={onSaved} onBusy={setBusy} /> : <div className="dialog-body">请选择一个未完成的任务。</div>}
  </Dialog>;
}

function ResultForm({ initialTask, date, close, onSaved, onBusy }: { initialTask: Task; date: string; close: () => void; onSaved: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const today = localDay();
  const [task, setTask] = useState<Task | null>(null);
  const [follow, setFollow] = useState<FollowUpTaskState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [tick, setTick] = useState(0);
  const [lastDate, setLastDate] = useState('');
  const draftState = useDraftState(`task:follow-result:${initialTask.id}`, { note: '', outcome: 'note' as Outcome, contact: '', commitment: '', workDate: date > today ? today : date, nextDate: '', nextTouched: false });
  const { value: draft, setValue: setDraft } = draftState;
  useEffect(() => {
    let active = true;
    setTask(null); setFollow(null); setError('');
    Promise.all([
      execute<TaskDetail>('get_task', { taskId: initialTask.id }),
      execute<FollowUpCenterData>('get_follow_up_center', { date: today, projectId: initialTask.projectId }),
    ]).then(([detail, center]) => {
      if (!active) return;
      setTask(detail.task);
      setFollow(center.taskStates.find(s => s.taskId === initialTask.id) ?? null);
      const dates = [...detail.events.map(e => e.workDate), ...center.history.filter(r => r.taskId === initialTask.id).map(r => r.workDate)];
      setLastDate(dates.sort().at(-1) ?? '');
    }).catch(e => { if (active) setError(asError(e).message); });
    return () => { active = false; };
  }, [initialTask.id, initialTask.projectId, tick, today]);
  const nextDate = draft.outcome === 'done' ? '' : draft.nextTouched ? draft.nextDate : follow?.nextFollowUpDate ?? '';
  const invalidDate = draft.workDate < lastDate || draft.workDate > today || !!nextDate && nextDate < draft.workDate;
  const terminal = !!task && ['done', 'cancelled'].includes(task.status);
  const patch = (value: Partial<typeof draft>) => setDraft(d => ({ ...d, ...value }));
  const note = followUpNote(draft.outcome, draft.note, draft.contact, draft.outcome === 'done' ? '' : draft.commitment);
  const ready = !!task && !!follow && draftState.ready;
  return <form className="coach-result" onSubmit={async e => {
    e.preventDefault();
    if (!ready || !draft.note.trim() || invalidDate || terminal || committed || busy) return;
    setBusy(true); onBusy(true); setError('');
    try {
      await execute('record_follow_up', { taskId: task.id, baseVersion: follow.followUpVersion, workDate: draft.workDate, note, nextFollowUpDate: nextDate || null, taskOutcome: outcomeUpdate(task, draft.outcome) });
      setCommitted(true);
      try { await draftState.clear(); } catch { /* The result is already durable; do not offer a second submission. */ }
      try { await onSaved(); } catch { setError('结果已保存，页面刷新失败。请关闭后重新打开查看。'); }
    } catch (caught) { setError(asError(caught).message); }
    finally { setBusy(false); onBusy(false); }
  }}><div className="dialog-body">
    <h3>{initialTask.title}</h3>
    {task && <p className="field-hint">当前：{TASK_STATUS[task.status]} · {task.assignee || '负责人待确认'}{follow?.nextFollowUpDate && ` · 已约定 ${follow.nextFollowUpDate} 再跟进`}</p>}
    {!ready && !error && <p role="status"><Spinner />正在读取最新记录…</p>}
    <DraftStatus status={draftState.status} />
    <fieldset className="draft-fields" disabled={!ready || busy || committed || terminal}>
      <label><span className="field-label">对方怎么回复，或事情有什么变化？</span><textarea aria-label="跟进结果" value={draft.note} maxLength={8000} required rows={3} placeholder="例如：小周说周五给测试版，目前还没交付。" onChange={e => patch({ note: e.target.value })} /></label>
      <label><span className="field-label">现在到哪一步了？</span><select aria-label="本次跟进结果" value={draft.outcome} onChange={e => patch({ outcome: e.target.value as Outcome })}>{Object.entries(OUTCOMES).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      <label><span className="field-label">下一次什么时候再看？ <span>可选</span></span><input aria-label="下次跟进日期" type="date" min={draft.workDate} value={nextDate} disabled={draft.outcome === 'done'} onChange={e => patch({ nextDate: e.target.value, nextTouched: true })} />{draft.outcome !== 'done' && <div className="coach-choices">{[1, 3].map(days => <button type="button" className="button secondary compact" key={days} onClick={() => patch({ nextDate: shiftDay(draft.workDate, days), nextTouched: true })}>{days === 1 ? '明天再看' : '3 天后'}</button>)}<button type="button" className="text-button tiny" onClick={() => patch({ nextDate: '', nextTouched: true })}>暂不安排</button></div>}</label>
      <details><summary>补充人员、承诺和发生日期</summary><div className="delivery-form-grid spaced">
        <label><span className="field-label">这次和谁沟通？</span><input aria-label="本次沟通对象" value={draft.contact} maxLength={300} onChange={e => patch({ contact: e.target.value })} placeholder={task?.assignee || '未确认可留空'} /></label>
        {draft.outcome !== 'done' && <label><span className="field-label">对方承诺哪天交付？</span><input aria-label="承诺交付日期" type="date" value={draft.commitment} onChange={e => patch({ commitment: e.target.value })} /></label>}
        <label><span className="field-label">事情发生在哪天？</span><input aria-label="跟进日期" type="date" required min={lastDate} max={today} value={draft.workDate} onChange={e => patch({ workDate: e.target.value })} /></label>
      </div></details>
      <p className="coach-result-preview">{draft.outcome === 'note' ? '保存跟进记录，保留当前任务状态。' : draft.outcome === 'done' ? '保存后任务将标记完成，进度为 100%，后续跟进提醒结束。请确认成果已实际交付并检查通过。' : `保存后任务状态更新为“${draft.outcome === 'blocked' ? '阻塞' : '进行中'}”，保留已记录的进度。`}{nextDate && `下次跟进：${nextDate}。`}</p>
    </fieldset>
    {terminal && <p className="form-error" role="alert">任务已经完成或取消，请关闭后查看最新任务。</p>}
    {invalidDate && <p className="form-error" role="alert">发生日期需在 {lastDate} 至今天之间，下次跟进不能早于发生日期。展开“补充人员、承诺和发生日期”可调整发生日期。</p>}
    {error && <div className="form-error" role="alert">{error}<button type="button" className="text-button" disabled={busy || committed} onClick={() => setTick(t => t + 1)}>重新读取最新记录</button></div>}
    {committed && <p role="status">跟进结果已保存。</p>}
  </div><div className="dialog-footer"><button type="button" className="button secondary" onClick={close} disabled={busy}>关闭</button><button className="button primary" disabled={!ready || busy || committed || terminal || invalidDate || !draft.note.trim()}>{busy && <Spinner />}保存结果</button></div></form>;
}
