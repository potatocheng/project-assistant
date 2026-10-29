import { RetentionLabel } from './RetentionFields';
import type { RetentionPolicy } from '../types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { execute, asError } from '../api';
import type { Project, MemoryDetail, SourceDetail } from '../types';
import { Dialog, Spinner } from './ui';
import { MemoryQualityPanel } from './MemoryWorkbench';

interface Policy { enabled: boolean; idleSeconds: number; dailyCalls: number; autoNew: boolean }
interface Subscription { kind: 'chat' | 'document'; target: string; projectId: string; enabled: boolean; historyDays: number }
interface SyncConfig { enabled: boolean; intervalSeconds: number; sources: Subscription[] }
interface Review { retention?: RetentionPolicy; id: string; proposalId: string; projectId: string; sourceId: string; sourceTitle: string; content: string; disposition: string; targetId: string | null; targetRevision: number | null; targetContent: string | null; currentTargetRevision: number | null; currentTargetContent: string | null; reason: string; quotes: Array<{ segmentId: string; quote: string }> }
interface Maintenance { settings: Policy; reviews: Review[]; runs: Array<{ id: string; kind: string; subjectId: string; status: string; message: string; updatedAt: string }>; origins: Array<{ sourceId: string; provider: string; remoteRevision: string; url: string; author: string; occurredAt: string; fetchedAt: string }>; callsToday: number; blockedReason?: string | null }
interface SyncStatus { settings: SyncConfig; syncing: boolean; lastError?: string | null; statuses: Array<{ target: string; projectId: string; at: string; through?: string | null; imported: number; error: string | null }> }
const disposition: Record<string, string> = { new: '新内容', duplicate: '相似记忆', conflict: '内容有变化', uncertain: '需要确认' };
const time = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });

function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

