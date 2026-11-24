import { useState } from 'react';
import {
  ArrowRight, CalendarClock, Check, Clock3, Copy, Send,
  Radar, Sparkles, X,
} from 'lucide-react';
import { asError, execute } from '../../api';
import type { ProactiveAction } from '../proactive/types';
import type { AssistantWork, AssistantWorkProposal } from '../proactive/work-types';
import type { Proposal, TaskProposal } from '../../types';
import { KIND_LABELS } from '../../types';
import { Spinner } from '../ui';

function tomorrowMorningIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function addDaysYmd(baseYmd: string, days: number): string {
  const d = new Date(`${baseYmd}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date(Date.now() + days * 86_400_000);
    return fallback.toISOString().slice(0, 10);
  }
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function ProactiveOneClickCard({
  action,
  onExecuted,
  onOpenDetail,
  onOpenFeishu,
  notify,
}: {
  action: ProactiveAction;
  onExecuted: () => Promise<void>;
  onOpenDetail: () => void;
  onOpenFeishu: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState(action.draft || '');
  const [draftOpen, setDraftOpen] = useState(false);
  const [busy, setBusy] = useState<string>('');

  const runAction = async (
    key: string,
    operation: 'watch' | 'snooze' | 'dismiss',
    note: string,
    copyDraft = false,
  ) => {
    if (busy) return;
    setBusy(key);
    try {
      if (copyDraft && draft.trim()) {
        try {
          await navigator.clipboard.writeText(draft.trim());
        } catch {
          // Clipboard may be unavailable in non-secure contexts; still record the action.
        }
      }
      await execute('update_proactive_action', {
        actionId: action.id,
        baseVersion: action.version,
        operation,
        ...(operation !== 'dismiss' ? { nextCheckAt: tomorrowMorningIso() } : {}),
        note,
      });
      await onExecuted();
      notify(
        copyDraft
          ? '已复制跟进话术并记入跟进，明日 09:00 自动复查。'
          : operation === 'snooze'
            ? '已暂缓至明日 09:00 再次提醒。'
            : operation === 'watch'
              ? '已记录跟进，明日 09:00 自动复查。'
              : '已忽略本次行动建议。',
      );
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <article className="stream-card is-ai is-executable">
      <div className="stream-card-main">
        <div className="stream-card-meta">
          <span className="stream-tag is-ai"><Radar size={11} />AI 主动建议</span>
          <span>{action.projectName}</span>
          {action.reviewCount > 0 && <span>· 已复查 {action.reviewCount} 次</span>}
        </div>
        <h3 className="stream-card-title">{action.title}</h3>
        <p className="stream-card-desc">{action.suggestedAction || action.reason}</p>

        {action.draft && (
          <div className="stream-inline-draft">
            <div className="stream-inline-draft-header">
              <span><Send size={12} />已拟好跟进话术（可直接微调）</span>
              <button
                type="button"
                className="text-button tiny"
                onClick={() => setDraftOpen(v => !v)}
              >
                {draftOpen ? '收起' : '展开话术'}
              </button>
            </div>
            {draftOpen && (
              <textarea
                aria-label={`${action.title}的跟进话术`}
                rows={2}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                disabled={!!busy}
              />
            )}
          </div>
        )}

        <div className="stream-oneclick-bar">
          {action.draft ? (
            <button
              className="button primary compact"
              disabled={!!busy}
              onClick={() =>
                void runAction(
                  'copy-watch',
                  'watch',
                  `已发出跟进：${draft.trim().slice(0, 180)}`,
                  true,
                )
              }
            >
              {busy === 'copy-watch' ? <Spinner /> : <Copy size={13} />}
              复制话术并记已跟进
            </button>
          ) : (
            <button
              className="button primary compact"
              disabled={!!busy}
              onClick={() =>
                void runAction('watch', 'watch', `已确认推进：${action.suggestedAction || action.title}`)
              }
            >
              {busy === 'watch' ? <Spinner /> : <Check size={13} />}
              一键记已跟进
            </button>
          )}
          <button
            className="button secondary compact"
            disabled={!!busy}
            onClick={() => void runAction('snooze', 'snooze', '暂缓至明日 09:00 复查')}
          >
            {busy === 'snooze' ? <Spinner /> : <Clock3 size={13} />}
            明日 09:00 提醒
          </button>
          {action.draft && (
            <button className="text-button tiny" disabled={!!busy} onClick={onOpenFeishu}>
              飞书助理
            </button>
          )}
          <button
            className="text-button tiny"
            disabled={!!busy}
            onClick={() => void runAction('dismiss', 'dismiss', '在今日行动流忽略')}
          >
            <X size={12} />
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenDetail}>
            查看依据 <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </article>
  );
}

export function WorkOneClickCard({
  work,
  date,
  onExecuted,
  onOpenRecord,
  notify,
}: {
  work: AssistantWork;
  date: string;
  onExecuted: () => Promise<void>;
  onOpenRecord: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [newDate, setNewDate] = useState(() => addDaysYmd(date, 2));
  const [busy, setBusy] = useState('');

  const decide = async (choice: 'adopt_date' | 'record_follow_up' | 'dismiss') => {
    if (busy) return;
    setBusy(choice);
    try {
      const proposal = await execute<AssistantWorkProposal>('get_action_proposal', { workId: work.id });
      const available = proposal.choices.find(c => c.id === choice);
      if (!available) {
        onOpenRecord();
        return;
      }
      await execute('decide_action_proposal', {
        workId: proposal.id,
        baseVersion: proposal.version,
        choice,
        decisionId: crypto.randomUUID(),
        note:
          choice === 'adopt_date'
            ? `在今日行动流顺延截止日期至 ${newDate}`
            : choice === 'record_follow_up'
              ? '已在今日行动流确认跟进，明日复查'
              : '在今日行动流忽略本次推进事项',
        ...(available.needsReviewAt ? { reviewAt: tomorrowMorningIso() } : {}),
        ...(available.needsDate ? { proposedDate: newDate } : {}),
      });
      await onExecuted();
      notify(
        choice === 'adopt_date'
          ? `已顺延截止日至 ${newDate}，并安排复查。`
          : choice === 'record_follow_up'
            ? '已记录跟进，明日 09:00 自动复查。'
            : '已忽略本次事项。',
      );
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  const kindTag =
    work.kind === 'delay' ? '延期调整' : work.kind === 'memory_conflict' ? '资料冲突' : '到期跟进';

  return (
    <article className="stream-card is-ai is-executable">
      <div className="stream-card-main">
        <div className="stream-card-meta">
          <span className="stream-tag is-ai"><Sparkles size={11} />持续推进 · {kindTag}</span>
          <span>{work.projectName}</span>
        </div>
        <h3 className="stream-card-title">{work.title}</h3>
        <p className="stream-card-desc">{work.summary || work.reason}</p>

        <div className="stream-oneclick-bar">
          {work.kind === 'delay' && (
            <>
              <input
                type="date"
                aria-label="新截止日期"
                className="stream-inline-date"
                min={date}
                value={newDate}
                onChange={e => setNewDate(e.target.value)}
                disabled={!!busy}
              />
              <button
                className="button primary compact"
                disabled={!!busy || !newDate}
                onClick={() => void decide('adopt_date')}
              >
                {busy === 'adopt_date' ? <Spinner /> : <CalendarClock size={13} />}
                顺延至 {newDate.slice(5)}
              </button>
            </>
          )}
          {work.kind === 'follow_up' && (
            <button
              className="button primary compact"
              disabled={!!busy}
              onClick={() => void decide('record_follow_up')}
            >
              {busy === 'record_follow_up' ? <Spinner /> : <Check size={13} />}
              一键记已跟进
            </button>
          )}
          {work.kind === 'memory_conflict' && (
            <button className="button primary compact" disabled={!!busy} onClick={onOpenRecord}>
              前往核对冲突 <ArrowRight size={13} />
            </button>
          )}
          <button
            className="text-button tiny"
            disabled={!!busy}
            onClick={() => void decide('dismiss')}
          >
            <X size={12} />
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenRecord}>
            查看原记录 <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </article>
  );
}

export function InlineTaskProposalCard({
  proposal,
  projectName,
  date,
  onExecuted,
  onOpenSource,
  notify,
}: {
  proposal: TaskProposal;
  projectName: string;
  date: string;
  onExecuted: () => Promise<void>;
  onOpenSource: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState('');

  const confirm = async (planToday: boolean) => {
    if (busy) return;
    setBusy(planToday ? 'today' : 'confirm');
    try {
      await execute('confirm_task_proposal', {
        proposalId: proposal.id,
        mode: 'create',
        category: 'action',
        priority: 'medium',
        plannedDate: planToday ? date : null,
        workDate: date,
        note: '',
        clientRequestId: crypto.randomUUID(),
      });
      await onExecuted();
      notify(planToday ? '已采纳并加入今日清单。' : '已采纳为项目任务。');
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  const reject = async () => {
    if (busy) return;
    setBusy('reject');
    try {
      await execute('reject_task_proposal', { proposalId: proposal.id });
      await onExecuted();
      notify('已忽略该任务候选。');
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <article className="stream-card is-executable">
      <div className="stream-card-main">
        <div className="stream-card-meta">
          <span className="stream-tag is-attention">待确认任务</span>
          <span>{projectName}</span>
          {proposal.assignee && <span>· {proposal.assignee}</span>}
          {proposal.dueDate && <span>· 截止 {proposal.dueDate}</span>}
        </div>
        <h3 className="stream-card-title">{proposal.title}</h3>
        {proposal.description && <p className="stream-card-desc">{proposal.description}</p>}
        <div className="stream-oneclick-bar">
          <button className="button primary compact" disabled={!!busy} onClick={() => void confirm(true)}>
            {busy === 'today' ? <Spinner /> : <Check size={13} />}
            加入今日清单
          </button>
          <button className="button secondary compact" disabled={!!busy} onClick={() => void confirm(false)}>
            {busy === 'confirm' ? <Spinner /> : null}
            仅收入任务库
          </button>
          <button className="text-button tiny" disabled={!!busy} onClick={() => void reject()}>
            <X size={12} />
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenSource}>
            查看原文 <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </article>
  );
}

export function InlineMemoryProposalCard({
  proposal,
  projectName,
  onExecuted,
  onOpenSource,
  notify,
}: {
  proposal: Proposal;
  projectName: string;
  onExecuted: () => Promise<void>;
  onOpenSource: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState('');

  const handle = async (accept: boolean) => {
    if (busy) return;
    setBusy(accept ? 'accept' : 'reject');
    try {
      await execute(accept ? 'confirm_proposal' : 'reject_proposal', { proposalId: proposal.id });
      await onExecuted();
      notify(accept ? '已确认并存入项目记忆。' : '已忽略该事实候选。');
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <article className="stream-card is-executable">
      <div className="stream-card-main">
        <div className="stream-card-meta">
          <span className="stream-tag is-attention">待确认{KIND_LABELS[proposal.kind] ?? '事实'}</span>
          <span>{projectName}</span>
          <span>· {proposal.origin === 'ai' ? 'AI 提取' : '手动整理'}</span>
        </div>
        <h3 className="stream-card-title">{proposal.content}</h3>
        <div className="stream-oneclick-bar">
          <button className="button primary compact" disabled={!!busy} onClick={() => void handle(true)}>
            {busy === 'accept' ? <Spinner /> : <Check size={13} />}
            确认入库
          </button>
          <button className="text-button tiny" disabled={!!busy} onClick={() => void handle(false)}>
            <X size={12} />
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenSource}>
            查看原文 <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </article>
  );
}
