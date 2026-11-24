import { RetentionLabel } from './RetentionFields';
import type { RetentionPolicy } from '../types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronRight, Pause, Play, Plus, RefreshCw, ShieldAlert, Sparkles, Trash2 } from 'lucide-react';
import { execute, asError } from '../api';
import type {
  EntityAlias,
  FeishuCapabilityId,
  FeishuCapabilityState,
  FeishuPermissionsStatus,
  HabitCategory,
  HabitProposal,
  HabitsCenter,
  MemoryAuditItem,
  MemoryAuditsResponse,
  MemoryDetail,
  Project,
  SourceDetail,
  UserHabit,
} from '../types';
import { Dialog, Spinner } from './ui';
import { MemoryQualityPanel } from './MemoryWorkbench';

interface Policy { enabled: boolean; idleSeconds: number; dailyCalls: number; autoNew: boolean }
interface Subscription { kind: 'chat' | 'document'; target: string; projectId: string; enabled: boolean; historyDays: number }
interface SyncConfig { enabled: boolean; intervalSeconds: number; sources: Subscription[] }
interface Review { retention?: RetentionPolicy; id: string; proposalId: string; projectId: string; sourceId: string; sourceTitle: string; content: string; disposition: string; targetId: string | null; targetRevision: number | null; targetContent: string | null; currentTargetRevision: number | null; currentTargetContent: string | null; reason: string; quotes: Array<{ segmentId: string; quote: string }> }
interface Maintenance { settings: Policy; reviews: Review[]; runs: Array<{ id: string; kind: string; subjectId: string; status: string; message: string; updatedAt: string }>; origins: Array<{ sourceId: string; provider: string; remoteRevision: string; url: string; author: string; occurredAt: string; fetchedAt: string }>; callsToday: number; blockedReason?: string | null }
interface SyncStatus {
  settings: SyncConfig; syncing: boolean; lastError?: string | null; pausedCount?: number;
  permissions?: FeishuPermissionsStatus;
  statuses: Array<{ target: string; projectId: string; at: string; through?: string | null; imported: number; error: string | null; paused?: boolean; pauseReason?: string | null; capabilityId?: FeishuCapabilityId }>;
}
const disposition: Record<string, string> = { new: '新内容', duplicate: '相似记忆', conflict: '内容有变化', uncertain: '需要确认' };
const CAP_LABEL: Record<FeishuCapabilityState, string> = { enabled: '已开启', ready_to_confirm: '已获批待确认', pending_approval: '待审批', unavailable: '未开启' };
const SOURCE_CAP_IDS: FeishuCapabilityId[] = ['docx_sync', 'wiki_sync', 'group_sync'];
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

const ALIAS_KIND_LABELS: Record<EntityAlias['kind'], string> = {
  person: '人名 / 花名',
  project: '项目简称',
  term: '团队术语',
};

