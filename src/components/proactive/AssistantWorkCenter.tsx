import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, CircleAlert, Clock3, History, Pause, Play, RefreshCw } from 'lucide-react';
import { asError, execute } from '../../api';
import { Spinner } from '../ui';
import { formatMoment, WorkEmpty } from '../work/shared';
import { WORK_STATUS } from './work-types';
import { AssistanceRunRecords } from './AssistanceRunRecords';
import type { AssistantWork, AssistantWorkChoiceId, AssistantWorkData, AssistantWorkProposal, AssistantWorkStatus } from './work-types';
import './assistant-work.css';

interface Props {
  projectId: string; refreshRevision: number; onChanged: () => void;
  onTaskOpen: (id: string, projectId: string) => void;
  onMemoryReviewOpen: (projectId: string) => void;
  notify: (message: string, error?: boolean) => void;
}

const STATUSES: AssistantWorkStatus[] = ['ready', 'watching', 'paused', 'resolved', 'cancelled'];
const HISTORY: Record<string, string> = {
  created: '发现待推进事项', updated: '更新当前依据', refreshed: '更新当前依据',
  prepared: '已准备处理方案', reassessed: '已重新核对情况',
  decided: '已保存处理决定', decision: '已保存处理决定', record_follow_up: '记录实际跟进',
  set_review: '安排下次复查', adopt_date: '调整任务截止日期', open_review: '转到冲突审核',
  dismiss: '忽略本次事项', paused: '暂停推进', resumed: '恢复推进', resolved: '事项已收束',
  checked: '复查当前情况', review_due: '到期重新核对', cancelled: '忽略本次事项',
};

function localTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function AssistantWorkCenter({ projectId, refreshRevision, onChanged, onTaskOpen, onMemoryReviewOpen, notify }: Props) {
  const [data, setData] = useState<AssistantWorkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<AssistantWorkStatus>('ready');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AssistantWorkProposal | null>(null);
  const [proposalError, setProposalError] = useState('');
  const [proposalLoading, setProposalLoading] = useState(false);
  const mutation = useRef(false);
  const alive = useRef(true);
  const proposalRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; proposalRequest.current++; }; }, []);
  useEffect(() => {
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await execute<AssistantWorkData>('get_assistant_work', projectId ? { projectId } : {});
        if (active) { setData(next); setError(''); }
      } catch (caught) { if (active) setError(asError(caught).message); }
      finally { reading = false; if (active) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 15_000);
    const focus = () => void read();
    window.addEventListener('focus', focus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [projectId, refreshRevision, reload]);

  const refresh = () => setReload(value => value + 1);
  const changed = () => { refresh(); onChanged(); };
  const update = async (id: string, command: string, payload: Record<string, unknown>, message: string) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(id);
    try {
      const result = await execute<AssistantWork | AssistantWorkData['settings'] | null>(command, payload);
      if (alive.current) {
        if (result && typeof result === 'object' && 'id' in result) setData(previous => previous && ({ ...previous, works: previous.works.map(item => item.id === result.id ? result : item) }));
        else if (result && typeof result === 'object' && 'enabled' in result) setData(previous => previous && ({ ...previous, settings: result }));
        setProposal(null); setSelected(null); changed(); notify(message);
      }
    } catch (caught) {
      if (alive.current) { refresh(); notify(asError(caught).message, true); }
    } finally { mutation.current = false; if (alive.current) setBusy(''); }
  };
  const loadProposal = async (work: AssistantWork, reconcile = false) => {
    const request = ++proposalRequest.current;
    setSelected(work.id); setProposal(null); setProposalError(''); setProposalLoading(true);
    try {
      if (reconcile) await execute('run_assistant_work', { workId: work.id });
      const next = await execute<AssistantWorkProposal>('get_action_proposal', { workId: work.id });
      if (alive.current && request === proposalRequest.current) {
        if (next.id !== work.id || next.projectId !== work.projectId) throw new Error('处理建议与当前事项不一致，请刷新后重试。');
        setProposal(next);
        setData(previous => previous && ({ ...previous, works: previous.works.map(item => item.id === next.id ? next : item) }));
      }
    } catch (caught) {
      if (alive.current && request === proposalRequest.current) setProposalError(asError(caught).message);
    } finally { if (alive.current && request === proposalRequest.current) setProposalLoading(false); }
  };
  const closeProposal = () => { proposalRequest.current++; setSelected(null); setProposal(null); setProposalLoading(false); setProposalError(''); };
  const workItems = data?.works.filter(work => work.status === status) ?? [];
  const selectedWork = data?.works.find(work => work.id === selected);
  const stale = !!proposal && (!!proposal.stale || !selectedWork || selectedWork.version !== proposal.version);
  const openRecord = (work: AssistantWork) => work.kind === 'memory_conflict' ? onMemoryReviewOpen(work.projectId) : onTaskOpen(work.targetId, work.projectId);
  const disabled = !!busy || !!error;

  if (loading) return <div className="proactive-loading" role="status"><Spinner />正在读取持续推进事项…</div>;
  return <section className="assistant-work" aria-label="持续推进">
    <div className="assistant-work-intro"><div><h3>持续推进</h3><p>整理延期、到期跟进与资料冲突。确认处理方式后，按约定继续复查。</p></div>
      <button className="text-button" disabled={!!busy} onClick={refresh}><RefreshCw size={13} />刷新</button>
    </div>
    {error && <div className="proactive-load-error" role="alert"><CircleAlert size={18} /><div><strong>暂时无法读取最新事项</strong><p>{error}</p><button className="text-button" onClick={refresh}>重新读取</button></div></div>}
    {data && <>
      <div className="assistant-work-settings"><label className="proactive-enabled"><input type="checkbox" checked={data.settings.enabled} disabled={disabled} onChange={event => void update('settings', 'save_assistant_work_settings', { enabled: event.target.checked, baseVersion: data.settings.version }, event.target.checked ? '持续推进已启用。' : '持续推进已暂停，记录已保留。')} /><span>自动整理与复查</span></label>
        <span>适用于全部项目 · {data.settings.enabled ? '应用运行期间检查，重启后继续' : '已暂停自动处理'}</span>
        <button className="text-button" disabled={disabled || !data.settings.enabled} onClick={() => void update('scan', 'run_assistant_work', {}, '已检查当前事项。')}>{busy === 'scan' ? <Spinner /> : <RefreshCw size={13} />}检查全部项目</button>
      </div>
      {!data.settings.enabled && <p className="assistant-work-notice">启用后可确认处理方案并继续复查；已有记录和暂停状态会保留。</p>}
      {data.pendingEvents > 0 && <p className="assistant-work-notice" role="status">{data.settings.enabled ? `还有 ${data.pendingEvents} 条变化正在等待整理。` : `有 ${data.pendingEvents} 条变化等待恢复后整理。`}</p>}
      {data.truncated && <p className="assistant-work-notice">当前只展示部分事项，状态数量包含全部记录。可选择具体项目缩小范围。</p>}
      <nav className="proactive-tabs assistant-work-tabs" aria-label="持续推进状态">{STATUSES.map(value => <button key={value} className={status === value ? 'active' : ''} aria-current={status === value ? 'page' : undefined} disabled={!!busy} onClick={() => { setStatus(value); setExpanded(false); closeProposal(); }}>{WORK_STATUS[value]}<span>{data.counts[value]}</span></button>)}</nav>
      {!workItems.length ? <WorkEmpty title={status === 'ready' ? '当前没有等待处理的事项' : `暂无${WORK_STATUS[status]}的事项`}>{status === 'ready' ? '记录任务期限、实际跟进或资料冲突后，助理会在这里准备下一步。' : '切换状态可查看其他事项及已有处理记录。'}</WorkEmpty> :
        <div>{(expanded ? workItems : workItems.slice(0, 5)).map(work => <article key={work.id} className="assistant-work-item">
          <div className="assistant-work-item-heading"><div><h4>{work.title}</h4><p className="assistant-work-context">{work.projectName} · {WORK_STATUS[work.status]}</p></div><button className="text-button" onClick={() => openRecord(work)} disabled={!!busy}>{work.kind === 'memory_conflict' ? '查看待审核内容' : '查看任务'}<ArrowRight size={12} /></button></div>
          <p className="assistant-work-summary">{work.summary || work.reason}</p>
          {work.lastOutcome && <p className="assistant-work-outcome"><Check size={13} />{work.lastOutcome}</p>}
          <div className="assistant-work-item-actions">
            {(work.status === 'ready' || work.status === 'watching') && <><button className="button secondary compact" disabled={disabled || !data.settings.enabled || proposalLoading && selected === work.id} onClick={() => selected === work.id ? closeProposal() : void loadProposal(work)}>{proposalLoading && selected === work.id && <Spinner />}{selected === work.id ? '收起处理方案' : '查看处理方案'}</button><button className="text-button" disabled={disabled} onClick={() => void update(work.id, 'pause_assistant_work', { workId: work.id, baseVersion: work.version, paused: true }, '此事项已暂停。')}><Pause size={13} />暂停此事项</button></>}
            {work.status === 'paused' && <button className="button secondary compact" disabled={disabled || !data.settings.enabled} onClick={() => void update(work.id, 'pause_assistant_work', { workId: work.id, baseVersion: work.version, paused: false }, '此事项已恢复，将核对最新情况。')}><Play size={13} />恢复推进</button>}
            {work.nextCheckAt && <span className="assistant-work-review-time"><Clock3 size={13} />{formatMoment(work.nextCheckAt)} 复查</span>}
          </div>
          <details className="assistant-work-evidence"><summary>原因与依据 · {work.evidence.length} 条</summary><p>{work.reason}</p>{work.evidence.map((evidence, index) => <blockquote key={`${evidence.id}:${index}`}><strong>{evidence.label}</strong><p>{evidence.detail || '暂无可展示的正文，请打开原记录核对。'}</p></blockquote>)}<p>更新于 {formatMoment(work.updatedAt)}</p></details>
          {selected === work.id && <div className="assistant-work-proposal" aria-live="polite">
            {proposalLoading && <p className="ai-assistance-status"><Spinner />正在读取处理依据…</p>}
            {proposalError && <p className="form-error" role="alert">{proposalError}<button className="text-button" disabled={!!busy || !data.settings.enabled} onClick={() => void loadProposal(work, true)}>重新读取建议</button></p>}
            {proposal && <WorkDecision key={`${proposal.id}:${proposal.version}`} proposal={proposal} disabled={disabled || !data.settings.enabled} stale={stale} onReload={() => void loadProposal(work, true)} onBusy={value => { mutation.current = value; if (alive.current) setBusy(value ? work.id : ''); }} onSaved={(choice, result) => { setData(previous => previous && ({ ...previous, works: previous.works.map(item => item.id === result.id ? result : item) })); closeProposal(); changed(); notify(choice === 'open_review' ? '已记录转入审核，完成审核后会继续核对。' : choice === 'dismiss' ? '已忽略本次事项，历史记录已保留。' : '处理结果已保存，将按约定继续复查。'); if (choice === 'open_review') onMemoryReviewOpen(work.projectId); }} onConflict={refresh} />}
          </div>}
        </article>)}</div>}
      {workItems.length > 5 && <button className="text-button proactive-show-all" disabled={!!busy} onClick={() => setExpanded(value => !value)}>{expanded ? '收起其余事项' : `展开其余 ${workItems.length - 5} 项`}</button>}
      <details className="proactive-history assistant-work-history"><summary><History size={14} />处理记录<span>{data.history.length} 条</span></summary>{data.history.length ? data.history.map(item => <article key={item.id}><div><strong>{HISTORY[item.kind] || '推进记录已更新'}</strong><time dateTime={item.createdAt}>{formatMoment(item.createdAt)}</time></div>{data.works.find(work => work.id === item.workId)?.title && <small>{data.works.find(work => work.id === item.workId)?.title}</small>}{item.note && <p>{item.note}</p>}</article>) : <p className="proactive-empty-note">发现事项、确认处理与复查后，记录会显示在这里。</p>}</details>
    </>}
    <AssistanceRunRecords key={projectId} projectId={projectId} revision={`${refreshRevision}:${reload}`} />
  </section>;
}

