import { Selector } from '@astryxdesign/core/Selector';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { FormDialog } from './astryx/FormDialog';
import { Button } from '@astryxdesign/core/Button';
import { useEffect, useState } from 'react';
import { asError, execute } from '../api';
import type { AppState, MemoryDetail, RetentionPolicy } from '../types';
import { localDay } from './work/shared';
import { Spinner } from './ui';
import { RetentionFields } from './RetentionFields';
import { ListPager } from './ListPager';
import { pendingContent } from './workspace-model';

type Review = { id: string; projectId: string; content: string; revision: number; sourceTitle: string; retention: RetentionPolicy };
export function Inbox({ state, projectId: project, onProjectChange: setProject, onChanged, onMemory, onSource, onConflicts }: {
  projectId: string; onProjectChange: (id: string) => void;
  state: AppState; onChanged: () => Promise<unknown>; onMemory: (id: string, project: string) => void;
  onSource: (id: string) => void; onConflicts: () => void;
}) {
  const [source, setSource] = useState('');
  const [candidatePage, setCandidatePage] = useState(0);
  const [tab, setTab] = useState('review'); const [offset, setOffset] = useState(0);
  const [queue, setQueue] = useState<{ items: Review[]; total: number }>({ items: [], total: 0 });
  const [selected, setSelected] = useState<Review | null>(null);
  const [tick, setTick] = useState(0); const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; setLoading(true); void execute<typeof queue>('get_retention_reviews', { date: localDay(), projectId: project, sourceId:source, offset }).then(value => { if (active) { setQueue(value); setError(''); if (offset && offset >= value.total) setOffset(Math.max(0, Math.floor((value.total - 1) / 50) * 50)); } }).catch(e => { if (active) setError(asError(e).message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [project, source, offset, tick, state.workspace.revision]);
  useEffect(() => { setSource(''); setOffset(0); setSelected(null); }, [project]);
  const { tasks: taskCandidates, memories: candidates, drafts } = pendingContent(state, project, source);
  const candidateTotal = tab === 'tasks' ? taskCandidates.length : tab === 'candidates' ? candidates.length : drafts.length;
  const page = Math.min(candidatePage, Math.max(0, Math.ceil(candidateTotal / 50) - 1));
  useEffect(() => setCandidatePage(0), [project, source, tab]);
  return <div className="work-page inbox-page"><div className="work-page-heading"><div><div className="eyebrow">待处理</div><h2>先处理需要你判断的内容</h2><p>复核到期状态、核对新候选，再继续项目工作。</p></div></div>
    <div className="inbox-toolbar">
      <Selector label="待处理项目" isLabelHidden value={project} containerClassName="astryx-filter" onChange={value => { setProject(value); setSource(''); setOffset(0); }}
        options={[{ value: '', label: '全部项目' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))]} />
      <Selector label="待处理来源" isLabelHidden value={source} containerClassName="astryx-filter" onChange={value => { setSource(value); setOffset(0); }}
        options={[{ value: '', label: '全部来源' }, ...state.sources.filter(s => !project || s.projectId === project).map(s => ({ value: s.id, label: s.title }))]} />
      <Button label="记忆冲突与质量反馈" variant="secondary" onClick={onConflicts} />
    </div>
    <div className="astryx-inbox-tabs"><TabList value={tab} onChange={setTab} aria-label="待处理类型" hasDivider>
      {[['review', `到期复核 ${loading ? '…' : queue.total}`], ['tasks', `任务候选 ${taskCandidates.length}`], ['candidates', `记忆候选 ${candidates.length}`], ['drafts', `需澄清 ${drafts.length}`]].map(([value, label]) => <Tab key={value} value={value} label={label} />)}
    </TabList></div>
    {tab === 'tasks' && <div className="inbox-list">{taskCandidates.length === 0 ? <p>当前没有待确认任务。</p> : taskCandidates.slice(page * 50, (page + 1) * 50).map(item => <article key={item.id}><div><small>{state.projects.find(project => project.id === item.projectId)?.name} · {state.sources.find(source => source.id === item.sourceId)?.title}</small><p>{item.title}</p><span className="field-hint">核对原文后，可创建任务或更新已有进展。</span></div><Button label="核对并确认" onClick={() => onSource(item.sourceId)} variant="secondary" size="sm" /></article>)}</div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {tab !== 'tasks' && <div className="inbox-list">{tab === 'review' ? loading ? <Spinner /> : <>{queue.items.length === 0 && <p>当前没有到期的工作记忆。</p>}{queue.items.map(item => <article key={item.id}><div><small>{state.projects.find(p => p.id === item.projectId)?.name} · 复核日 {item.retention.reviewAfter} · v{item.revision}</small><p>{item.content}</p><span className="field-hint">已退出默认问答；关联原文也不会绕过复核用于回答。</span></div><div className="inbox-actions"><Button label="复核处理" onClick={() => setSelected(item)} variant="primary" size="sm" /><Button label="原文与历史" onClick={() => onMemory(item.id, item.projectId)} className="astryx-inline-action" variant="ghost" /></div></article>)}<ListPager page={Math.floor(offset / 50)} total={queue.total} onChange={page => setOffset(page * 50)} /></> : tab === 'candidates' ? <>{candidates.length === 0 && <p>当前没有待确认记忆。</p>}{candidates.slice(page * 50, (page + 1) * 50).map(p => <article key={p.id}><div><small>{state.projects.find(x => x.id === p.projectId)?.name} · {state.sources.find(s => s.id === p.sourceId)?.title}</small><p>{p.content}</p></div><Button label="核对并确认" onClick={() => onSource(p.sourceId)} variant="secondary" size="sm" /></article>)}</> : <>{drafts.length === 0 && <p>当前没有需要澄清的提取内容。</p>}{drafts.slice(page * 50, (page + 1) * 50).map(d => <article key={d.id}><div><p>{d.candidate.content}</p><small>{d.issues.map(i => i.reason).join('；')}</small></div><Button label="查看并澄清" onClick={() => onSource(d.sourceId)} variant="secondary" size="sm" /></article>)}</>}</div>}
    {tab !== 'review' && <ListPager page={page} total={candidateTotal} size={50} onChange={setCandidatePage}/>}
    {selected && <ReviewDialog item={selected} close={() => setSelected(null)} saved={async () => { setSelected(null); setTick(v => v + 1); await onChanged(); }} />}
  </div>;
}
function ReviewDialog({ item, close, saved }: { item: Review; close: () => void; saved: () => Promise<void> }) {
  const [content, setContent] = useState(item.content); const [reason, setReason] = useState('');
  const [policy, setPolicy] = useState<RetentionPolicy>({ ...item.retention, reviewAfter: new Date(Date.now() + 7 * 86400000).toLocaleDateString('sv-SE') });
  const [detail, setDetail] = useState<MemoryDetail | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { let active = true; void execute<MemoryDetail>('get_memory', { memoryId: item.id }).then(v => { if (active) setDetail(v); }).catch(e => { if (active) setError(asError(e).message); }); return () => { active = false; }; }, [item.id]);
  return <FormDialog title="复核工作记忆" subtitle="确认当前内容和适用时间，保存后生成新的记忆修订。" close={close} busy={busy} wide><form onSubmit={async e => { e.preventDefault(); if (busy || !detail || !content.trim() || !reason.trim() || !policy.reason.trim()) return; setBusy(true); setError(''); try { await execute('review_retention', { memoryId: item.id, baseRevision: item.revision, date: localDay(), content, reason, retention: policy }); await saved(); } catch (e) { setError(asError(e).message); } finally { setBusy(false); } }}><div className="dialog-body astryx-form-fields"><TextArea label="当前事实" rows={4} isRequired value={content} onChange={setContent} isDisabled={busy} /><RetentionFields value={policy} onChange={setPolicy} disabled={busy} /><TextArea label="复核理由" isRequired rows={2} value={reason} onChange={value => setReason(value.slice(0, 1000))} isDisabled={busy} /><details><summary>本次修订沿用的原文依据</summary>{detail?.revisions.find(r => r.number === item.revision)?.evidence.map(e => <blockquote key={e.segmentId}><small>{e.sourceTitle} · {e.locator}</small><p>{e.text}</p></blockquote>)}</details><p className="field-hint">继续保留需填写未来复核日；长期记忆恢复默认问答；仅存原文或待澄清继续退出问答。</p>{error && <p className="inline-error" role="alert">{error}</p>}</div><div className="dialog-footer"><Button label="取消" type="button" onClick={close} isDisabled={busy} variant="secondary" /><Button label="保存复核" isDisabled={busy || !detail || !reason.trim() || !content.trim()} type="submit" variant="primary" icon={busy && <Spinner />} /></div></form></FormDialog>;
}