function EntityAliasesPanel({ projects, onSaved }: { projects: Project[]; onSaved: () => Promise<unknown> }) {
  const [items, setItems] = useState<EntityAlias[]>([]);
  const [filterProject, setFilterProject] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState<number>(1);
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<EntityAlias['kind']>('person');
  const [canonical, setCanonical] = useState('');
  const [aliasesText, setAliasesText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);

  const load = useCallback(async (scope = filterProject) => {
    setError('');
    try {
      const res = await execute<{ aliases: EntityAlias[] }>('list_entity_aliases', scope ? { projectId: scope } : {});
      if (alive.current) setItems(res.aliases ?? []);
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    }
  }, [filterProject]);

  useEffect(() => {
    alive.current = true;
    void load(filterProject);
    return () => { alive.current = false; };
  }, [filterProject, load]);

  const resetForm = () => {
    setEditingId(null);
    setBaseVersion(1);
    setProjectId(filterProject);
    setKind('person');
    setCanonical('');
    setAliasesText('');
    setNote('');
  };

  const submit = async () => {
    const parsedAliases = aliasesText
      .split(/[,，、;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!canonical.trim() || parsedAliases.length === 0) {
      setError('请填写标准名称以及至少一个别名（用逗号或顿号分隔）。');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      await execute('save_entity_alias', {
        ...(editingId ? { id: editingId, baseVersion } : {}),
        projectId: projectId || null,
        canonical: canonical.trim(),
        aliases: parsedAliases,
        kind,
        note: note.trim(),
      });
      resetForm();
      await load(filterProject);
      await onSaved();
      if (alive.current) setNotice('术语别名已保存，问答检索、AI 副驾驶与冲突比对已即时生效。');
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await execute('delete_entity_alias', { id });
      if (editingId === id) resetForm();
      await load(filterProject);
      await onSaved();
      if (alive.current) setNotice('已删除该别名条目。');
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="entity-aliases-panel">
      <p className="field-hint">
        维护团队人名花名、项目简称与内部黑话（例如「王明 = 老王、后端王哥」「支付重构 = 二期」）。别名仅用于扩大检索召回、实体识别与冲突检出，绝不改写原始资料与已确认记忆正文。
      </p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      <div className="memory-form-row">
        <label>
          作用范围
          <select aria-label="别名作用范围" value={projectId} disabled={busy} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全局（所有项目生效）</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          类型
          <select aria-label="别名类型" value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as EntityAlias['kind'])}>
            <option value="person">人名 / 花名</option>
            <option value="project">项目简称</option>
            <option value="term">团队术语</option>
          </select>
        </label>
      </div>
      <div className="memory-form-row">
        <label>
          标准名称
          <input aria-label="标准名称" placeholder="例如：王明 或 支付重构" value={canonical} disabled={busy} maxLength={120} onChange={(e) => setCanonical(e.target.value)} />
        </label>
        <label>
          别名（逗号或顿号分隔）
          <input aria-label="别名列表" placeholder="例如：老王、后端王哥" value={aliasesText} disabled={busy} onChange={(e) => setAliasesText(e.target.value)} />
        </label>
      </div>
      <label className="field-label" htmlFor="entity-alias-note">备注（可选）</label>
      <input id="entity-alias-note" placeholder="例如：支付网关后端负责人" value={note} disabled={busy} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <div className="memory-source-actions" style={{ marginTop: 10 }}>
        <button type="button" className="button primary compact" disabled={busy || !canonical.trim() || !aliasesText.trim()} onClick={() => void submit()}>
          {busy ? <Spinner /> : <Check size={14} />}
          {editingId ? '更新别名' : '添加别名'}
        </button>
        {editingId && (
          <button type="button" className="button secondary compact" disabled={busy} onClick={resetForm}>
            取消编辑
          </button>
        )}
      </div>

      <h3>已保存术语与别名（{items.length}）</h3>
      <label className="field-label" htmlFor="alias-filter-project">按项目筛选</label>
      <select id="alias-filter-project" value={filterProject} disabled={busy} onChange={(e) => setFilterProject(e.target.value)}>
        <option value="">全部范围</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}（含全局）</option>)}
      </select>
      {items.length === 0 ? (
        <div className="feishu-empty"><p>还没有配置术语别名</p><span>添加常用人名花名或项目简称，问“老王负责的二期进展”也能精准命中正式记忆。</span></div>
      ) : items.map((item) => (
        <article className="memory-subscription" key={item.id}>
          <div className="memory-review-heading">
            <strong>{item.canonical}</strong>
            <span>{ALIAS_KIND_LABELS[item.kind]} · {item.projectId ? (projects.find((p) => p.id === item.projectId)?.name ?? '指定项目') : '全局'}</span>
          </div>
          <p className="field-hint">别名：{item.aliases.join('、')}{item.note ? ` · ${item.note}` : ''}</p>
          <div className="memory-review-actions">
            <button
              type="button"
              className="text-button tiny"
              disabled={busy}
              onClick={() => {
                setEditingId(item.id);
                setBaseVersion(item.version);
                setProjectId(item.projectId ?? '');
                setKind(item.kind);
                setCanonical(item.canonical);
                setAliasesText(item.aliases.join('、'));
                setNote(item.note);
              }}
            >
              编辑
            </button>
            <button type="button" className="text-button tiny" disabled={busy} onClick={() => void remove(item.id)}>
              删除
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

const HABIT_CATEGORY_LABELS: Record<HabitCategory, string> = {
  writing: '写作风格',
  reminder: '提醒节奏',
  workflow: '操作习惯',
  filtering: '信息筛选',
};

const HABIT_SOURCE_LABELS: Record<string, string> = {
  report_edit: '日报/周报改稿',
  proactive_feedback: '主动提醒反馈',
  proposal_edit: '候选记忆反馈',
  copilot_approval: '副驾驶确认卡',
  memory_correction: '记忆修订反馈',
  explicit_feedback: '明确偏好反馈',
};

const AUDIT_KIND_LABELS: Record<MemoryAuditItem['kind'], string> = {
  date_conflict: '日期不一致',
  owner_conflict: '负责人冲突',
  negation_conflict: '肯定/取消矛盾',
  duplicate_overlap: '高度重复',
};

function HabitProposalCard({
  proposal,
  projects,
  disabled,
  onResolve,
}: {
  proposal: HabitProposal;
  projects: Project[];
  disabled: boolean;
  onResolve: (proposal: HabitProposal, action: 'confirm' | 'reject', title?: string, instruction?: string) => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [instruction, setInstruction] = useState(proposal.instruction);
  const scopeName = proposal.projectId
    ? (projects.find((p) => p.id === proposal.projectId)?.name ?? '指定项目')
    : '全局';

  return (
    <article className="memory-review">
      <div className="memory-review-heading">
        <strong>{HABIT_CATEGORY_LABELS[proposal.category]} · {proposal.title}</strong>
        <span>{scopeName} · 触发 {proposal.evidenceCount} 次 · 置信度 {Math.round(proposal.confidence * 100)}%</span>
      </div>
      <div className="memory-form-row">
        <label>
          习惯标题（可修改）
          <input
            aria-label={`习惯建议标题 ${proposal.id}`}
            value={title}
            maxLength={160}
            disabled={disabled}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          执行规则说明（确认后生效）
          <textarea
            aria-label={`习惯建议规则 ${proposal.id}`}
            value={instruction}
            rows={2}
            maxLength={600}
            disabled={disabled}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
      </div>
      {proposal.samples && proposal.samples.length > 0 && (
        <details className="feishu-permissions">
          <summary>查看触发依据（{proposal.samples.length} 条记录）</summary>
          {proposal.samples.map((sample) => (
            <p key={sample.id}>
              <strong>{HABIT_SOURCE_LABELS[sample.sourceKind] ?? sample.sourceKind}</strong> · {time(sample.createdAt)}：{sample.summary}
            </p>
          ))}
        </details>
      )}
      <div className="memory-review-actions">
        <button
          type="button"
          className="button primary compact"
          disabled={disabled || !title.trim() || !instruction.trim()}
          onClick={() => onResolve(proposal, 'confirm', title.trim(), instruction.trim())}
        >
          <Check size={14} />记住这条习惯
        </button>
        <button
          type="button"
          className="button secondary compact"
          disabled={disabled}
          onClick={() => onResolve(proposal, 'reject')}
        >
          忽略
        </button>
      </div>
    </article>
  );
}

function HabitsPanel({
  projects,
  onSaved,
  onPendingCount,
}: {
  projects: Project[];
  onSaved: () => Promise<unknown>;
  onPendingCount?: (count: number) => void;
}) {
  const [center, setCenter] = useState<HabitsCenter | null>(null);
  const [filterProject, setFilterProject] = useState('');
  const [projectId, setProjectId] = useState('');
  const [category, setCategory] = useState<HabitCategory>('writing');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);

  const load = useCallback(async (scope = filterProject) => {
    setError('');
    try {
      const res = await execute<HabitsCenter>('get_habits_center', scope ? { projectId: scope } : {});
      if (!alive.current) return;
      setCenter(res);
      if (!scope) onPendingCount?.(res.counts.pendingProposals);
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    }
  }, [filterProject, onPendingCount]);

  useEffect(() => {
    alive.current = true;
    void load(filterProject);
    return () => { alive.current = false; };
  }, [filterProject, load]);

  const runOp = async (op: () => Promise<void>, successMessage: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await op();
      await load(filterProject);
      await onSaved();
      if (alive.current) setNotice(successMessage);
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const resolveProposal = (
    proposal: HabitProposal,
    action: 'confirm' | 'reject',
    nextTitle?: string,
    nextInstruction?: string,
  ) => {
    void runOp(
      async () => {
        await execute('resolve_habit_proposal', {
          proposalId: proposal.id,
          action,
          ...(nextTitle ? { title: nextTitle } : {}),
          ...(nextInstruction ? { instruction: nextInstruction } : {}),
        });
      },
      action === 'confirm'
        ? '已记住该个人工作习惯，后续写作、提醒与副驾驶交互会自动参考。'
        : '已忽略该习惯建议，短期内不会重复提示。',
    );
  };

  const toggleHabit = (habit: UserHabit) => {
    const nextStatus = habit.status === 'active' ? 'paused' : 'active';
    void runOp(
      async () => {
        await execute('update_habit_status', {
          id: habit.id,
          status: nextStatus,
          baseVersion: habit.version,
        });
      },
      nextStatus === 'paused' ? '已暂停该习惯。' : '已恢复启用该习惯。',
    );
  };

  const removeHabit = (habit: UserHabit) => {
    void runOp(
      async () => {
        await execute('delete_user_habit', { id: habit.id });
      },
      '已删除该个人习惯。',
    );
  };

  const createHabit = () => {
    if (!title.trim() || !instruction.trim()) {
      setError('请填写习惯标题和具体规则说明。');
      return;
    }
    void runOp(
      async () => {
        await execute('save_user_habit', {
          projectId: projectId || null,
          category,
          title: title.trim(),
          instruction: instruction.trim(),
        });
        setTitle('');
        setInstruction('');
      },
      '已保存个人工作习惯并立即生效。',
    );
  };

  const proposals = center?.proposals ?? [];
  const habits = center?.habits ?? [];
  const observations = center?.recentObservations ?? [];

  return (
    <div className="habits-panel">
      <p className="field-hint">
        系统会从你的日报/周报改稿、主动提醒反馈与副驾驶确认卡中提炼重复出现的工作习惯。<strong>所有习惯必须经你确认才会生效</strong>，且仅用于风格表达、提醒优先级与操作建议，绝不改写已确认的客观项目事实。
      </p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="inline-success" role="status">{notice}</p>}

      <label className="field-label" htmlFor="habits-filter-project">按项目筛选</label>
      <select
        id="habits-filter-project"
        value={filterProject}
        disabled={busy}
        onChange={(e) => setFilterProject(e.target.value)}
      >
        <option value="">全部范围</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}（含全局）</option>)}
      </select>

      <h3><Sparkles size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />待确认习惯建议（{proposals.length}）</h3>
      {!center ? (
        <p className="field-hint"><Spinner /> 正在读取习惯记录…</p>
      ) : proposals.length === 0 ? (
        <div className="feishu-empty">
          <p>暂无待确认习惯建议</p>
          <span>当你连续 3 次采用相似的改稿方式、提醒处理或参数调整，或在副驾驶确认卡中勾选“记住为个人习惯”时，会在这里汇总。</span>
        </div>
      ) : (
        proposals.map((proposal) => (
          <HabitProposalCard
            key={proposal.id}
            proposal={proposal}
            projects={projects}
            disabled={busy}
            onResolve={resolveProposal}
          />
        ))
      )}

      <h3>已记住的工作习惯（{habits.length}）</h3>
      {habits.length === 0 ? (
        <p className="field-hint">还没有已启用的个人工作习惯，可在下方手动添加或等待系统从你的操作中提炼。</p>
      ) : (
        habits.map((habit) => {
          const scopeLabel = habit.projectId
            ? (projects.find((p) => p.id === habit.projectId)?.name ?? '指定项目')
            : '全局';
          return (
            <article className="memory-subscription" key={habit.id}>
              <div className="memory-review-heading">
                <strong>{habit.title}</strong>
                <span>
                  {HABIT_CATEGORY_LABELS[habit.category]} · {scopeLabel} · {habit.status === 'active' ? '生效中' : '已暂停'}
                </span>
              </div>
              <p className="field-hint">{habit.instruction}</p>
              <p className="field-hint">
                已应用 {habit.appliedCount} 次 · 采纳 {habit.acceptedCount} · 覆盖 {habit.overriddenCount} · 效用分 {Math.round(habit.utilityScore * 100)}%
              </p>
              {habit.lowUtilityWarning && (
                <p className="inline-error">
                  近期多次被你的操作覆盖，这条习惯可能已不符合当前工作方式，建议暂停或删除。
                </p>
              )}
              <div className="memory-review-actions">
                <button type="button" className="button secondary compact" disabled={busy} onClick={() => toggleHabit(habit)}>
                  {habit.status === 'active' ? <><Pause size={13} />暂停</> : <><Play size={13} />恢复启用</>}
                </button>
                <button type="button" className="text-button tiny" disabled={busy} onClick={() => removeHabit(habit)}>
                  删除
                </button>
              </div>
            </article>
          );
        })
      )}

      <h3>手动添加个人习惯</h3>
      <div className="memory-form-row">
        <label>
          作用范围
          <select aria-label="习惯作用范围" value={projectId} disabled={busy} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全局（所有项目生效）</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          习惯类别
          <select aria-label="习惯类别" value={category} disabled={busy} onChange={(e) => setCategory(e.target.value as HabitCategory)}>
            <option value="writing">写作风格</option>
            <option value="reminder">提醒节奏</option>
            <option value="workflow">操作习惯</option>
            <option value="filtering">信息筛选</option>
          </select>
        </label>
      </div>
      <label className="field-label" htmlFor="habit-manual-title">习惯标题</label>
      <input
        id="habit-manual-title"
        placeholder="例如：周报风险项先写影响与责任人"
        value={title}
        maxLength={160}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="field-label spaced" htmlFor="habit-manual-instruction">具体规则说明</label>
      <textarea
        id="habit-manual-instruction"
        rows={2}
        placeholder="例如：润色周报时先列出阻塞风险与责任人，再写本周完成项，不自动编造进度百分比。"
        value={instruction}
        maxLength={600}
        disabled={busy}
        onChange={(e) => setInstruction(e.target.value)}
      />
      <div className="memory-source-actions">
        <button
          type="button"
          className="button primary compact"
          disabled={busy || !title.trim() || !instruction.trim()}
          onClick={createHabit}
        >
          {busy ? <Spinner /> : <Plus size={14} />}保存习惯
        </button>
      </div>

      {observations.length > 0 && (
        <details className="feishu-permissions">
          <summary>查看近期行为信号观察（{observations.length}）</summary>
          {observations.map((obs) => (
            <p key={obs.id}>
              <strong>{HABIT_SOURCE_LABELS[obs.sourceKind] ?? obs.sourceKind}</strong> · {time(obs.createdAt)}：{obs.summary}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

function MemoryAuditsSection({
  projects,
  projectId,
  disabled,
  onResolved,
  onCountChange,
}: {
  projects: Project[];
  projectId: string;
  disabled: boolean;
  onResolved: () => Promise<unknown>;
  onCountChange?: (count: number) => void;
}) {
  const [audits, setAudits] = useState<MemoryAuditItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);

  const load = useCallback(async (scope = projectId) => {
    setError('');
    try {
      const res = await execute<MemoryAuditsResponse>('get_memory_audits', scope ? { projectId: scope } : {});
      if (!alive.current) return;
      setAudits(res.audits ?? []);
      if (!scope) onCountChange?.(res.openCount ?? 0);
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    }
  }, [projectId, onCountChange]);

  useEffect(() => {
    alive.current = true;
    void load(projectId);
    return () => { alive.current = false; };
  }, [projectId, load]);

  const runScan = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await execute<MemoryAuditsResponse>('run_memory_audit', projectId ? { projectId } : {});
      if (!alive.current) return;
      setAudits(res.audits ?? []);
      if (!projectId) onCountChange?.(res.openCount ?? 0);
      const scan = res.scan;
      setNotice(
        scan
          ? `巡检完成：扫描 ${scan.scannedProjects} 个项目，新发现 ${scan.newFindings} 项隐性冲突，自动清理 ${scan.autoResolved} 项已过时记录。`
          : '库内冲突巡检已完成。',
      );
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const resolveAudit = async (audit: MemoryAuditItem, action: 'keep_a' | 'keep_b' | 'dismiss') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await execute('resolve_memory_audit', { auditId: audit.id, action });
      await load(projectId);
      await onResolved();
      if (alive.current) {
        setNotice(
          action === 'dismiss'
            ? '已标记为不同事项，两条记忆均保留活跃。'
            : '已保留所选记忆，另一条已转入“仅存原文”归档，不再参与问答检索，完整修订历史已保留。',
        );
      }
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section className="memory-audit-section">
      <h3><ShieldAlert size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />库内隐性冲突巡检（{audits.length}）</h3>
      <p className="field-hint">
        空闲时会自动对已确认的活跃记忆进行零 Token 交叉核对，排查日期改口、负责人变更、肯定/取消矛盾及高度重复项。归档旧记忆不会删除修订历史与原文依据。
      </p>
      <div className="memory-source-actions">
        <button
          type="button"
          className="button secondary compact"
          disabled={disabled || busy}
          onClick={() => void runScan()}
        >
          {busy ? <Spinner /> : <RefreshCw size={14} />}立即巡检库内隐性冲突
        </button>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      {audits.length === 0 ? (
        <p className="field-hint">当前筛选范围内未发现库内活跃记忆隐性冲突。</p>
      ) : (
        audits.map((audit) => (
          <article className="memory-review" key={audit.id}>
            <div className="memory-review-heading">
              <strong>{AUDIT_KIND_LABELS[audit.kind] ?? audit.kind}</strong>
              <span>{projects.find((p) => p.id === audit.projectId)?.name ?? '项目'}</span>
            </div>
            <p className="field-hint">{audit.reason}</p>
            <div className="memory-comparison">
              <div>
                <small>左侧记忆 · v{audit.memoryA.revision} · {audit.memoryA.sourceTitle} · {time(audit.memoryA.updatedAt)}</small>
                <p>{audit.memoryA.content}</p>
              </div>
              <div>
                <small>右侧记忆 · v{audit.memoryB.revision} · {audit.memoryB.sourceTitle} · {time(audit.memoryB.updatedAt)}</small>
                <p>{audit.memoryB.content}</p>
              </div>
            </div>
            <div className="memory-review-actions">
              <button
                type="button"
                className="button primary compact"
                disabled={disabled || busy}
                onClick={() => void resolveAudit(audit, 'keep_a')}
              >
                保留左侧（归档右侧）
              </button>
              <button
                type="button"
                className="button primary compact"
                disabled={disabled || busy}
                onClick={() => void resolveAudit(audit, 'keep_b')}
              >
                保留右侧（归档左侧）
              </button>
              <button
                type="button"
                className="button secondary compact"
                disabled={disabled || busy}
                onClick={() => void resolveAudit(audit, 'dismiss')}
              >
                确认为不同事项
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

export function MemoryCenter({ projects, close, onSaved, initialTab = 'sources', initialReviewProjectId = '', onAccount, onModelSettings }: {
  projects: Project[]; close: () => void; onSaved: () => Promise<unknown>;
  initialTab?: 'sources' | 'reviews' | 'aliases' | 'habits'; initialReviewProjectId?: string; onAccount?: () => void; onModelSettings?: () => void;
}) {
  const [tab, setTab] = useState<'sources' | 'policy' | 'reviews' | 'aliases' | 'habits' | 'history' | 'quality'>(initialTab);
  const [reviewProjectId, setReviewProjectId] = useState(initialReviewProjectId);
  const [data, setData] = useState<Maintenance | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [form, setForm] = useState<SyncConfig | null>(null);
  const [chats, setChats] = useState<Array<{ chatId: string; name: string }>>([]);
  const [openAuditCount, setOpenAuditCount] = useState(0);
  const [pendingHabitCount, setPendingHabitCount] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const alive = useRef(true);
  const refreshing = useRef(false);
  useEffect(() => { setReviewProjectId(initialReviewProjectId); }, [initialReviewProjectId]);
  const refresh = useCallback(async () => {
    const [a, b, auditsRes, habitsRes] = await Promise.all([
      execute<Maintenance>('get_memory_maintenance'),
      execute<SyncStatus>('get_feishu_sources'),
      execute<MemoryAuditsResponse>('get_memory_audits').catch(() => ({ audits: [], openCount: 0 })),
      execute<HabitsCenter>('get_habits_center').catch(() => null),
    ]);
    if (!alive.current) return;
    setData(a); setSync(b);
    setOpenAuditCount(auditsRes.openCount ?? 0);
    if (habitsRes) setPendingHabitCount(habitsRes.counts.pendingProposals ?? 0);
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
  const reviewProject = projects.find((project) => project.id === reviewProjectId);
  const visibleReviews = data?.reviews.filter((review) => !reviewProjectId || review.projectId === reviewProjectId) ?? [];
  const totalReviewBadge = (data?.reviews.length ?? 0) + openAuditCount;
  const patchSource = (index: number, patch: Partial<Subscription>) => setForm((old) => old ? { ...old, sources: old.sources.map((s, i) => i === index ? { ...s, ...patch } : s) } : old);
  const resolve = (review: Review, kind: string, content?: string) => void action(review.id, async () => { await execute('resolve_memory_review', { reviewId: review.id, action: kind, baseRevision: review.targetRevision, content }); setNotice('已处理，记忆历史与原文依据已保留。'); });
  return <Dialog title="记忆中心" subtitle="同步飞书资料，整理项目记忆，确认内容变化与个人习惯。" wide close={close} busy={!!busy}>
    <div className="dialog-body memory-center">
      <div className="segmented-control" role="tablist" aria-label="记忆中心" onKeyDown={navigateTabs}>{([
        ['sources', '资料来源'],
        ['policy', '自动整理'],
        ['reviews', `待确认 ${totalReviewBadge}`],
        ['aliases', '术语别名'],
        ['habits', pendingHabitCount > 0 ? `习惯学习 ${pendingHabitCount}` : '习惯学习'],
        ['history', '整理记录'],
      ] as const).map(([id, label]) => <button type="button" role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls={`memory-panel-${id}`} id={`memory-tab-${id}`} key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="inline-success" role="status">{notice}</p>}
      {tab === 'quality' ? <div role="tabpanel" id="memory-panel-quality" aria-labelledby="memory-tab-quality"><MemoryQualityPanel projects={projects} /></div> : tab === 'aliases' ? <div role="tabpanel" id="memory-panel-aliases" aria-labelledby="memory-tab-aliases"><EntityAliasesPanel projects={projects} onSaved={onSaved} /></div> : tab === 'habits' ? <div role="tabpanel" id="memory-panel-habits" aria-labelledby="memory-tab-habits"><HabitsPanel projects={projects} onSaved={async () => { await refresh(); await onSaved(); }} onPendingCount={setPendingHabitCount} /></div> : !data || !form || !policy ? <p className="field-hint"><Spinner /> 正在读取记忆设置…</p> : <div role="tabpanel" id={`memory-panel-${tab}`} aria-labelledby={`memory-tab-${tab}`}>
        {tab === 'sources' && <>
          <p className="field-hint">选择项目群聊或文档，已获批权限的来源会自动同步，未获批的来源暂缓并在权限通过后自动恢复。{onAccount ? <button className="text-button tiny" disabled={!!busy || dirty || policyDirty} onClick={onAccount}>管理飞书账号与权限<ChevronRight size={12}/></button> : '请先在「飞书助理」中连接账号。'}</p>
          {sync?.permissions && <div className="feishu-cap-chips" aria-label="飞书采集权限状态">
            {SOURCE_CAP_IDS.map((id) => sync.permissions?.capabilities.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c).map((cap) => (
              <span key={cap.id} className={`feishu-cap-badge ${cap.status}`} title={cap.missingScopes.length ? `缺少：${cap.missingScopes.join('、')}` : '权限已就绪'}>{cap.label} · {CAP_LABEL[cap.status]}</span>
            ))}
          </div>}
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
              {status?.paused ? <p className="feishu-source-paused">{status.pauseReason || '等待飞书权限审批，获批并确认后将自动恢复同步。'}</p> : status && <p className={status.error ? 'inline-error' : 'field-hint'}>{time(status.at)} · {status.error ?? `新增 ${status.imported} 份原文${status.through ? `，已同步至 ${time(status.through)}` : ''}`}</p>}
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
          <details className="feishu-permissions"><summary>查看整理规则</summary><p>相同内容合并原文依据；修改、冲突、相似和不确定的内容进入「待确认」。自动加入的记忆会标记「自动整理」，每次变更保留历史。手动导入的候选仍需确认。</p><p>空闲时还会自动执行零 Token 的习惯信号归纳与库内活跃记忆隐性冲突巡检（不消耗每日模型调用额度）。</p><p>仅在应用运行期间整理。恢复备份后需重新启用。</p></details>
          <div className="memory-source-actions"><button className="button primary compact" disabled={!!busy || !policyDirty} onClick={() => void action('policy', async () => { const next = await execute<Policy>('save_memory_maintenance', policy as unknown as Record<string, unknown>); setPolicy(next); setNotice('整理设置已保存。'); })}>保存设置</button><button className="button secondary compact" disabled={!!busy || policyDirty} onClick={() => void action('run', async () => { await execute('run_memory_maintenance'); setNotice('已安排一项整理，可在「整理记录」查看结果。'); })}>立即整理一项</button><button className="text-button tiny" disabled={!!busy} onClick={() => void action('retry', async () => { await execute('retry_memory_maintenance'); await execute('run_memory_maintenance'); setNotice('已安排重新比较。提取失败的资料请在项目中重试。'); })}>重试失败项</button></div>
        </>}
        {tab === 'reviews' && <>
          <label className="field-label" htmlFor="memory-review-project">待确认项目范围</label>
          <select id="memory-review-project" value={reviewProjectId} disabled={!!busy} onChange={(event) => { setReviewProjectId(event.target.value); setNotice(''); }}>
            <option value="">全部项目</option>
            {reviewProjectId && !reviewProject && <option value={reviewProjectId}>指定项目（当前不可用）</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <p className="field-hint">当前显示{reviewProjectId ? `「${reviewProject?.name ?? '指定项目'}」` : '全部项目'}的 {visibleReviews.length} 条待确认内容。</p>
          {visibleReviews.length === 0 ? <div className="feishu-empty"><Check size={25} strokeWidth={1.5} /><p>{reviewProjectId ? '当前项目没有待确认内容' : '没有待确认内容'}</p><span>{reviewProjectId ? '此筛选范围内暂无需要判断的内容变化。' : '同步整理后，需要你判断的内容变化会出现在这里。'}</span>{reviewProjectId && data.reviews.length > 0 && <button type="button" className="text-button tiny" onClick={() => setReviewProjectId('')}>查看全部项目</button>}</div> : visibleReviews.map((review) => <ReviewCard key={review.id} review={review} projects={projects} disabled={!!busy} resolve={resolve} recompare={(r) => void action(r.id, async () => { await execute('recompare_memory_review', { reviewId: r.id }); setNotice('已排队重新比较。'); })} />)}
          <MemoryAuditsSection
            projects={projects}
            projectId={reviewProjectId}
            disabled={!!busy}
            onResolved={async () => { await refresh(); await onSaved(); }}
            onCountChange={setOpenAuditCount}
          />
        </>}
        {tab === 'history' && <>
          <h3>最近整理</h3>{data.runs.length ? data.runs.map((run) => <div className="memory-run" key={run.id}><strong>{run.kind === 'extract' ? '提取候选' : '比较记忆'}</strong><span>{time(run.updatedAt)}</span><p>{run.message}</p><small>{({ running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[run.status]}</small></div>) : <p className="field-hint">还没有整理记录。</p>}
          <h3>最近采集的原文</h3>{data.origins.map((o) => <div className="memory-run" key={o.sourceId}><strong>{o.provider === 'feishu_chat' ? '群消息' : '飞书文档'} · 版本 {o.remoteRevision.slice(0, 12)}</strong><span>采集：{time(o.fetchedAt)}</span><p>作者：{o.author}<br />发生时间：{o.occurredAt}<br /><span className="memory-source-url">{o.url}</span></p></div>)}
        </>}
      </div>}
    </div><div className="dialog-footer"><span className="field-hint">{dirty || policyDirty ? '有未保存的设置' : '项目记忆与原文保存在本机工作区'}</span><button className="button secondary" onClick={close} disabled={!!busy}>关闭</button></div>
  </Dialog>;
}
