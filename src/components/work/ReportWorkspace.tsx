import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, Copy, FilePenLine, History, RefreshCw } from 'lucide-react';
import { asError, copyReport, execute, exportReport } from '../../api';
import { TASK_CATEGORY, TASK_STATUS } from '../../types';
import type { AppState, DailyReport, Evidence } from '../../types';
import { Spinner } from '../ui';
import { formatMoment, WorkEmpty, WorkFilters } from './shared';

export function ReportWorkspace({ state, day, setDay, projectId, setProjectId, onChanged, notify, onTaskOpen, onEvidence }: {
  state: AppState; day: string; setDay: (day: string) => void; projectId: string; setProjectId: (id: string) => void;
  onChanged: () => Promise<unknown>; notify: (message: string, error?: boolean) => void;
  onTaskOpen: (taskId: string, projectId: string) => void; onEvidence: (evidence: Evidence) => void;
}) {
  const summaries = (state.reports ?? []).filter((report) => report.date === day && report.projectId === (projectId || null)).sort((a, b) => b.version - a.version);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const generateId = useRef(crypto.randomUUID()); const saveId = useRef(crypto.randomUUID());
  const drafts = useRef(new Map<string, string>());
  const dirty = !!report && content !== report.content;
  const historical = !!report && !!summaries[0] && report.version < summaries[0].version;
  const scopeName = state.projects.find((project) => project.id === projectId)?.name ?? '全部项目';

  useEffect(() => { setSelectedId((current) => summaries.some((item) => item.id === current) ? current : summaries[0]?.id ?? null); generateId.current = crypto.randomUUID(); }, [day, projectId, summaries.map((item) => item.id).join(',')]);
  useEffect(() => {
    if (!selectedId) { setReport(null); setContent(''); setError(''); return; }
    let cancelled = false; setLoading(true); setError('');
    execute<DailyReport>('get_daily_report', { reportId: selectedId }).then((result) => { if (!cancelled) { setReport(result); setContent(drafts.current.get(result.id) ?? result.content); saveId.current = crypto.randomUUID(); } })
      .catch((caught) => { if (!cancelled) { setReport(null); setError(asError(caught).message); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, tick]);

  const refreshAfter = async () => { try { await onChanged(); } catch { notify('日报已保存，但版本列表未能刷新，请重新读取工作区。', true); } };
  const generate = async () => {
    setBusy('generate'); setError('');
    try {
      const result = await execute<DailyReport>('generate_daily_report', { date: day, ...(projectId ? { projectId } : {}), clientRequestId: generateId.current });
      setReport(result); setSelectedId(result.id); setContent(result.content); generateId.current = crypto.randomUUID();
      await refreshAfter(); notify('已根据本地任务事件生成新的日报版本。');
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(''); }
  };
  const save = async () => {
    if (!report || !content.trim()) return; setBusy('save'); setError('');
    try {
      const result = await execute<DailyReport>('save_daily_report', { reportId: report.id, baseVersion: report.version, content: content.trim(), clientRequestId: saveId.current });
      drafts.current.delete(report.id); setReport(result); setSelectedId(result.id); setContent(result.content); saveId.current = crypto.randomUUID();
      await refreshAfter(); notify('修改已保存为新版本，原日报与事件依据继续保留。');
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(''); }
  };

  return <div className="work-page report-workspace"><div className="work-page-heading"><div><div className="eyebrow">本地事件 · 无需模型密钥</div><h2>日报</h2><p>根据当天已记录的进展生成草稿，保留执行与跟进的区别。</p></div><button className="button primary" onClick={generate} disabled={!!busy || dirty}>{busy === 'generate' ? <Spinner /> : <FilePenLine size={15} />}{summaries.length ? '生成新版本' : '生成本地日报'}</button></div>
    <WorkFilters day={day} onDayChange={setDay} projects={state.projects} projectId={projectId} onProjectChange={setProjectId} />
    {error && <div className="work-inline-error" role="alert"><CircleAlert size={17} /><p>{error}</p><button className="text-button" onClick={() => setTick((value) => value + 1)}>重新读取</button></div>}
    <div className="work-layout report-layout"><section className="report-editor-panel">{loading ? <div className="loading-view"><Spinner />正在读取日报版本…</div> : !report ? <WorkEmpty title="这一天还没有日报" action={<button className="button secondary" disabled={!!busy} onClick={generate}><FilePenLine size={15} />根据本地记录生成</button>}>生成范围：{day} · {scopeName}。没有进展记录时会明确说明，不会编造完成事项。</WorkEmpty> : <>
      <div className="report-editor-heading"><div><strong>{report.date} · {scopeName}</strong><span>v{report.version} · {report.edited ? '用户编辑版' : '本地生成稿'}</span></div><span className={dirty ? 'report-unsaved' : 'report-saved'}>{dirty ? '有未保存修改' : '已保存'}</span></div>
      {historical && <div className="historical-banner"><History size={15} /><span>正在查看历史版本，只读保留。</span><button className="text-button" onClick={() => setSelectedId(summaries[0].id)}>打开最新版</button></div>}
      <textarea className="report-content-editor" aria-label="日报正文" value={content} maxLength={100000} readOnly={historical} onChange={(event) => { setContent(event.target.value); if (report) drafts.current.set(report.id, event.target.value); saveId.current = crypto.randomUUID(); }} spellCheck={false} />
      <div className="report-editor-footer"><span>Markdown 文本 · 修改另存新版本</span><span>{content.length.toLocaleString()} 字符</span></div>
      <div className="report-actions"><button className="button primary" disabled={!!busy || !dirty || historical || !content.trim()} onClick={save}>{busy === 'save' ? <Spinner /> : <Check size={15} />}保存修改</button><button className="button secondary" disabled={!!busy || dirty} onClick={async () => { setBusy('copy'); try { await copyReport(report.id, report.content); notify('已复制此版本的日报。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}>{busy === 'copy' ? <Spinner /> : <Copy size={15} />}复制日报</button><button className="button secondary" disabled={!!busy || dirty} onClick={async () => { setBusy('export'); try { const exported = await exportReport(report.id, `${report.date}-日报-v${report.version}.md`); notify(exported ? '日报已导出。' : '已取消导出。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}>{busy === 'export' ? <Spinner /> : <ArrowDownToLine size={15} />}导出 Markdown</button></div>
      {dirty && <p className="report-edit-hint">保存修改后可复制、导出或生成新草稿。切换日期时，本次未保存文本会暂留在应用内。</p>}
    </>}</section><aside className="report-basis-panel"><div className="report-basis-heading"><h3>事件依据</h3><p>保留生成时的任务快照，后续改动不会改写它。</p></div>{report ? <><div className="report-basis-summary"><span>{report.basis.events.length} 条当天事件</span><span>{report.basis.tasks.length} 项任务快照</span></div>{!report.basis.events.length && <p className="panel-hint report-no-events">这一天没有记录到任务进展。</p>}{report.basis.events.map((event) => <div className="report-basis-event" key={event.id}><button className="text-button" onClick={() => onTaskOpen(event.taskId, event.projectId)}>{event.after.title}<ArrowRight size={12} /></button><div className="task-event-change">{event.before ? `${TASK_STATUS[event.before.status]} → ` : '创建 → '}{TASK_STATUS[event.after.status]}</div><p>{event.note}</p><small>{TASK_CATEGORY[event.after.category]} · {event.after.assignee || '负责人待确认'}</small>{event.evidence.map((evidence) => <button className="text-button tiny" key={evidence.segmentId} onClick={() => onEvidence(evidence)}>{evidence.sourceTitle} · {evidence.locator} <ArrowRight size={11} /></button>)}</div>)}<div className="report-basis-timestamp">快照生成于 {formatMoment(report.basis.generatedAt)}</div></> : <p className="panel-hint report-no-events">生成日报后，可在这里核对任务与原文来源。</p>}
      <div className="report-versions"><h3><History size={14} />版本历史</h3>{summaries.length ? summaries.map((summary) => <button key={summary.id} className={selectedId === summary.id ? 'report-version selected' : 'report-version'} onClick={() => setSelectedId(summary.id)}><strong>v{summary.version}</strong><span>{summary.edited ? '用户编辑' : '本地生成'}</span><small>{formatMoment(summary.createdAt)}</small></button>) : <p className="panel-hint">每次生成和保存都会留下版本。</p>}</div>
    </aside></div>
  </div>;
}
