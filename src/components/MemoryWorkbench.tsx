import { useEffect, useRef, useState } from 'react';
import { asError, execute } from '../api';
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
  const autoRefreshed = useRef('');
  const brief = query.data?.brief;
  const generate = async () => {
    setBusy(true); setError('');
    try { await execute('generate_project_brief', { projectId, date }); if (alive.current) query.refresh(); }
    catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    const key = `${projectId}:${date}:${state.workspace.revision}`;
    if (brief?.stale && !query.loading && !busy && autoRefreshed.current !== key) {
      autoRefreshed.current = key;
      void execute('generate_project_brief', { projectId, date })
        .then(() => { if (alive.current) query.refresh(); })
        .catch(() => {});
    }
  }, [brief?.stale, projectId, date, state.workspace.revision, query.loading, busy]);
  const formatItemTime = (value?: string) => {
    if (!value) return '未记录';
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? value : dt.toLocaleString('zh-CN');
  };
  return <section className="delivery-profile memory-project-brief"><div className="delivery-section-heading"><div><h3>项目工作简报</h3><p>汇总当前目标、进展和下一步，每条记录保留依据。</p></div><button className="button secondary compact" disabled={busy || query.loading} onClick={() => void generate()}>{busy && <Spinner />}{brief ? '立即更新简报' : '生成简报'}</button></div>
    <DeliveryError message={error || query.error} />{query.error && <button className="text-button" onClick={query.refresh}>重新读取</button>}
    {query.loading ? <p className="field-hint"><Spinner />正在读取简报…</p> : !brief ? <p className="field-hint">尚未生成。使用本地记录整理，无需模型。</p> : <>
      {brief.stale && <p className="assistant-stale-notice" role="status">正在同步最新项目变动到简报…</p>}
      <p className="field-hint">检查日期 {brief.date} · 生成于 {new Date(brief.createdAt).toLocaleString('zh-CN')}</p>
      <div className="memory-brief-sections">{brief.sections.map((section) => <div key={section.key}><h4>{section.title}</h4>{!section.items.length ? <p className="field-hint">暂无符合条件的记录。</p> : section.items.map((item) => <details className="memory-brief-item" key={item.id}><summary>{item.kind === 'memory' ? item.content : item.title}</summary><p>{item.content}</p><small>记录时间：{formatItemTime(item.updatedAt)}</small><div className="memory-workbench-actions">
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