const EFFECTS: Record<AssistantWorkChoiceId, string> = {
  record_follow_up: '保存这次实际跟进和下次复查时间，任务完成状态保持原记录。',
  set_review: '保存复查说明和时间，到期重新核对当前记录。',
  adopt_date: '将任务截止日期改为你填写的日期，并保存调整原因与下次复查时间。',
  open_review: '转到已有的资料冲突审核。此选择不会自动接受新事实或解决冲突。',
  dismiss: '忽略本次事项并保留处理历史。',
};

function WorkDecision({ proposal, disabled, stale, onReload, onBusy, onSaved, onConflict }: {
  proposal: AssistantWorkProposal; disabled: boolean; stale: boolean; onReload: () => void;
  onBusy: (busy: boolean) => void; onSaved: (choice: AssistantWorkChoiceId, result: AssistantWork) => void; onConflict: () => void;
}) {
  const [choiceId, setChoiceId] = useState<AssistantWorkChoiceId | ''>('');
  const [note, setNote] = useState('');
  const [reviewAt, setReviewAt] = useState(() => localTime(new Date(Date.now() + 3_600_000)));
  const [proposedDate, setProposedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(true);
  const submitting = useRef(false);
  const decision = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const choice = proposal.choices.find(item => item.id === choiceId);
  const isStale = stale || conflict;
  const taskSnapshot = proposal.snapshot.task;
  const currentDueDate = taskSnapshot && typeof taskSnapshot === 'object' && 'dueDate' in taskSnapshot && typeof taskSnapshot.dueDate === 'string' ? taskSnapshot.dueDate : '未设置';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!choice || submitting.current || disabled || isStale) return;
    const next = new Date(reviewAt);
    if (choice.needsNote && !note.trim()) { setError('请填写这次处理的实际情况或原因。'); return; }
    if (choice.needsReviewAt && (!reviewAt || !Number.isFinite(next.getTime()) || next.getTime() <= Date.now())) { setError('请选择未来的复查时间。'); return; }
    if (choice.needsDate && !/^\d{4}-\d{2}-\d{2}$/.test(proposedDate)) { setError('请填写新的任务截止日期。'); return; }
    const payload = { workId: proposal.id, baseVersion: proposal.version, choice: choice.id, note: note.trim(), ...(choice.needsReviewAt ? { reviewAt: next.toISOString() } : {}), ...(choice.needsDate ? { proposedDate } : {}) };
    const key = JSON.stringify(payload);
    if (decision.current?.payload !== key) decision.current = { payload: key, id: crypto.randomUUID() };
    submitting.current = true; setBusy(true); setError(''); onBusy(true);
    try {
      const result = await execute<AssistantWork>('decide_action_proposal', { ...payload, decisionId: decision.current.id });
      if (alive.current) onSaved(choice.id, result);
    } catch (caught) {
      if (alive.current) {
        const failure = asError(caught);
        const changed = ['VERSION_CONFLICT', 'REVISION_CONFLICT', 'PROPOSAL_STALE', 'NOT_FOUND'].includes(failure.code);
        setConflict(changed);
        setError(changed ? '记录已发生变化，本次方案未提交。请重新读取建议并核对。' : failure.message);
        onConflict();
      }
    } finally { submitting.current = false; if (alive.current) setBusy(false); onBusy(false); }
  };
  return <form className="assistant-work-decision" onSubmit={submit}>
    <h5>选择这次处理方式</h5>
    {isStale && <p className="assistant-work-notice" role="alert">依据已有变化，请核对最新处理方案。<button type="button" className="text-button" disabled={disabled || busy} onClick={onReload}>重新读取建议</button></p>}
    {!proposal.choices.length ? <p>此事项暂无可提交的处理方式，请查看原记录或刷新。</p> : <fieldset disabled={disabled || busy || isStale}><legend className="sr-only">处理方式</legend>{proposal.choices.map(item => <label className="assistant-work-choice" key={item.id}><input type="radio" name={`decision-${proposal.id}`} value={item.id} checked={choiceId === item.id} onChange={() => { setChoiceId(item.id); setError(''); }} /><span>{item.label}</span></label>)}</fieldset>}
    {choice && <>
      <p className="assistant-work-effect">{EFFECTS[choice.id]}</p>
      {choice.needsDate && <label><span className="field-label">新的任务截止日期</span><input type="date" min={localTime(new Date()).slice(0, 10)} value={proposedDate} required disabled={disabled || busy || isStale} onChange={event => setProposedDate(event.target.value)} /><span className="assistant-work-date-change">当前：{currentDueDate}{proposedDate && ` → 确认后：${proposedDate}`}</span></label>}
      {(choice.needsNote || choice.id === 'dismiss') && <label><span className="field-label">{choice.id === 'record_follow_up' ? '实际跟进情况' : '处理说明'}{!choice.needsNote && <span>可选</span>}</span><textarea rows={3} maxLength={5000} value={note} required={choice.needsNote} disabled={disabled || busy || isStale} onChange={event => setNote(event.target.value)} placeholder={choice.id === 'record_follow_up' ? '记录已沟通的内容、实际答复或下一步约定。' : '说明这次决定的依据，便于之后继续跟进。'} /></label>}
      {choice.needsReviewAt && <label><span className="field-label">下次复查时间</span><input type="datetime-local" value={reviewAt} required disabled={disabled || busy || isStale} onChange={event => setReviewAt(event.target.value)} /></label>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {choice && <button className="button primary compact" disabled={disabled || busy || isStale || choice.needsNote && !note.trim() || choice.needsDate && !proposedDate || choice.needsReviewAt && !reviewAt}>{busy && <Spinner />}{choice.id === 'open_review' ? '记录并前往审核' : choice.id === 'adopt_date' ? '确认修改截止日期' : choice.id === 'dismiss' ? '确认忽略本次事项' : '确认并继续跟进'}</button>}
  </form>;
}
