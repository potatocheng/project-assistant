import { TextArea } from '@astryxdesign/core/TextArea';
import { Button } from '@astryxdesign/core/Button';
import { readDraft, writeDraft, clearDraft } from '../../drafts';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleAlert, Copy, FilePenLine, FileText, History, Image as ImageIcon, Printer, RotateCcw, Sparkles } from 'lucide-react';
import { asError, copyReport, execute, exportDocument, exportReport } from '../../api';
import { copyRichMarkdown, exportReportCardPng, printMarkdownAsPdf } from './report-export';
import { TASK_CATEGORY, TASK_STATUS } from '../../types';
import type { AppState, DailyReport, Evidence } from '../../types';
import type { ToastAction } from '../interaction';
import { useCopyFeedback } from '../interaction';
import { Spinner } from '../ui';
import { formatMoment, WorkEmpty, WorkFilters } from './shared';

export function ReportWorkspace({ state, day, setDay, projectId, setProjectId, hideProjectFilter = false, onChanged, notify, onTaskOpen, onEvidence }: {
  state: AppState; day: string; setDay: (day: string) => void; projectId: string; setProjectId: (id: string) => void; hideProjectFilter?: boolean;
  onChanged: () => Promise<unknown>; notify: (message: string, error?: boolean, action?: ToastAction) => void;
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
  const [factWarnings, setFactWarnings] = useState<string[]>([]);
  const prePolishContent = useRef<string | null>(null);
  const lastPolishMeta = useRef<{ audience: string; polishedContent: string; appliedHabitIds: string[] } | null>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const copyFeedback = useCopyFeedback();

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) exportMenuRef.current?.removeAttribute('open');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && exportMenuRef.current?.open) {
        event.stopPropagation();
        exportMenuRef.current.open = false;
        exportMenuRef.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  const dirty = !!report && content !== report.content;
  const historical = !!report && !!summaries[0] && report.version < summaries[0].version;
  const scopeName = state.projects.find((project) => project.id === projectId)?.name ?? '全部项目';

  useEffect(() => { setSelectedId((current) => summaries.some((item) => item.id === current) ? current : summaries[0]?.id ?? null); generateId.current = crypto.randomUUID(); }, [day, projectId, summaries.map((item) => item.id).join(',')]);
  useEffect(() => {
    setEditing(false); setFactWarnings([]); prePolishContent.current = null; lastPolishMeta.current = null;
    if (!selectedId) { setReport(null); setContent(''); setError(''); return; }
    let cancelled = false; setLoading(true); setError('');
    execute<DailyReport>('get_daily_report', { reportId: selectedId }).then(async (result) => { const saved = await readDraft<string>(`report:${result.id}`); if (!cancelled) { setReport(result); setContent(saved ?? result.content); setDraftStatus(saved !== null ? '已恢复本机草稿' : ''); saveId.current = crypto.randomUUID(); } })
      .catch((caught) => { if (!cancelled) { setReport(null); setError(asError(caught).message); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, tick]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const refreshAfter = async () => { try { await onChanged(); } catch { notify('已保存，但版本列表暂未同步。', true); } };
  const closeExportMenu = () => { if (exportMenuRef.current) exportMenuRef.current.open = false; };
  const generate = async () => {
    setBusy('generate'); setError(''); setFactWarnings([]); prePolishContent.current = null; lastPolishMeta.current = null;
    try {
      const result = await execute<DailyReport>('generate_daily_report', { date: day, ...(projectId ? { projectId } : {}), clientRequestId: generateId.current });
      setReport(result); setSelectedId(result.id); setContent(result.content); generateId.current = crypto.randomUUID();
      await refreshAfter(); notify('日报已生成。');
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(''); }
  };
  const save = async () => {
    if (!report || !content.trim()) return; setBusy('save'); setError('');
    try {
      const result = await execute<DailyReport>('save_daily_report', {
        reportId: report.id,
        baseVersion: report.version,
        content: content.trim(),
        clientRequestId: saveId.current,
        ...(lastPolishMeta.current ? { polishMeta: lastPolishMeta.current } : {}),
      });
      await clearDraft(`report:${report.id}`); setDraftStatus(''); setFactWarnings([]); prePolishContent.current = null; lastPolishMeta.current = null; setReport(result); setSelectedId(result.id); setContent(result.content); saveId.current = crypto.randomUUID();
      await refreshAfter(); notify('修改已保存为新版本。');
    } catch (caught) { setError(asError(caught).message); } finally { setBusy(''); }
  };
  const restoreSaved = async () => {
    if (!report) return;
    await clearDraft(`report:${report.id}`);
    setContent(report.content); setDraftStatus(''); setFactWarnings([]); prePolishContent.current = null; lastPolishMeta.current = null;
    saveId.current = crypto.randomUUID();
    notify('已恢复到当前已保存版本。');
  };
  const polish = async (style: 'executive' | 'team' | 'client') => {
    if (!report || !content.trim() || historical) return;
    if (!state.aiSettings.configured) {
      notify('请先在左侧「工具与设置 → 模型设置」中配置并允许使用 AI 模型。', true);
      return;
    }
    setBusy(`polish-${style}`); setError('');
    try {
      const res = await execute<{ content: string; model: string; factWarnings?: string[]; appliedHabitIds?: string[] }>('polish_report', {
        content: content.trim(),
        reportType: 'daily',
        style,
        projectId: projectId || null,
        projectName: scopeName,
        dateLabel: report.date,
      });
      const previous = content;
      const targetReport = report;
      prePolishContent.current = previous;
      lastPolishMeta.current = {
        audience: style,
        polishedContent: res.content,
        appliedHabitIds: res.appliedHabitIds ?? [],
      };
      setContent(res.content);
      setEditing(false);
      setFactWarnings(res.factWarnings ?? []);
      void writeDraft(`report:${report.id}`, res.content).catch(() => {});
      saveId.current = crypto.randomUUID();
      const styleLabel = style === 'executive' ? '老板高管版' : style === 'team' ? '项目群对齐版' : '客户汇报版';
      notify(
        res.factWarnings && res.factWarnings.length > 0
          ? `已切换为「${styleLabel}」，请留意页面中的事实核对提示。`
          : `已切换为「${styleLabel}」，请核对后点击「保存修改」。`,
        false,
        {
          label: '撤销润色',
          onClick: async () => {
            if (prePolishContent.current === null) return;
            const rollback = prePolishContent.current;
            prePolishContent.current = null;
            lastPolishMeta.current = null;
            setContent(rollback);
            setFactWarnings([]);
            if (rollback === targetReport.content) {
              await clearDraft(`report:${targetReport.id}`);
              setDraftStatus('');
            } else {
              void writeDraft(`report:${targetReport.id}`, rollback).catch(() => {});
              setDraftStatus('草稿已暂存到本机');
            }
          },
        },
      );
    } catch (caught) {
      setError(asError(caught).message);
    } finally {
      setBusy('');
    }
  };

  return <div className="work-page report-workspace"><div className="work-page-heading"><div><div className="eyebrow">工作记录</div><h2>日报</h2><p>将当天记录的进展整理成日报，编辑后即可复制或导出。</p></div><Button label={(summaries.length ? '重新生成' : '生成日报')} onClick={generate} isDisabled={!!busy || dirty} variant="primary" icon={busy === 'generate' ? <Spinner /> : <FilePenLine size={15} />} /></div>
    <WorkFilters day={day} onDayChange={setDay} projects={state.projects} projectId={projectId} onProjectChange={setProjectId} showProject={!hideProjectFilter} />
    {error && <div className="work-inline-error" role="alert"><CircleAlert size={17} /><p>{error}</p><Button label="重新读取" onClick={() => setTick((value) => value + 1)} className="astryx-inline-action" variant="ghost" /></div>}
    <div className="work-layout report-layout"><section className="report-editor-panel">{loading ? <div className="loading-view"><Spinner />正在加载日报…</div> : !report ? <WorkEmpty title="这一天还没有日报" action={<Button label="生成日报" isDisabled={!!busy} onClick={generate} variant="secondary" icon={<FilePenLine size={15} />} />}>{day} · {scopeName}。根据当天已记录的任务进展生成。</WorkEmpty> : <>
      <div className="report-editor-heading"><div><strong>{report.date} · {scopeName}</strong><span>v{report.version} · {report.edited ? '已编辑' : '自动整理'}</span></div><span className={dirty ? 'report-unsaved' : 'report-saved'}>{dirty ? '未保存' : '已保存'}</span></div>
      {historical && <div className="historical-banner"><History size={15} /><span>历史版本 · 只读</span><Button label="查看最新版" onClick={() => setSelectedId(summaries[0].id)} className="astryx-inline-action" variant="ghost" /></div>}
      {factWarnings.length > 0 && <div className="work-inline-error" role="alert"><CircleAlert size={17} /><p><strong>AI 润色事实核对提示：</strong>{factWarnings.join(' ')}</p><button type="button" className="text-button" onClick={() => setFactWarnings([])}>忽略提示</button></div>}
      {!historical && <div className="report-view-controls" role="group" aria-label="日报显示方式"><Button label="阅读预览" aria-pressed={!editing} onClick={() => setEditing(false)} variant="secondary" size="sm" /><Button label="编辑 Markdown" aria-pressed={editing} onClick={() => setEditing(true)} variant="secondary" size="sm" />
        <span className="report-style-divider" />
        <span className="report-style-label"><Sparkles size={12} />改写视角：</span>
        <button type="button" className="text-button tiny" disabled={!!busy} onClick={() => void polish('executive')}>{busy === 'polish-executive' ? <><Spinner />改写中…</> : '高管摘要'}</button>
        <button type="button" className="text-button tiny" disabled={!!busy} onClick={() => void polish('team')}>{busy === 'polish-team' ? <><Spinner />改写中…</> : '项目群同步'}</button>
        <button type="button" className="text-button tiny" disabled={!!busy} onClick={() => void polish('client')}>{busy === 'polish-client' ? <><Spinner />改写中…</> : '客户汇报'}</button>
      </div>}
      {editing && !historical ? <TextArea label="日报正文" isLabelHidden containerClassName="astryx-report-editor" controlClassName="astryx-report-editor-control" isDisabled={!!busy} value={content} rows={22} onChange={value => { const next = value.slice(0, 100000); setContent(next); setDraftStatus('正在暂存…'); void writeDraft(`report:${report.id}`, next).then(() => setDraftStatus('草稿已暂存到本机')).catch(error => setDraftStatus(`暂存失败：${asError(error).message}`)); saveId.current = crypto.randomUUID(); }} hasSpellCheck={false} /> : <article className="report-markdown" aria-label="日报正文预览"><Markdown remarkPlugins={[remarkGfm]} components={{ table: ({ node, ...props }) => <div className="report-table-scroll"><table {...props} /></div> }}>{content}</Markdown></article>}
      <div className="report-editor-footer"><span>{editing && !historical ? '支持 Markdown · 保存时创建新版本' : dirty ? '正在预览未保存的修改' : 'Markdown 阅读预览'}</span><span>{content.length.toLocaleString()} 字符</span></div>
      <div className="report-actions">
        <Button label="保存修改" isDisabled={!!busy || !dirty || historical || !content.trim()} onClick={save} variant="primary" icon={busy === 'save' ? <Spinner /> : <Check size={15} />} />
        <Button label={copyFeedback.copied ? '已复制' : '复制正文'} isDisabled={!!busy || !content.trim()} onClick={async () => { setBusy('copy-rich'); try { const kind = await copyRichMarkdown(`${scopeName} · 工作日报`, `${report.date} · v${report.version}`, content); copyFeedback.markCopied(); notify(kind === 'rich' ? '已复制带格式正文，可直接粘贴进飞书/企微/Word。' : '已复制日报正文。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }} variant="secondary" icon={busy === 'copy-rich' ? <Spinner /> : copyFeedback.copied ? <Check size={15} className="copy-check-icon" /> : <Copy size={15} />} />
        <details className="export-menu" ref={exportMenuRef}>
          <summary className="button secondary">导出<ChevronDown size={14} /></summary>
          <div className="export-menu-popover" role="menu" aria-label="日报导出选项">
            <button type="button" role="menuitem" disabled={!!busy || !content.trim()} onClick={async () => { closeExportMenu(); setBusy('export-docx'); try { const ok = await exportDocument({ title: `${scopeName} · 工作日报 (${report.date})`, content, format: 'docx', filename: `${report.date}-日报-v${report.version}.docx` }); notify(ok ? 'Word (.docx) 已导出。' : '已取消导出。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}><FileText size={14} />导出 Word (.docx)</button>
            <button type="button" role="menuitem" disabled={!!busy || !content.trim()} onClick={async () => { closeExportMenu(); setBusy('export-png'); try { const ok = await exportReportCardPng({ title: `${scopeName} · 工作日报`, subtitle: `${report.date} · 版本 v${report.version}`, markdown: content, filename: `${report.date}-日报卡.png` }); notify(ok ? '汇报长图 (.png) 已导出。' : '已取消导出。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}><ImageIcon size={14} />生成汇报长图 (.png)</button>
            <button type="button" role="menuitem" disabled={!!busy || !content.trim()} onClick={() => { closeExportMenu(); printMarkdownAsPdf(`${scopeName} · 工作日报`, `${report.date} · v${report.version}`, content); }}><Printer size={14} />打印 / 存为 PDF</button>
            <button type="button" role="menuitem" disabled={!!busy || dirty} title={dirty ? '请先保存修改后再导出已保存版本' : undefined} onClick={async () => { closeExportMenu(); setBusy('export'); try { const exported = await exportReport(report.id, `${report.date}-日报-v${report.version}.md`); notify(exported ? 'Markdown 文件已导出。' : '已取消导出。'); } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}><ArrowDownToLine size={14} />导出 Markdown (.md)</button>
            <button type="button" role="menuitem" disabled={!!busy || !content.trim()} onClick={async () => { closeExportMenu(); setBusy('copy'); try { if (!dirty) { await copyReport(report.id, report.content); notify('已复制当前版本的纯文本。'); } else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(content); notify('已复制当前编辑中的纯文本。'); } else { notify('当前环境不支持直接写入剪贴板，请全选正文复制。', true); } } catch (caught) { notify(asError(caught).message, true); } finally { setBusy(''); } }}><Copy size={14} />复制纯文本</button>
          </div>
        </details>
        {dirty && !historical && <Button label="恢复已保存版本" isDisabled={!!busy} onClick={() => void restoreSaved()} variant="ghost" icon={<RotateCcw size={14} />} />}
      </div>
      {dirty && <p className="report-edit-hint">{draftStatus || '编辑内容自动暂存；保存后创建正式日报版本。'}</p>}
    </>}</section><aside className="report-basis-panel"><div className="report-basis-heading"><h3>生成依据</h3><p>生成时的任务记录，可逐项核对。</p></div>{report ? <><div className="report-basis-summary"><span>{report.basis.events.length} 条进展记录</span><span>{report.basis.tasks.length} 项任务</span></div>{!report.basis.events.length && <p className="panel-hint report-no-events">这一天没有任务进展记录。</p>}{report.basis.events.map((event) => <div className="report-basis-event" key={event.id}><Button label={(event.after.title)} onClick={() => onTaskOpen(event.taskId, event.projectId)} className="astryx-inline-action" variant="ghost" endContent={<ArrowRight size={12} />} /><div className="task-event-change">{event.before ? `${TASK_STATUS[event.before.status]} → ` : '创建 → '}{TASK_STATUS[event.after.status]}</div><p>{event.note}</p><small>{TASK_CATEGORY[event.after.category]} · {event.after.assignee || '负责人待定'}</small>{event.evidence.map((evidence) => <Button label={[(evidence.sourceTitle),"·",(evidence.locator)].join('')} key={evidence.segmentId} onClick={() => onEvidence(evidence)} className="astryx-inline-action" variant="ghost" size="sm" endContent={<ArrowRight size={11} />} />)}</div>)}<div className="report-basis-timestamp">生成于 {formatMoment(report.basis.generatedAt)}</div></> : <p className="panel-hint report-no-events">生成后显示任务记录与原文来源。</p>}
      <div className="report-versions"><h3><History size={14} />版本历史</h3>{summaries.length ? summaries.map((summary) => <button key={summary.id} aria-pressed={selectedId === summary.id} className={selectedId === summary.id ? 'report-version selected' : 'report-version'} onClick={() => setSelectedId(summary.id)}><strong>v{summary.version}</strong><span>{summary.edited ? '已编辑' : '自动整理'}</span><small>{formatMoment(summary.createdAt)}</small></button>) : <p className="panel-hint">生成和保存后，可在这里回看历史版本。</p>}</div>
    </aside></div>
  </div>;
}
