import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, CircleAlert, Clock3, Copy, Eye, History, Radar, RefreshCw, RotateCcw, Settings2, X } from 'lucide-react';
import { asError, execute } from '../../api';
import type { ManagementKind, Project } from '../../types';
import { Dialog, Spinner } from '../ui';
import { formatMoment, WorkEmpty } from '../work/shared';
import { PROACTIVE_STATUS } from './types';
import type { ProactiveAction, ProactiveCenterData, ProactiveHistory, ProactiveOperation, ProactiveSettings, ProactiveStatus, ProactiveTargetKind } from './types';
import './proactive.css';

interface Props {
  projects: Project[]; projectId: string; onProjectChange: (projectId: string) => void;
  refreshRevision: number; onChanged: () => void;
  onTaskOpen: (taskId: string, projectId: string) => void;
  onManagementOpen: (kind: ManagementKind, id: string, projectId: string) => void;
  onOverviewOpen: (projectId: string) => void;
  notify: (message: string, error?: boolean) => void;
}

const STATUSES: ProactiveStatus[] = ['ready', 'watching', 'snoozed', 'resolved', 'dismissed'];
const HISTORY_LABELS: Record<string, string> = {
  created: '发现需要跟进的事项', detected: '发现需要跟进的事项', updated: '更新行动建议', refreshed: '更新判断依据',
  checked: '复查当前进展', reviewed: '复查当前进展', watch: '已跟进，等待复查', watching: '已跟进，等待复查',
  snooze: '暂缓处理', snoozed: '暂缓处理', dismiss: '忽略本次行动', dismissed: '忽略本次行动',
  reopen: '重新开始跟进', reopened: '重新开始跟进', resolved: '依据变化，自动收束', escalated: '复查后需要再次处理',
  deferred: '按约定时间等待复查', review_due: '复查后需要再次处理', source_changed: '跟进依据发生变化',
};
const OPERATION_LABELS: Record<ProactiveOperation, string> = {
  watch: '已跟进，待复查', snooze: '暂缓处理', dismiss: '忽略行动', reopen: '重新跟进',
};