function ReviewCard({ review, projects, disabled, resolve, recompare }: { review: Review; projects: Project[]; disabled: boolean; resolve: (review: Review, action: string, content?: string) => void; recompare: (review: Review) => void }) {
  const [evidence, setEvidence] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [content, setContent] = useState(review.content);
  const [loading, setLoading] = useState(false);
  const stale = review.targetId !== null && review.targetRevision !== review.currentTargetRevision;
  const inspect = async () => {
    setLoading(true); setError('');
    try {
      const source = await execute<SourceDetail>('get_source', { sourceId: review.sourceId });
      const items = source.segments.map((s) => `新资料 · ${s.locator}\n${s.text}`);
      if (review.targetId) {
        const old = await execute<MemoryDetail>('get_memory', { memoryId: review.targetId });
        items.unshift(...(old.revisions.find((r) => r.number === old.memory.revision)?.evidence ?? []).map((e) => `当前记忆 · ${e.sourceTitle} · ${e.locator}\n${e.text}`));
      }
      setEvidence(items);
    } catch (caught) { setError(asError(caught).message); } finally { setLoading(false); }
  };
  return <article className="memory-review">
    <div className="memory-review-heading"><strong>{disposition[review.disposition] ?? review.disposition}</strong><span>{projects.find((p) => p.id === review.projectId)?.name}</span></div>
    <p className="field-hint">{review.reason}</p><RetentionLabel policy={review.retention} />
    <div className="memory-comparison">{review.targetId && <div><small>当前记忆 · v{review.currentTargetRevision}</small><p>{review.currentTargetContent}</p></div>}<div><small>新内容 · {review.sourceTitle}</small><textarea aria-label="确认后的记忆内容" value={content} onChange={(e) => setContent(e.target.value)} rows={3} disabled={disabled} /></div></div>
    {review.quotes.map((q, i) => <blockquote key={i}>{q.quote}</blockquote>)}
    {stale && <p className="inline-error">当前记忆已有变化，请重新比较后确认。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="memory-review-actions">
      {stale ? <button className="button secondary compact" disabled={disabled} onClick={() => recompare(review)}>重新比较</button> : <>
        {review.targetId && <button className="button primary compact" disabled={disabled || !content.trim()} onClick={() => resolve(review, 'replace', content)}>更新当前记忆</button>}
        <button className={`button ${review.targetId ? 'secondary' : 'primary'} compact`} disabled={disabled || !content.trim()} onClick={() => resolve(review, 'new', content)}>{review.targetId ? '另存一条记忆' : '确认新增'}</button>
        {review.targetId && review.disposition === 'duplicate' && <button className="button secondary compact" disabled={disabled} onClick={() => resolve(review, 'mergeEvidence')}>仅合并依据</button>}
      </>}
      <button className="button secondary compact" disabled={disabled} onClick={() => resolve(review, 'ignore')}>忽略新内容</button>
      <button className="text-button tiny" disabled={loading} onClick={() => evidence ? setEvidence(null) : void inspect()}>{loading ? <Spinner /> : evidence ? '收起原文' : '查看原文依据'}</button>
    </div>
    {evidence && <div className="memory-evidence">{evidence.map((text, i) => <pre key={i}>{text}</pre>)}</div>}
  </article>;
}

export function MemoryCenter({ projects, close, onSaved, initialTab = 'sources', onAccount, onModelSettings }: {
  projects: Project[]; close: () => void; onSaved: () => Promise<unknown>;
  initialTab?: 'sources' | 'reviews'; onAccount?: () => void; onModelSettings?: () => void;
}) {
  const [tab, setTab] = useState<'sources' | 'policy' | 'reviews' | 'history' | 'quality'>(initialTab);
  const [data, setData] = useState<Maintenance | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [form, setForm] = useState<SyncConfig | null>(null);
  const [chats, setChats] = useState<Array<{ chatId: string; name: string }>>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const alive = useRef(true);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    const [a, b] = await Promise.all([execute<Maintenance>('get_memory_maintenance'), execute<SyncStatus>('get_feishu_sources')]);
    if (!alive.current) return;
    setData(a); setSync(b);
    if (!initialized.current) { setPolicy(a.settings); setForm(b.settings); initialized.current = true; }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => { if (alive.current) setError(asError(e).message); });
    const timer = window.setInterval(() => {
      if (refreshing.current) return;
      refreshing.current = true;
      void refresh().catch((e) => { if (alive.current) setError(asError(e).message); }).finally(() => { refreshing.current = false; });
    }, 4000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refresh]);
  const action = async (name: string, op: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setError(''); setNotice('');
    try { await op(); await refresh(); await onSaved(); } catch (e) { setError(asError(e).message); } finally { if (alive.current) setBusy(''); }
  };
  const dirty = !!form && !!sync && JSON.stringify(form) !== JSON.stringify(sync.settings);
  const policyDirty = !!policy && !!data && (['enabled', 'idleSeconds', 'dailyCalls', 'autoNew'] as const).some((key) => policy[key] !== data.settings[key]);
  const patchSource = (index: number, patch: Partial<Subscription>) => setForm((old) => old ? { ...old, sources: old.sources.map((s, i) => i === index ? { ...s, ...patch } : s) } : old);
  const resolve = (review: Review, kind: string, content?: string) => void action(review.id, async () => { await execute('resolve_memory_review', { reviewId: review.id, action: kind, baseRevision: review.targetRevision, content }); setNotice('已处理，记忆历史与原文依据已保留。'); });
  return <Dialog title="记忆中心" subtitle="同步飞书资料，整理项目记忆，确认内容变化。" wide close={close} busy={!!busy}>
    <div className="dialog-body memory-center">
      <div className="segmented-control" role="tablist" aria-label="记忆中心" onKeyDown={navigateTabs}>{([['sources', '资料来源'], ['policy', '自动整理'], ['reviews', `待确认 ${data?.reviews.length ?? 0}`], ['history', '整理记录']] as const).map(([id, label]) => <button type="button" role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls={`memory-panel-${id}`} id={`memory-tab-${id}`} key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="inline-success" role="status">{notice}</p>}
      {tab === 'quality' ? <div role="tabpanel" id="memory-panel-quality" aria-labelledby="memory-tab-quality"><MemoryQualityPanel projects={projects} /></div> : !data || !form || !policy ? <p className="field-hint"><Spinner /> 正在读取记忆设置…</p> : <div role="tabpanel" id={`memory-panel-${tab}`} aria-labelledby={`memory-tab-${tab}`}>
        {tab === 'sources' && <>
          <p className="field-hint">选择项目群聊或文档，之后自动获取新内容。{onAccount ? <button className="text-button tiny" disabled={!!busy || dirty || policyDirty} onClick={onAccount}>连接飞书账号<ChevronRight size={12}/></button> : '请先在「飞书助理」中连接账号。'}</p>
          {sync?.lastError && <p className="inline-error">{sync.lastError}</p>}
          <label className="checkbox-row"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} disabled={!!busy} />自动同步</label>
          <div className="memory-source-actions"><button className="button secondary compact" disabled={!!busy || !projects.length} onClick={() => setForm({ ...form, sources: [...form.sources, { kind: 'chat', target: '', projectId: projects[0]?.id ?? '', enabled: true, historyDays: 7 }] })}><Plus size={14} />添加群</button><button className="button secondary compact" disabled={!!busy || !projects.length} onClick={() => setForm({ ...form, sources: [...form.sources, { kind: 'document', target: '', projectId: projects[0]?.id ?? '', enabled: true, historyDays: 7 }] })}><Plus size={14} />添加文档</button><button className="text-button tiny" disabled={!!busy} onClick={() => void action('chats', async () => { const result = await execute<{ chats: Array<{ chatId: string; name: string }> }>('list_feishu_chats'); setChats(result.chats); setNotice(`已读取 ${result.chats.length} 个可访问的群。`); })}>读取群列表</button></div>
          {!projects.length && <p className="inline-error">请先创建项目，再指定资料来源。</p>}
          <datalist id="memory-feishu-chats">{chats.map((c) => <option key={c.chatId} value={c.chatId}>{c.name}</option>)}</datalist>
          {form.sources.length === 0 && <div className="feishu-empty"><p>还没有资料来源</p><span>添加飞书群或文档，开始同步项目资料。</span></div>}
          {form.sources.map((source, index) => {
            const status = sync?.statuses.find((s) => s.target === source.target && s.projectId === source.projectId);
            return <article className="memory-subscription" key={index}>
              <div className="memory-review-heading"><label className="checkbox-row"><input type="checkbox" checked={source.enabled} onChange={(e) => patchSource(index, { enabled: e.target.checked })} disabled={!!busy} />{source.kind === 'chat' ? '飞书群' : '飞书文档'}</label><button className="icon-button small" aria-label={`移除来源 ${index + 1}`} disabled={!!busy} onClick={() => setForm({ ...form, sources: form.sources.filter((_, i) => i !== index) })}><Trash2 size={15} /></button></div>
              <label className="field-label" htmlFor={`memory-target-${index}`}>{source.kind === 'chat' ? '群 ID' : '文档链接'}</label><input id={`memory-target-${index}`} list={source.kind === 'chat' ? 'memory-feishu-chats' : undefined} placeholder={source.kind === 'chat' ? '选择已读取的群，或输入 oc_…' : '粘贴飞书 docx 或 wiki 链接'} value={source.target} disabled={!!busy} onChange={(e) => patchSource(index, { target: e.target.value })} />
              <div className="memory-form-row"><label>保存到项目<select aria-label={`来源 ${index + 1} 保存到项目`} value={source.projectId} onChange={(e) => patchSource(index, { projectId: e.target.value })} disabled={!!busy}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{source.kind === 'chat' && <label>首次同步最近几天<input type="number" min={1} max={30} aria-label={`来源 ${index + 1} 首次同步天数`} value={source.historyDays} onChange={(e) => patchSource(index, { historyDays: Number(e.target.value) })} disabled={!!busy} /></label>}</div>
              {status && <p className={status.error ? 'inline-error' : 'field-hint'}>{time(status.at)} · {status.error ?? `新增 ${status.imported} 份原文${status.through ? `，已同步至 ${time(status.through)}` : ''}`}</p>}
            </article>;
          })}
          <details className="feishu-permissions"><summary>同步设置与支持范围</summary><label className="field-label spaced" htmlFor="source-sync-interval">同步间隔（秒）</label><input id="source-sync-interval" type="number" min={60} max={3600} value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: Number(e.target.value) })} disabled={!!busy} /><p>应用运行时同步，仅采集已启用的来源。首次同步后增量读取，同步与自动回复独立设置。</p><p>支持群文字、富文本、话题文字和新版文档正文；暂不支持图片、附件和语音。原文来源与版本会保留。</p></details>
          <div className="memory-source-actions"><button className="button primary compact" disabled={!!busy || !dirty} onClick={() => void action('sources', async () => { const next = await execute<SyncStatus>('save_feishu_sources', form as unknown as Record<string, unknown>); setForm(next.settings); setNotice('资料来源已保存。'); })}><Check size={14} />保存来源</button><button className="button secondary compact" disabled={!!busy || !!sync?.syncing || dirty || !form.enabled} onClick={() => void action('sync', async () => { await execute('sync_feishu_sources'); setNotice('正在后台同步，结果会显示在各来源下方。'); })}>{busy === 'sync' || sync?.syncing ? <Spinner /> : <RefreshCw size={14} />}立即同步</button>{dirty && <span className="field-hint">请先保存来源</span>}</div>
        </>}
        {tab === 'policy' && <>
          {data.blockedReason && <p className="inline-error">{data.blockedReason}</p>}
          <p className="field-hint">空闲时比较飞书资料与已有记忆，内容变化会留待你确认。</p>
          {onModelSettings && <p className="field-hint">整理资料需要已配置的模型。<button className="text-button tiny" disabled={!!busy || dirty || policyDirty} onClick={onModelSettings}>配置模型<ChevronRight size={12}/></button></p>}
          <label className="checkbox-row"><input type="checkbox" checked={policy.enabled} onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })} disabled={!!busy} />空闲时自动整理</label>
          <div className="memory-form-row"><label>空闲等待（秒）<input type="number" min={30} max={3600} value={policy.idleSeconds} onChange={(e) => setPolicy({ ...policy, idleSeconds: Number(e.target.value) })} disabled={!!busy} /></label><label>每日模型调用上限<input type="number" min={1} max={2000} value={policy.dailyCalls} onChange={(e) => setPolicy({ ...policy, dailyCalls: Number(e.target.value) })} disabled={!!busy} /></label></div>
          <label className="checkbox-row"><input type="checkbox" checked={policy.autoNew} onChange={(e) => setPolicy({ ...policy, autoNew: e.target.checked })} disabled={!!busy} />自动记住飞书资料中的独立新事实</label>
          <p className="field-hint">今日已用 {data.callsToday} / {data.settings.dailyCalls} 次调用额度。</p>
          <details className="feishu-permissions"><summary>查看整理规则</summary><p>相同内容合并原文依据；修改、冲突、相似和不确定的内容进入「待确认」。自动加入的记忆会标记「自动整理」，每次变更保留历史。手动导入的候选仍需确认。</p><p>仅在应用运行期间整理。恢复备份后需重新启用。</p></details>
          <div className="memory-source-actions"><button className="button primary compact" disabled={!!busy || !policyDirty} onClick={() => void action('policy', async () => { const next = await execute<Policy>('save_memory_maintenance', policy as unknown as Record<string, unknown>); setPolicy(next); setNotice('整理设置已保存。'); })}>保存设置</button><button className="button secondary compact" disabled={!!busy || policyDirty} onClick={() => void action('run', async () => { await execute('run_memory_maintenance'); setNotice('已安排一项整理，可在「整理记录」查看结果。'); })}>立即整理一项</button><button className="text-button tiny" disabled={!!busy} onClick={() => void action('retry', async () => { await execute('retry_memory_maintenance'); await execute('run_memory_maintenance'); setNotice('已安排重新比较。提取失败的资料请在项目中重试。'); })}>重试失败项</button></div>
        </>}
        {tab === 'reviews' && <>{data.reviews.length === 0 ? <div className="feishu-empty"><Check size={25} strokeWidth={1.5} /><p>没有待确认内容</p><span>同步整理后，需要你判断的内容变化会出现在这里。</span></div> : data.reviews.map((review) => <ReviewCard key={review.id} review={review} projects={projects} disabled={!!busy} resolve={resolve} recompare={(r) => void action(r.id, async () => { await execute('recompare_memory_review', { reviewId: r.id }); setNotice('已排队重新比较。'); })} />)}</>}
        {tab === 'history' && <>
          <h3>最近整理</h3>{data.runs.length ? data.runs.map((run) => <div className="memory-run" key={run.id}><strong>{run.kind === 'extract' ? '提取候选' : '比较记忆'}</strong><span>{time(run.updatedAt)}</span><p>{run.message}</p><small>{({ running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[run.status]}</small></div>) : <p className="field-hint">还没有整理记录。</p>}
          <h3>最近采集的原文</h3>{data.origins.map((o) => <div className="memory-run" key={o.sourceId}><strong>{o.provider === 'feishu_chat' ? '群消息' : '飞书文档'} · 版本 {o.remoteRevision.slice(0, 12)}</strong><span>采集：{time(o.fetchedAt)}</span><p>作者：{o.author}<br />发生时间：{o.occurredAt}<br /><span className="memory-source-url">{o.url}</span></p></div>)}
        </>}
      </div>}
    </div><div className="dialog-footer"><span className="field-hint">{dirty || policyDirty ? '有未保存的设置' : '项目记忆与原文保存在本机工作区'}</span><button className="button secondary" onClick={close} disabled={!!busy}>关闭</button></div>
  </Dialog>;
}
