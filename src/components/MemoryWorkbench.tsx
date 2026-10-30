import { useEffect, useState } from 'react';
import { asError, execute } from '../api';
import type { AppState, Project, SourceDetail } from '../types';
import { Spinner } from './ui';
import { DeliveryError, useAlive, useDeliveryQuery } from './delivery/shared';
import type { AssistantCitation, DeliveryProps } from './delivery/types';
import './memory-workbench.css';

interface Preferences {
  role: string; answerStyle: string; reportFormat: string; reminderStyle: string; version: number;
}

export function PreferencesPanel({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useAlive();
  const load = async () => {
    setError('');
    try { const value = await execute<Preferences>('get_assistant_preferences'); if (alive.current) setDraft(value); }
    catch (caught) { if (alive.current) setError(asError(caught).message); }
  };
  useEffect(() => { void load(); }, []);
  const save = async (clear: boolean) => {
    if (!draft || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await execute<Preferences>(clear ? 'clear_assistant_preferences' : 'save_assistant_preferences', { ...draft, baseVersion: draft.version });
      if (alive.current) { setDraft(value); setNotice(clear ? '已清空个人偏好，恢复默认。' : '个人偏好已保存。'); }
      await onChanged();
    } catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(false); }
  };
  return <details className="memory-preferences"><summary>个人偏好</summary><p className="field-hint">由你明确填写。职责供模型组织回答参考，不用于推断“我”是谁；日报格式影响以后生成的日报。</p>
    <DeliveryError message={error} />{notice && <p role="status" className="field-hint">{notice}</p>}
    {!draft ? <button className="button secondary compact" onClick={() => void load()}>读取偏好</button> : <form className="delivery-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <label><span className="field-label">职责说明（可选）</span><textarea aria-label="个人职责说明" rows={2} maxLength={1000} value={draft.role} disabled={busy} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="例如：负责项目交付，优先关注阻塞与待决策事项" /></label>
      <div className="memory-preference-grid">{([
        ['answerStyle', '回答详略', [['standard', '标准'], ['concise', '简洁'], ['detailed', '详细']]],
        ['reportFormat', '日报格式', [['structured', '分节日报'], ['brief', '简短工作简报']]],
        ['reminderStyle', '问答中的跟进措辞', [['standard', '标准'], ['gentle', '温和'], ['direct', '直接']]],
      ] as const).map(([key, label, options]) => <label key={key}><span className="field-label">{label}</span><select aria-label={label} disabled={busy} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}</div>
      <div className="memory-workbench-actions"><button className="button primary compact" disabled={busy}>{busy && <Spinner />}保存偏好</button><button type="button" className="button secondary compact" disabled={busy} onClick={() => void save(true)}>清空偏好</button><button type="button" className="text-button" disabled={busy} onClick={() => void load()}>重新载入</button></div>
    </form>}
  </details>;
}

interface Brief { date: string; createdAt: string; stale: boolean; sections: Array<{ key: string; title: string; items: AssistantCitation[] }>; pendingReviews: Array<{ id: string; content: string; sourceTitle: string; reason: string }>; limitations: string[] }
export function ProjectBriefPanel({ state, projectId, date, onTaskOpen, onMemoryOpen, onManagementOpen, onEvidence }: DeliveryProps) {
  const query = useDeliveryQuery<{ brief: Brief | null }>('get_project_brief', date, projectId, state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useAlive();
  const brief = query.data?.brief;
  const generate = async () => {
    setBusy(true); setError('');
    try { await execute('generate_project_brief', { projectId, date }); if (alive.current) query.refresh(); }
    catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(false); }
  };
  return <section className="delivery-profile memory-project-brief"><div className="delivery-section-heading"><div><h3>项目工作简报</h3><p>汇总当前目标、进展和下一步，每条记录保留依据。</p></div><button className="button secondary compact" disabled={busy || query.loading} onClick={() => void generate()}>{busy && <Spinner />}{brief ? '更新简报' : '生成简报'}</button></div>
    <DeliveryError message={error || query.error} />{query.error && <button className="text-button" onClick={query.refresh}>重新读取</button>}
    {query.loading ? <p className="field-hint"><Spinner />正在读取简报…</p> : !brief ? <p className="field-hint">尚未生成。使用本地记录整理，无需模型。</p> : <>
      {brief.stale && <p className="assistant-stale-notice" role="status">记录或检查日期已有变化，以下是旧快照。请更新简报后判断当前情况。</p>}
      <p className="field-hint">检查日期 {brief.date} · 生成于 {new Date(brief.createdAt).toLocaleString('zh-CN')}</p>
      <div className="memory-brief-sections">{brief.sections.map((section) => <div key={section.key}><h4>{section.title}</h4>{!section.items.length ? <p className="field-hint">暂无符合条件的记录。</p> : section.items.map((item) => <details className="memory-brief-item" key={item.id}><summary>{item.kind === 'memory' ? item.content : item.title}</summary><p>{item.content}</p><small>记录时间：{item.updatedAt || '未记录'}</small><div className="memory-workbench-actions">
        {item.taskId && <button className="text-button" onClick={() => onTaskOpen(item.taskId!, projectId)}>查看任务</button>}
        {item.memoryId && onMemoryOpen && <button className="text-button" onClick={() => onMemoryOpen(item.memoryId!, projectId)}>查看记忆及版本</button>}
        {item.managementId && onManagementOpen && <button className="text-button" onClick={() => onManagementOpen(item.kind as import('../types').ManagementKind, item.managementId!, projectId)}>查看管理记录</button>}
        {item.evidence?.map((evidence) => onEvidence && <button className="text-button" key={evidence.segmentId} onClick={() => onEvidence(evidence)}>{evidence.sourceTitle} · {evidence.locator}</button>)}
      </div></details>)}</div>)}</div>
      {!!brief.pendingReviews.length && <details className="memory-preferences"><summary>待核对内容（{brief.pendingReviews.length > 100 ? '100+' : brief.pendingReviews.length}）</summary><p className="field-hint">以下候选尚未确认。请在记忆中心核对后再作为当前结论。</p>{brief.pendingReviews.slice(0, 100).map((review) => <blockquote key={review.id}><p>{review.content}</p><small>{review.sourceTitle} · {review.reason}</small></blockquote>)}</details>}
      <details className="memory-preferences"><summary>汇总范围</summary>{brief.limitations.map((value, index) => <p key={index} className="field-hint">{value}</p>)}<p className="field-hint">仅展示部分已有任务与记录；“建议跟进”依据阻塞状态和截止日期排序，不代表已经执行。</p></details>
    </>}
  </section>;
}

interface Quality {
  corrections: Array<{ id: string; memoryId: string; question: string; previousContent: string; correctedContent: string; reason: string; toRevision: number; check: string }>;
  assessments: Array<{ id: string; candidateKind: string; verdict: string; errorKind: string; reason: string; snapshot: { title?: string; content?: string } }>;
  counts: { reviewed: number; correct: number; assigneeErrors: number; dateErrors: number; omissions: number }; limited: boolean; checkedAt: string | null;
}
const ERRORS: Record<string, string> = { none: '无错误', content: '内容错误', assignee: '负责人错误', date: '日期错误', status: '状态错误', evidence: '依据不足', omission: '漏提' };
const CHECKS: Record<string, string> = { unchecked: '尚未检查', passed: '召回当前修订', not_recalled: '未召回，请检查问题与内容', superseded: '已有后续修订，跳过旧样本' };

export function MemoryQualityPanel({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  return <><label className="field-label">抽检项目<select aria-label="记忆质量项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{projectId ? <QualityProject key={projectId} projectId={projectId} /> : <p className="field-hint">创建项目后可以抽检。</p>}</>;
}
function QualityProject({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Quality | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [selected, setSelected] = useState('');
  const [errorKind, setErrorKind] = useState('none');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState<SourceDetail | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const alive = useAlive();
  const load = async (check = false) => {
    setBusy(true); setError('');
    try { const [quality, app] = await Promise.all([execute<Quality>(check ? 'check_memory_quality' : 'get_memory_quality', { projectId }), execute<AppState>('get_state')]); if (alive.current) { setData(quality); setState(app); } }
    catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const candidates = [
    ...(state?.proposals ?? []).filter((p) => p.projectId === projectId && p.origin === 'ai' && !p.edited).map((p) => ({ key: `memory:${p.id}`, kind: 'memory', id: p.id, sourceId: p.sourceId, title: `记忆 · ${p.content}`, quotes: p.quotes })),
    ...(state?.taskProposals ?? []).filter((p) => p.projectId === projectId && !p.edited).map((p) => ({ key: `task:${p.id}`, kind: 'task', id: p.id, sourceId: p.sourceId, title: `任务 · ${p.title}；负责人：${p.assignee || '未提取'}；日期：${p.dueDate || p.dueText || '未提取'}；状态：${p.taskStatus}；进度：${p.progress ?? '未提取'}；${p.description}`, quotes: p.quotes })),
    ...(state?.sources ?? []).filter((p) => p.projectId === projectId && p.status === 'ready').map((p) => ({ key: `source:${p.id}`, kind: 'source', id: p.id, sourceId: p.id, title: `漏提检查 · ${p.title}`, quotes: [] as Array<{ segmentId: string; quote: string }> })),
  ];
  const candidate = candidates.find((value) => value.key === selected);
  const sourceId = candidate?.sourceId;
  useEffect(() => {
    let cancelled = false;
    setSource(null); setSourceBusy(false);
    if (sourceId) {
      setSourceBusy(true);
      execute<SourceDetail>('get_source', { sourceId }).then((value) => { if (!cancelled) setSource(value); })
        .catch((caught) => { if (!cancelled) setError(asError(caught).message); })
        .finally(() => { if (!cancelled) setSourceBusy(false); });
    }
    return () => { cancelled = true; };
  }, [sourceId]);
  const save = async () => {
    if (!candidate) return;
    setBusy(true); setError('');
    try {
      const quality = await execute<Quality>('assess_extraction', { candidateKind: candidate.kind, candidateId: candidate.id, sourceId: candidate.id, verdict: errorKind === 'none' ? 'correct' : 'incorrect', errorKind, reason });
      if (alive.current) { setData(quality); setReason(''); }
    } catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="memory-quality"><div className="memory-workbench-actions"><button className="button secondary compact" disabled={busy} onClick={() => void load(true)}>{busy && <Spinner />}检查纠错样本检索</button><button className="text-button" disabled={busy} onClick={() => void load()}>刷新</button></div><DeliveryError message={error} />
    <p className="field-hint">检索检查仅验证问题是否召回当前修订，不调用模型，也不衡量回答或提取的准确率。</p>
    {data && <><h3>纠错样本（{data.corrections.length}{data.limited ? '+' : ''}）</h3>{data.checkedAt && <p className="field-hint">检查时间：{new Date(data.checkedAt).toLocaleString('zh-CN')}</p>}{!data.corrections.length && <p className="field-hint">修订记忆时填写问题与理由，会自动积累样本。</p>}{data.corrections.map((sample) => <details className="memory-brief-item" key={sample.id}><summary>{CHECKS[sample.check]} · {sample.question}</summary><p>原内容：{sample.previousContent}</p><p>纠正为（v{sample.toRevision}）：{sample.correctedContent}</p><p>原因：{sample.reason}</p></details>)}
      <h3>人工提取抽检</h3><p className="field-hint">已标注 {data.counts.reviewed} 份快照，其中正确 {data.counts.correct}，负责人错误 {data.counts.assigneeErrors}，日期错误 {data.counts.dateErrors}，漏提 {data.counts.omissions}。同一快照重复保存会更新标注。这些是所选样本统计，不代表整体准确率。</p>
    </>}
    <form className="delivery-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><label><span className="field-label">选择未经人工编辑的 AI 候选或检查漏提</span><select aria-label="抽检对象" value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value); setErrorKind(event.target.value.startsWith('source:') ? 'omission' : 'none'); }}><option value="">请选择</option>{candidates.map((value) => <option key={value.key} value={value.key}>{value.title.slice(0, 100)}</option>)}</select></label>
      {candidate && <div><p className="memory-quality-content">{candidate.title}</p>{candidate.quotes.map((quote, index) => <blockquote key={`${quote.segmentId}:${index}`}>{quote.quote}</blockquote>)}</div>}
      {sourceBusy && <p className="field-hint"><Spinner />正在读取原文…</p>}{source && source.source.id === sourceId && <details className="memory-preferences"><summary>核对原文 · {source.source.title}</summary>{source.segments.map((segment) => <div key={segment.id}><small>{segment.locator}</small><p className="memory-quality-content">{segment.text}</p></div>)}</details>}
      <label><span className="field-label">抽检结论</span><select aria-label="抽检结论" disabled={busy} value={errorKind} onChange={(event) => setErrorKind(event.target.value)}>{Object.entries(ERRORS).filter(([key]) => candidate?.kind === 'source' ? key === 'omission' : key !== 'omission').map(([key, label]) => <option key={key} value={key}>{key === 'none' ? '提取正确' : label}</option>)}</select></label>
      <label><span className="field-label">说明{errorKind !== 'none' && '（必填，请记录预期内容及原文位置）'}</span><textarea aria-label="抽检说明" value={reason} maxLength={2000} rows={2} required={errorKind !== 'none'} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label><button className="button primary compact" disabled={busy || !candidate || (errorKind !== 'none' && !reason.trim())}>保存抽检</button>
    </form>
    {!!data?.assessments.length && <details className="memory-preferences"><summary>最近抽检记录</summary>{data.assessments.map((sample) => <div className="memory-brief-item" key={sample.id}><strong>{ERRORS[sample.errorKind]}</strong><p>{sample.snapshot.content || sample.snapshot.title}</p><p>{sample.reason}</p></div>)}</details>}
  </div>;
}
