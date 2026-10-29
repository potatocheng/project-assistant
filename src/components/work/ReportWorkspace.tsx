import { readDraft, writeDraft, clearDraft } from '../../drafts';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, Copy, FilePenLine, History } from 'lucide-react';
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
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const generateId = useRef(crypto.randomUUID()); const saveId = useRef(crypto.randomUUID());
  const [draftStatus, setDraftStatus] = useState('');
  const dirty = !!report && content !== report.content;
  const historical = !!report && !!summaries[0] && report.version < summaries[0].version;
  const scopeName = state.projects.find((project) => project.id === projectId)?.name ?? '全部项目';

  useEffect(() => { setSelectedId((current) => summaries.some((item) => item.id === current) ? current : summaries[0]?.id ?? null); generateId.current = crypto.randomUUID(); }, [day, projectId, summaries.map((item) => item.id).join(',')]);
  useEffect(() => {
    setEditing(false);
    if (!selectedId) { setReport(null); setContent(''); setError(''); return; }
    let cancelled = false; setLoading(true); setError('');
    execute<DailyReport>('get_daily_report', { reportId: selectedId }).then(async (result) => { const saved = await readDraft<string>(`report:${result.id}`); if (!cancelled) { setReport(result); setContent(saved ?? result.content); setDraftStatus(saved !== null ? '已恢复本机草稿' : ''); saveId.current = crypto.randomUUID(); } })
      .catch((caught) => { if (!cancelled) { setReport(null); setError(asError(caught).message); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, tick]);

  const refreshAfter = async () => { try { await onChanged(); } catch { notify('日报已保存，版本列表刷新失败，请重试。', true); } };
  const generate = async () => {
    setBusy('generate'); setError('');
    try {
      const result = await execute<DailyReport>('generate_daily_report', { date: day, ...(projectId ? { projectId } : {}), clientRequestId: generateId.current });
      setReport(result); setSelectedId(result.id); setContent(result.content); generateId.current = crypto.randomUUID();
      await refreshAfter(); notify('日报已生成。');
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(''); }
  };
  const save = async () => {
    if (!report || !content.trim()) return; setBusy('save'); setError('');
    try {
      const result = await execute<DailyReport>('save_daily_report', { reportId: report.id, baseVersion: report.version, content: content.trim(), clientRequestId: saveId.current });
      await clearDraft(`report:${report.id}`); setDraftStatus(''); setReport(result); setSelectedId(result.id); setContent(result.content); saveId.current = crypto.randomUUID();
      await refreshAfter(); notify('修改已保存为新版本。');
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(''); }
  };

  return <div className="work-page report-workspace"><div className="work-page-heading"><div><div className="eyebrow">工作记录</div><h2>日报</h2><p>将当天记录的进展整理成日报，编辑后即可复制或导出。</p></div><button className="button primary" onClick={generate} disabled={!!busy || dirty}>{busy === 'generate' ? <Spinner /> : <FilePenLine size={15} />}{summaries.length ? '重新生成' : '生成日报'}</button></div>
    <WorkFilters day={day} onDayChange={setDay} projects={state.projects} projectId={projectId} onProjectChange={setProjectId} />
    {error && <div className="work-inline-error" role="alert"><CircleAlert size={17} /><p>{error}</p><button className="text-button" onClick={() => setTick((value) => value + 1)}>重新读取</button></div>}
    <div className="work-layout report-layout"><section className="report-editor-panel">{loading ? <div className="loading-view"><Spinner />正在加载日报…</div> : !report ? <WorkEmpty title="这一天还没有日报" action={<button className="button secondary" disabled={!!busy} onClick={generate}><FilePenLine size={15} />生成日报</button>}>{day} · {scopeName}。根据当天已记录的任务进展生成。</WorkEmpty> : <>
      <div className="report-editor-heading"><div><strong>{report.date} · {scopeName}</strong><span>v{report.version} · {report.edited ? '已编辑' : '自动整理'}</span></div><span className={dirty ? 'report-unsaved' : 'report-saved'}>{dirty ? '未保存' : '已保存'}</span></div>
      {historical && <div className="historical-banner"><History size={15} /><span>历史版本 · 只读</span><button className="text-button" onClick={() => setSelectedId(summaries[0].id)}>查看最新版</button></div>}
      {!historical && <div className="report-view-controls" role="group" aria-label="日报显示方式"><button className="button secondary compact" aria-pressed={!editing} onClick={() => setEditing(false)}>阅读预览</button><button className="button secondary compact" aria-pressed={editing} onClick={() => setEditing(true)}>编辑 Markdown</button></div>}
      {editing && !historical ? <textarea className="report-content-editor" aria-label="日报正文" disabled={!!busy} value={content} maxLength={100000} onChange={(event) => { setContent(event.target.value); setDraftStatus('正在暂存…'); void writeDraft(`report:${report.id}`, event.target.value).then(() => setDraftStatus('草稿已暂存到本机')).catch(error => setDraftStatus(`暂存失败：${asError(error).message}`)); saveId.current = crypto.randomUUID(); }} spellCheck={false} /> : <article className="report-markdown" aria-label="日报正文预览"><Markdown remarkPlugins={[remarkGfm]} components={{ table: ({ node, ...props }) => <div className="report-table-scroll"><table {...props} /></div> }}>{content}</Markdown></article>}
      <div className="report-editor-footer"><span>{editing && !historical ? '支持 Markdown · 保存时创建新版本' : dirty ? '正在预览未保存的修改' : 'Markdown 阅读预览'}</span><span>{content.length.toLocaleString()} 字符</span></div>
      <div className="report-actions"><button className="button primary" disabled={!!busy || !dirty || historical || !content.trim()} onClick={save}>{busy === 'save' ? <Spinner /> : <Check size={15} />}保存修改</button><button className="button secondary" disabled={!!busy || dirty} onClick={async () => { setBusy('copy'); try { await copyReport(report.id, report.content); notify('已复制此版本的日报。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}>{busy === 'copy' ? <Spinner /> : <Copy size={15} />}复制日报</button><button className="button secondary" disabled={!!busy || dirty} onClick={async () => { setBusy('export'); try { const exported = await exportReport(report.id, `${report.date}-日报-v${report.version}.md`); notify(exported ? '日报已导出。' : '已取消导出。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}>{busy === 'export' ? <Spinner /> : <ArrowDownToLine size={15} />}导出 Markdown</button></div>
      {dirty && <p className="report-edit-hint">{draftStatus || '编辑内容自动暂存；保存后创建正式日报版本。'}</p>}
    </>}</section><aside className="report-basis-panel"><div className="report-basis-heading"><h3>生成依据</h3><p>生成时的任务记录，可逐项核对。</p></div>{report ? <><div className="report-basis-summary"><span>{report.basis.events.length} 条进展记录</span><span>{report.basis.tasks.length} 项任务</span></div>{!report.basis.events.length && <p className="panel-hint report-no-events">这一天没有任务进展记录。</p>}{report.basis.events.map((event) => <div className="report-basis-event" key={event.id}><button className="text-button" onClick={() => onTaskOpen(event.taskId, event.projectId)}>{event.after.title}<ArrowRight size={12} /></button><div className="task-event-change">{event.before ? `${TASK_STATUS[event.before.status]} → ` : '创建 → '}{TASK_STATUS[event.after.status]}</div><p>{event.note}</p><small>{TASK_CATEGORY[event.after.category]} · {event.after.assignee || '负责人待定'}</small>{event.evidence.map((evidence) => <button className="text-button tiny" key={evidence.segmentId} onClick={() => onEvidence(evidence)}>{evidence.sourceTitle} · {evidence.locator} <ArrowRight size={11} /></button>)}</div>)}<div className="report-basis-timestamp">生成于 {formatMoment(report.basis.generatedAt)}</div></> : <p className="panel-hint report-no-events">生成后显示任务记录与原文来源。</p>}
      <div className="report-versions"><h3><History size={14} />版本历史</h3>{summaries.length ? summaries.map((summary) => <button key={summary.id} aria-pressed={selectedId === summary.id} className={selectedId === summary.id ? 'report-version selected' : 'report-version'} onClick={() => setSelectedId(summary.id)}><strong>v{summary.version}</strong><span>{summary.edited ? '已编辑' : '自动整理'}</span><small>{formatMoment(summary.createdAt)}</small></button>) : <p className="panel-hint">生成和保存后，可在这里回看历史版本。</p>}</div>
    </aside></div>
  </div>;
}
