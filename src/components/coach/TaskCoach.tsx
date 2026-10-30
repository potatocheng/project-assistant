import { useEffect, useRef, useState } from 'react';
import { Copy, Footprints, PencilLine } from 'lucide-react';
import { asError, execute } from '../../api';
import type { AppState, Task } from '../../types';
import { AiTaskCoach } from '../assistance/AiTaskCoach';
import { useDraftState } from '../../drafts';
import { formatMoment, localDay } from '../work/shared';
import type { FollowUpCenterData } from '../delivery/types';
import { BLOCKERS, TERMS, type Blocker, type Term } from './coach-model';
import { TermHelp } from './TermHelp';
import { FollowUpResultDialog } from './FollowUpResultDialog';

export function TaskCoach({ task, date, state, onChanged, onModelSettings, autoStart = false }: { task: Task; date: string; state: AppState; onChanged: () => Promise<unknown>; onModelSettings?: () => void; autoStart?: boolean }) {
  const [open, setOpen] = useState(autoStart);
  const [record, setRecord] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [history, setHistory] = useState<FollowUpCenterData | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [tick, setTick] = useState(0);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const draft = useDraftState(`task:coach:${task.id}`, { reason: '' as Blocker | '', draft: '' });
  const reason = draft.value.reason;
  const advice = reason ? BLOCKERS[reason] : null;
  const active = !['done', 'cancelled'].includes(task.status);
  useEffect(() => {
    let cancelled = false;
    execute<FollowUpCenterData>('get_follow_up_center', { date: localDay(), projectId: task.projectId }).then(data => { if (!cancelled) { setHistory(data); setHistoryError(''); } }).catch(e => { if (!cancelled) setHistoryError(asError(e).message); });
    return () => { cancelled = true; };
  }, [task.id, task.projectId, task.version, tick]);
  const records = history?.history.filter(r => r.taskId === task.id) ?? [];
  const nextDate = history?.taskStates.find(s => s.taskId === task.id)?.nextFollowUpDate;
  return <section className="task-coach" aria-label="推进任务与记录结果">
    {!active && <p className="field-hint">{task.status === 'done' ? '这件事已确认完成，可以回看跟进记录。' : '这件事已取消，可以回看跟进记录。'}</p>}
    {active && <div className="coach-actions"><button className="button secondary compact" type="button" aria-expanded={open} onClick={() => setOpen(!open)}><Footprints size={14} />{open ? '收起引导' : '帮我推进'}</button><button className="button primary compact" type="button" onClick={() => setRecord(true)}><PencilLine size={14} />记录跟进结果</button></div>}
    {active && open && <div className="coach-guide"><AiTaskCoach task={task} date={date} state={state} reason={reason} onModelSettings={onModelSettings} /><details><summary>通用推进引导与困难类型</summary><h4>你遇到了什么情况？</h4><div className="coach-choices">{Object.entries(BLOCKERS).map(([key, info]) => <button type="button" key={key} className="button secondary compact" aria-pressed={reason === key} disabled={!draft.ready} onClick={() => { draft.setValue({ reason: key as Blocker, draft: info.draft.replaceAll('{title}', task.title) }); setCopyStatus(''); }}>{info.label}</button>)}</div>
      {advice && <div className="coach-advice" aria-live="polite"><strong>建议先做：{advice.next}</strong><p>{advice.question}</p><details><summary>为什么先做这一步？</summary><p>{advice.why}</p></details>{reason === 'scope' && <p>先和对方说清 <TermHelp term="验收标准" label="怎样才算完成" context={task.title} />。</p>}<label className="field-label" htmlFor={`coach-draft-${task.id}`}>可以这样问 <span>按实际情况修改</span></label><textarea id={`coach-draft-${task.id}`} ref={draftRef} value={draft.value.draft} maxLength={5000} onChange={e => { draft.setValue({ ...draft.value, draft: e.target.value }); setCopyStatus(''); }} rows={4} /><div className="coach-draft-actions"><button type="button" className="button secondary compact" onClick={async () => { try { await navigator.clipboard.writeText(draft.value.draft); setCopyStatus('已复制，核对后自行发送。'); } catch { draftRef.current?.focus(); draftRef.current?.select(); setCopyStatus('已选中，请按 Ctrl+C 复制。'); } }}><Copy size={13} />复制沟通草稿</button><button type="button" className="text-button" onClick={() => setRecord(true)}>沟通后，记下结果</button></div><p className="field-hint" role="status">{copyStatus || '这是处理建议，请结合真实情况确认联系人和时间。'}</p></div>}
      {draft.status.includes('失败') && <p className="form-error" role="alert">{draft.status}</p>}
    </details>
    </div>}
    <details className="coach-terms"><summary>遇到不懂的词？</summary><div>{(Object.keys(TERMS) as Term[]).map(term => <TermHelp key={term} term={term} context={task.title} />)}</div></details>
    {nextDate && <p className="field-hint spaced">下次跟进：{nextDate}</p>}
    <details className="coach-history"><summary>跟进记录 · {records.length}{historyError ? ' · 读取失败' : ''}</summary>{historyError ? <p className="form-error">{historyError}<button className="text-button" onClick={() => setTick(t => t + 1)}>重试</button></p> : records.length ? records.map(r => <article key={r.id}><strong>{r.workDate}</strong><p>{r.note}</p><small className="field-hint">记录于 {formatMoment(r.recordedAt)}{r.nextFollowUpDate && ` · 下次跟进 ${r.nextFollowUpDate}`}</small></article>) : <p className="field-hint spaced">沟通后记录回复和约定，下次就知道从哪里继续。</p>}</details>
    {record && <FollowUpResultDialog tasks={[task]} date={date} close={() => setRecord(false)} onSaved={async () => { setRecord(false); setTick(t => t + 1); await onChanged(); }} />}
  </section>;
}