function localDateTime(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function nextTime(hours: number | 'tomorrow'): string {
  const value = new Date();
  if (hours === 'tomorrow') { value.setDate(value.getDate() + 1); value.setHours(9, 0, 0, 0); }
  else value.setTime(value.getTime() + hours * 3_600_000);
  return localDateTime(value);
}

export function ProactiveCenter({ projects, projectId, onProjectChange, refreshRevision, onChanged, onTaskOpen, onManagementOpen, onOverviewOpen, notify }: Props) {
  const [query, setQuery] = useState<{ scope: string; data: ProactiveCenterData | null; loading: boolean; error: string }>({ scope: projectId, data: null, loading: true, error: '' });
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<ProactiveStatus>('ready');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState('');
  const [operation, setOperation] = useState<{ action: ProactiveAction; kind: ProactiveOperation } | null>(null);
  const alive = useRef(true);
  const scopeRef = useRef(projectId); scopeRef.current = projectId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setStatus('ready'); setExpanded(false); setOperation(null); }, [projectId]);
  useEffect(() => {
    let active = true;
    let pending = false;
    const scope = projectId;
    const read = async (showLoading = false) => {
      if (pending) return;
      pending = true;
      if (showLoading) setQuery({ scope, data: null, loading: true, error: '' });
      try {
        const data = await execute<ProactiveCenterData>('get_proactive_center', scope ? { projectId: scope } : {});
        if (active && scopeRef.current === scope) setQuery({ scope, data, loading: false, error: '' });
      } catch (caught) {
        if (active && scopeRef.current === scope) setQuery({ scope, data: null, loading: false, error: asError(caught).message });
      } finally { pending = false; }
    };
    void read(true);
    const timer = window.setInterval(() => void read(), 60_000);
    const focus = () => void read();
    window.addEventListener('focus', focus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [projectId, refreshRevision, reload]);
  const data = query.scope === projectId ? query.data : null;
  const loading = query.scope !== projectId || query.loading;
  const error = query.scope === projectId ? query.error : '';
  const actions = useMemo(() => data?.actions.filter((action) => action.status === status) ?? [], [data, status]);
  const waiting = data?.actions.filter((action) => action.status === 'watching' || action.status === 'snoozed') ?? [];
  const closed = data?.actions.filter((action) => action.status === 'resolved' || action.status === 'dismissed') ?? [];
  const actionNames = useMemo(() => new Map(data?.actions.map((action) => [action.id, action.title]) ?? []), [data]);
  const reread = () => setReload((value) => value + 1);
  const changed = () => { reread(); onChanged(); };
  const chooseStatus = (next: ProactiveStatus) => { setStatus(next); setExpanded(false); };
  const openTarget = (kind: ProactiveTargetKind, id: string, itemProjectId: string) => {
    if (kind === 'task') onTaskOpen(id, itemProjectId);
    else if (kind === 'governance' || kind === 'change' || kind === 'deliverable') onManagementOpen(kind, id, itemProjectId);
    else onOverviewOpen(itemProjectId);
  };
  const saveSettings = async (settings: ProactiveSettings, enabled: boolean, reviewMinutes: number) => {
    setBusy('settings');
    try {
      await execute('save_proactive_settings', { enabled, reviewMinutes, baseRevision: settings.revision });
      onChanged();
      if (alive.current) { reread(); notify(enabled ? '主动巡检设置已保存。' : '主动巡检已暂停，已有跟进记录会保留。'); }
    } catch (caught) { if (alive.current) { reread(); notify(asError(caught).message, true); } }
    finally { if (alive.current) setBusy(''); }
  };
  const scan = async () => {
    setBusy('scan');
    try {
      await execute('run_proactive_scan', projectId ? { projectId } : {});
      onChanged();
      if (alive.current) { reread(); notify('巡检完成，行动建议已更新。'); }
    } catch (caught) { if (alive.current) { reread(); notify(asError(caught).message, true); } }
    finally { if (alive.current) setBusy(''); }
  };
  const copy = async (draft: string) => {
    try { await navigator.clipboard.writeText(draft); if (alive.current) notify('跟进草稿已复制。'); }
    catch { if (alive.current) notify('复制未完成，可在草稿中选择文字手动复制。', true); }
  };
  return <div className="work-page proactive-page">
    <div className="work-page-heading"><div><h2>待处理行动</h2></div></div>
    <div className="proactive-scroll">
      <div className="proactive-toolbar"><label className="proactive-scope"><span>项目</span><select aria-label="主动行动项目范围" value={projectId} disabled={!!busy} onChange={(event) => onProjectChange(event.target.value)}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div className="proactive-toolbar-actions">{data && <span className={`proactive-run-state${data.settings.enabled ? ' is-running' : ''}`}><span />{data.settings.enabled ? '自动巡检中' : '巡检已暂停'}</span>}<button className="button secondary compact" disabled={!!busy || loading || !data?.settings.enabled} onClick={scan}>{busy === 'scan' ? <Spinner /> : <Radar size={14} />}立即巡检</button></div></div>
      {loading ? <div className="proactive-loading" role="status"><Spinner />正在读取主动行动…</div> : error ? <div className="proactive-load-error" role="alert"><CircleAlert size={18} /><div><strong>暂时无法读取主动行动</strong><p>{error}</p><button className="text-button" onClick={reread}>重新读取</button></div></div> : data && <>
        {!data.settings.enabled && <div className="proactive-paused"><span>巡检已暂停，已有跟进记录仍可处理。</span><button className="text-button" disabled={!!busy} onClick={() => void saveSettings(data.settings, true, data.settings.reviewMinutes)}>{busy === 'settings' && <Spinner />}启用巡检<ArrowRight size={12} /></button></div>}
        {data.lastError && <p className="proactive-runtime-error" role="alert"><CircleAlert size={13} />上次巡检未完成：{data.lastError}</p>}
        <nav className="proactive-tabs" aria-label="行动状态">{STATUSES.map((value) => <button key={value} aria-current={status === value ? 'page' : undefined} className={status === value ? 'active' : ''} onClick={() => chooseStatus(value)}>{PROACTIVE_STATUS[value]}<span>{data.counts[value]}</span></button>)}</nav>
        <section className="proactive-current" aria-label={PROACTIVE_STATUS[status]}>{actions.length > 0 && <div className="proactive-section-heading"><h3>{status === 'ready' ? '按优先级处理' : PROACTIVE_STATUS[status]}</h3><span>{actions.length > 3 && !expanded ? `展示前 3 项 · 共 ${actions.length} 项` : `${actions.length} 项`}</span></div>}
          {!actions.length ? <WorkEmpty title={status === 'ready' ? '当前没有需要处理的行动' : `暂无${PROACTIVE_STATUS[status]}的行动`}>{status === 'ready' ? data.lastRunAt ? '后续发现项目变化或复查到期时，会在这里准备下一步。' : '启用巡检并检查一次，助理会依据当前记录准备行动。' : '切换上方状态可查看其他跟进记录。'}</WorkEmpty> : <div className="proactive-action-list">{(expanded ? actions : actions.slice(0, 3)).map((action, index) => <ActionItem key={action.id} action={action} rank={status === 'ready' ? index + 1 : undefined} busy={!!busy} onCopy={copy} onOpen={openTarget} onOperation={(kind) => setOperation({ action, kind })} />)}</div>}
          {actions.length > 3 && <button className="text-button proactive-show-all" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起其余行动' : `展开其余 ${actions.length - 3} 项`}</button>}
        </section>
        {status === 'ready' && <div className="proactive-following"><details className="proactive-waiting"><summary><Clock3 size={14} />等待复查<span>{waiting.length} 项</span><ChevronDown size={14} /></summary>{waiting.length ? waiting.slice(0, 5).map((action) => <button className="proactive-compact-row" key={action.id} onClick={() => { chooseStatus(action.status); setExpanded(true); }}><div><strong>{action.title}</strong><small>{action.projectName} · {PROACTIVE_STATUS[action.status]}</small></div><span>{action.nextCheckAt ? `${formatMoment(action.nextCheckAt)} 复查` : '等待下次巡检'}</span><ArrowRight size={13} /></button>) : <p className="proactive-empty-note">记录跟进并安排复查后，会在这里持续跟踪。</p>}{waiting.length > 5 && <p className="proactive-empty-note">另有 {waiting.length - 5} 项，可通过“待复查”和“已暂缓”查看。</p>}</details><details className="proactive-closed"><summary><Check size={14} />已收束与忽略<span>{closed.length} 项</span><ChevronDown size={14} /></summary>{closed.length ? closed.slice(0, 5).map((action) => <button key={action.id} className="proactive-compact-row" onClick={() => { chooseStatus(action.status); setExpanded(true); }}><div><strong>{action.title}</strong><small>{action.outcome || PROACTIVE_STATUS[action.status]}</small></div><span>{formatMoment(action.updatedAt)}</span><ArrowRight size={13} /></button>) : <p className="proactive-empty-note">原事项完成或解除风险后，相关行动会自动收束。</p>}</details></div>}
        <details className="proactive-settings"><summary><Settings2 size={14} />巡检设置<span>{data.settings.enabled ? '已启用' : '已暂停'} · 上次 {formatMoment(data.lastRunAt)}</span><ChevronDown size={14} /></summary><div className="proactive-settings-controls"><label className="proactive-enabled"><input type="checkbox" checked={data.settings.enabled} disabled={!!busy} onChange={(event) => void saveSettings(data.settings, event.target.checked, data.settings.reviewMinutes)} /><span>自动巡检</span></label><label className="proactive-frequency"><span>默认复查间隔</span><select aria-label="默认复查间隔" value={data.settings.reviewMinutes} disabled={!!busy} onChange={(event) => void saveSettings(data.settings, data.settings.enabled, Number(event.target.value))}>{![15, 60, 240].includes(data.settings.reviewMinutes) && <option value={data.settings.reviewMinutes}>{data.settings.reviewMinutes} 分钟</option>}<option value={15}>15 分钟</option><option value={60}>1 小时</option><option value={240}>4 小时</option></select></label>{busy === 'settings' && <Spinner />}</div><div className="proactive-runtime"><span>应用运行期间自动检查，重启后继续跟进。</span><button className="text-button" onClick={reread} disabled={loading || !!busy}><RefreshCw size={12} />刷新记录</button></div></details>
        <details className="proactive-history"><summary><History size={14} />最近活动<span>{data.history.length} 条</span><ChevronDown size={14} /></summary>{data.history.length ? data.history.map((event) => <HistoryItem key={event.id} event={event} title={actionNames.get(event.actionId)} />) : <p className="proactive-empty-note">巡检和跟进后的记录会显示在这里。</p>}</details>
      </>}
    </div>
    {operation && <ActionDialog key={`${operation.action.id}:${operation.action.version}:${operation.kind}`} action={operation.action} kind={operation.kind} close={() => setOperation(null)} onSaved={() => { setOperation(null); changed(); notify('跟进记录已保存。'); }} onConflict={reread} />}
  </div>;
}

function ActionItem({ action, rank, busy, onCopy, onOpen, onOperation }: {
  action: ProactiveAction; rank?: number; busy: boolean; onCopy: (draft: string) => Promise<void>;
  onOpen: (kind: ProactiveTargetKind, id: string, projectId: string) => void;
  onOperation: (operation: ProactiveOperation) => void;
}) {
  const active = action.status === 'ready' || action.status === 'watching' || action.status === 'snoozed';
  return <article className={`proactive-action${rank === 1 ? ' proactive-action-first' : ''}`} id={`proactive-${action.id}`}>
    <div className="proactive-action-heading">{rank && <span className="proactive-rank">{String(rank).padStart(2, '0')}</span>}<div><div className="proactive-action-context"><span>{action.projectName}</span><span className={`proactive-status proactive-status-${action.status}`}>{rank === 1 ? '优先处理' : PROACTIVE_STATUS[action.status]}</span></div><h4>{action.title}</h4></div><button className="text-button proactive-open" onClick={() => onOpen(action.targetKind, action.targetId, action.projectId)}>{action.targetKind === 'task' ? '查看任务' : action.targetKind === 'project' || action.targetKind === 'milestone' ? '查看总览' : '查看管理记录'}<ArrowRight size={12} /></button></div>
    <div className="proactive-action-body"><div className="proactive-next-step"><span>建议下一步</span><p>{action.suggestedAction}</p></div>
      {action.outcome && <p className="proactive-outcome">{action.status === 'resolved' ? <Check size={13} /> : <Clock3 size={13} />}{action.outcome}</p>}
      <div className="proactive-action-buttons">{active ? <><button className={`button ${rank === 1 ? 'primary' : 'secondary'} compact`} disabled={busy} onClick={() => onOperation('watch')}><Eye size={13} />记录跟进</button><button className="text-button" disabled={busy} onClick={() => onOperation('snooze')}><Clock3 size={13} />暂缓</button><button className="text-button proactive-dismiss" disabled={busy} onClick={() => onOperation('dismiss')}><X size={13} />忽略</button></> : <button className="button secondary compact" disabled={busy} onClick={() => onOperation('reopen')}><RotateCcw size={13} />重新跟进</button>}</div>
      <div className="proactive-action-details"><details className="proactive-evidence"><summary>原因与依据{action.evidence.length > 0 && <span>{action.evidence.length} 条依据</span>}<ChevronDown size={12} /></summary><p className="proactive-reason">{action.reason}</p>{action.evidence.map((evidence, index) => <div key={`${evidence.targetKind}:${evidence.targetId}:${index}`}><div><strong>{evidence.label}</strong><p>{evidence.detail}</p></div><button className="text-button" onClick={() => onOpen(evidence.targetKind, evidence.targetId, action.projectId)}>查看<ArrowRight size={11} /></button></div>)}<div className="proactive-check-times"><span>最近检查：{formatMoment(action.lastCheckedAt)}</span><span>下次复查：{action.nextCheckAt ? formatMoment(action.nextCheckAt) : active ? '等待安排' : '已收束'}</span>{action.reviewCount > 0 && <span>已复查 {action.reviewCount} 次{action.unchangedChecks > 0 ? `，连续 ${action.unchangedChecks} 次未见新进展` : ''}</span>}</div></details>
      {action.draft && <details className="proactive-draft"><summary>跟进草稿</summary><textarea aria-label={`${action.title}的跟进草稿`} readOnly value={action.draft} rows={4} /><div><span>核对后可复制使用。</span><button className="text-button" onClick={() => void onCopy(action.draft)}><Copy size={12} />复制草稿</button></div></details>}
      </div>
    </div>
  </article>;
}

function HistoryItem({ event, title }: { event: ProactiveHistory; title?: string }) {
  return <article><div><strong>{HISTORY_LABELS[event.kind] || '行动记录已更新'}</strong><time dateTime={event.createdAt}>{formatMoment(event.createdAt)}</time></div>{title && <small>{title}</small>}{event.note && <p>{event.note}</p>}</article>;
}

function ActionDialog({ action, kind, close, onSaved, onConflict }: {
  action: ProactiveAction; kind: ProactiveOperation; close: () => void; onSaved: () => void; onConflict: () => void;
}) {
  const needsTime = kind === 'watch' || kind === 'snooze';
  const [nextCheckAt, setNextCheckAt] = useState(() => nextTime(1));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = new Date(nextCheckAt);
    if (needsTime && (!nextCheckAt || !Number.isFinite(next.getTime()) || next.getTime() <= Date.now())) { setError('请选择未来的复查时间。'); return; }
    if (needsTime && !note.trim()) { setError(kind === 'watch' ? '请记录这次跟进做了什么或对方的承诺。' : '请记录暂缓原因。'); return; }
    setBusy(true); setError('');
    try {
      await execute('update_proactive_action', { actionId: action.id, baseVersion: action.version, operation: kind, ...(needsTime ? { nextCheckAt: next.toISOString() } : {}), note: note.trim() });
      if (alive.current) onSaved();
    } catch (caught) {
      if (alive.current) {
        const failure = asError(caught);
        setError(failure.code === 'VERSION_CONFLICT' ? '行动已有新变化，请关闭此窗口，核对最新建议后再操作。' : failure.message);
        setStale(failure.code === 'VERSION_CONFLICT');
        onConflict();
      }
    } finally { if (alive.current) setBusy(false); }
  };
  return <Dialog title={OPERATION_LABELS[kind]} subtitle={action.title} close={close} busy={busy}><form onSubmit={submit}><div className="dialog-body proactive-form">{needsTime && <><label><span className="field-label">下次复查时间</span><input aria-label="下次复查时间" type="datetime-local" value={nextCheckAt} onChange={(event) => setNextCheckAt(event.target.value)} required disabled={busy} /></label><div className="proactive-quick-times">{([1, 4, 'tomorrow'] as const).map((value) => <button type="button" key={value} className="button secondary compact" disabled={busy} onClick={() => setNextCheckAt(nextTime(value))}>{value === 'tomorrow' ? '明日 09:00' : `${value} 小时后`}</button>)}</div></>}<label><span className="field-label">{kind === 'watch' ? '本次跟进与预期结果' : kind === 'snooze' ? '暂缓原因' : '备注'}{!needsTime && <span>可选</span>}</span><textarea aria-label={kind === 'watch' ? '本次跟进与预期结果' : kind === 'snooze' ? '暂缓原因' : '行动备注'} rows={4} value={note} maxLength={5000} required={needsTime} placeholder={kind === 'watch' ? '例如：已确认由小林今天下午提交联调结果，届时复查。' : kind === 'snooze' ? '说明为什么稍后再处理。' : '记录本次调整的原因。'} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label><p className="proactive-form-hint">{kind === 'watch' ? '到时会检查最新记录；需要继续推进时，行动会回到“现在处理”。' : kind === 'snooze' ? '到期后恢复检查，暂缓期间保留已有跟进记录。' : kind === 'dismiss' ? '忽略后保留历史，可随时重新跟进。' : '重新纳入需要处理的行动，继续检查相关进展。'}</p>{error && <div className="form-error" role="alert"><CircleAlert size={15} />{error}</div>}</div><div className="dialog-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || stale || needsTime && (!note.trim() || !nextCheckAt)}>{busy && <Spinner />}{OPERATION_LABELS[kind]}</button></div></form></Dialog>;
}
