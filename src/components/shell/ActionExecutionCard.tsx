import { useState } from 'react';
import {
  ArrowRight, CalendarClock, Check, ChevronDown, Clock3, Copy, Send,
  Radar, Sparkles, X,
} from 'lucide-react';
import { asError, execute } from '../../api';
import type { ProactiveAction } from '../proactive/types';
import type { AssistantWork, AssistantWorkProposal } from '../proactive/work-types';
import type { Proposal, TaskProposal } from '../../types';
import { KIND_LABELS } from '../../types';
import { AnimatedCollapse, type ToastAction, useCopyFeedback, useStampCollapse } from '../interaction';
import { Spinner } from '../ui';

function nextWorkdayMorningIso(): { iso: string; isMondayShift: boolean } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  let shifted = false;
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    shifted = true;
  }
  d.setHours(9, 0, 0, 0);
  return { iso: d.toISOString(), isMondayShift: shifted };
}

function addWorkdaysYmd(baseYmd: string, workdays: number): string {
  const d = new Date(`${baseYmd}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    return new Date(Date.now() + workdays * 86_400_000).toISOString().slice(0, 10);
  }
  let added = 0;
  while (added < workdays) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
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
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}) {
  const [draft, setDraft] = useState(action.draft || '');
  const [draftOpen, setDraftOpen] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const copyFeedback = useCopyFeedback();
  const collapse = useStampCollapse();
  const nextCheck = nextWorkdayMorningIso();
  const nextCheckLabel = nextCheck.isMondayShift ? '下周一 09:00' : '明日 09:00';

  const runAction = async (
    key: string,
    operation: 'watch' | 'snooze' | 'dismiss',
    note: string,
    copyDraft = false,
  ) => {
    if (busy || collapse.settling) return;
    setBusy(key);
    try {
      let copied = false;
      if (copyDraft && draft.trim()) {
        try {
          await navigator.clipboard.writeText(draft.trim());
          copied = true;
          copyFeedback.markCopied();
        } catch {
          copied = false;
        }
      }
      const updated = await execute<ProactiveAction>('update_proactive_action', {
        actionId: action.id,
        baseVersion: action.version,
        operation,
        ...(operation !== 'dismiss' ? { nextCheckAt: nextCheck.iso } : {}),
        note,
      });
      if (operation === 'dismiss') {
        notify('已忽略本次行动建议。', false, {
          label: '撤销',
          onClick: async () => {
            await execute('update_proactive_action', {
              actionId: action.id,
              baseVersion: updated.version,
              operation: 'reopen',
              note: '撤销在今日行动流的忽略操作',
            });
            await onExecuted();
            notify(`已恢复「${action.title}」。`);
          },
        });
      } else if (copyDraft) {
        notify(
          copied
            ? `已复制跟进话术并记入跟进，${nextCheckLabel} 自动复查。`
            : `已记入跟进，但剪贴板权限受限未能自动复制话术；${nextCheckLabel} 自动复查。`,
          !copied,
        );
        if (!copied) setDraftOpen(true);
      } else {
        notify(
          operation === 'snooze'
            ? `已暂缓至${nextCheckLabel} 再次提醒。`
            : `已记录跟进，${nextCheckLabel} 自动复查。`,
        );
      }
      await collapse.settle(operation === 'dismiss' ? 'dismiss' : 'done', onExecuted);
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={collapse.wrapperClass}>
      <div className="stream-card-collapse-inner">
        <article className={`stream-card is-ai is-executable ${collapse.cardClass}`}>
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
                aria-expanded={draftOpen}
                onClick={() => setDraftOpen(v => !v)}
              >
                {draftOpen ? '收起' : '展开话术'}
                <ChevronDown size={12} />
              </button>
            </div>
            <AnimatedCollapse open={draftOpen}>
              <textarea
                aria-label={`${action.title}的跟进话术`}
                rows={2}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                disabled={!!busy || collapse.settling}
              />
            </AnimatedCollapse>
          </div>
        )}

        <div className="stream-oneclick-bar">
          {action.draft ? (
            <button
              className="button primary compact"
              disabled={!!busy || collapse.settling}
              onClick={() =>
                void runAction(
                  'copy-watch',
                  'watch',
                  `已发出跟进：${draft.trim().slice(0, 180)}`,
                  true,
                )
              }
            >
              {busy === 'copy-watch' ? <Spinner /> : copyFeedback.copied ? <Check size={13} className="copy-check-icon" /> : <Copy size={13} />}
              {busy === 'copy-watch' ? '处理中…' : copyFeedback.copied ? '已复制并跟进' : '复制话术并跟进'}
            </button>
          ) : (
            <button
              className="button primary compact"
              disabled={!!busy || collapse.settling}
              onClick={() =>
                void runAction('watch', 'watch', `已确认推进：${action.suggestedAction || action.title}`)
              }
            >
              {busy === 'watch' ? <Spinner /> : <Check size={13} />}
              {busy === 'watch' ? '记录中…' : '记为已跟进'}
            </button>
          )}
          <button
            className="button secondary compact"
            disabled={!!busy || collapse.settling}
            onClick={() => void runAction('snooze', 'snooze', `暂缓至${nextCheckLabel}复查`)}
          >
            {busy === 'snooze' ? <Spinner /> : <Clock3 size={13} />}
            {nextCheckLabel}提醒
          </button>
          {action.draft && (
            <button className="text-button tiny" disabled={!!busy || collapse.settling} onClick={onOpenFeishu}>
              飞书助理
            </button>
          )}
          <button
            className="text-button tiny"
            disabled={!!busy || collapse.settling}
            onClick={() => void runAction('dismiss', 'dismiss', '在今日行动流忽略')}
          >
            {busy === 'dismiss' ? <Spinner /> : <X size={12} />}
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenDetail}>
            查看依据 <ArrowRight size={12} />
          </button>
        </div>
      </div>
        </article>
      </div>
    </div>
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
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}) {
  const [newDate, setNewDate] = useState(() => addWorkdaysYmd(date, 2));
  const [busy, setBusy] = useState('');
  const collapse = useStampCollapse();

  const decide = async (choice: 'adopt_date' | 'record_follow_up' | 'dismiss') => {
    if (busy || collapse.settling) return;
    setBusy(choice);
    try {
      const proposal = await execute<AssistantWorkProposal>('get_action_proposal', { workId: work.id });
      const available = proposal.choices.find(c => c.id === choice);
      if (!available) {
        onOpenRecord();
        return;
      }
      const nextCheck = nextWorkdayMorningIso();
      await execute('decide_action_proposal', {
        workId: proposal.id,
        baseVersion: proposal.version,
        choice,
        decisionId: crypto.randomUUID(),
        note:
          choice === 'adopt_date'
            ? `在今日行动流顺延截止日期至 ${newDate}`
            : choice === 'record_follow_up'
              ? '已在今日行动流确认跟进，下个工作日复查'
              : '在今日行动流忽略本次推进事项',
        ...(available.needsReviewAt ? { reviewAt: nextCheck.iso } : {}),
        ...(available.needsDate ? { proposedDate: newDate } : {}),
      });
      notify(
        choice === 'adopt_date'
          ? `已顺延截止日至 ${newDate}，并安排复查。`
          : choice === 'record_follow_up'
            ? `已记录跟进，${nextCheck.isMondayShift ? '下周一' : '明日'} 09:00 自动复查。`
            : '已忽略本次事项。',
      );
      await collapse.settle(choice === 'dismiss' ? 'dismiss' : 'done', onExecuted);
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  const kindTag =
    work.kind === 'delay' ? '延期调整' : work.kind === 'memory_conflict' ? '资料冲突' : '到期跟进';

  return (
    <div className={collapse.wrapperClass}>
      <div className="stream-card-collapse-inner">
        <article className={`stream-card is-ai is-executable ${collapse.cardClass}`}>
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
                disabled={!!busy || collapse.settling}
              />
              <button
                className="button seal compact"
                disabled={!!busy || collapse.settling || !newDate}
                onClick={() => void decide('adopt_date')}
              >
                {busy === 'adopt_date' ? <Spinner /> : <CalendarClock size={13} />}
                确认顺延至 {newDate.slice(5)}
              </button>
            </>
          )}
          {work.kind === 'follow_up' && (
            <button
              className="button seal compact"
              disabled={!!busy || collapse.settling}
              onClick={() => void decide('record_follow_up')}
            >
              {busy === 'record_follow_up' ? <Spinner /> : <Check size={13} />}
              {busy === 'record_follow_up' ? '记录中…' : '记为已跟进'}
            </button>
          )}
          {work.kind === 'memory_conflict' && (
            <button className="button primary compact" disabled={!!busy || collapse.settling} onClick={onOpenRecord}>
              前往核对冲突 <ArrowRight size={13} />
            </button>
          )}
          <button
            className="text-button tiny"
            disabled={!!busy || collapse.settling}
            onClick={() => void decide('dismiss')}
          >
            {busy === 'dismiss' ? <Spinner /> : <X size={12} />}
            忽略
          </button>
          {work.kind !== 'memory_conflict' && (
            <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenRecord}>
              查看原记录 <ArrowRight size={12} />
            </button>
          )}
        </div>
      </div>
        </article>
      </div>
    </div>
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
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}) {
  const [busy, setBusy] = useState('');
  const collapse = useStampCollapse();

  const confirm = async (planToday: boolean) => {
    if (busy || collapse.settling) return;
    setBusy(planToday ? 'today' : 'confirm');
    try {
      await execute('confirm_task_proposal', {
        proposalId: proposal.id,
        mode: 'create',
        category: 'action',
        priority: 'medium',
        plannedDate: planToday ? date : null,
        workDate: date,
        note: planToday ? '在今日行动流采纳并加入今日清单' : '在今日行动流采纳为项目任务',
        clientRequestId: crypto.randomUUID(),
      });
      notify(planToday ? '已采纳并加入今日清单。' : '已采纳为项目任务。');
      await collapse.settle('done', onExecuted);
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  const reject = async () => {
    if (busy || collapse.settling) return;
    setBusy('reject');
    try {
      await execute('reject_task_proposal', { proposalId: proposal.id });
      notify('已忽略该任务候选。', false, {
        label: '撤销',
        onClick: async () => {
          await execute('reopen_task_proposal', { proposalId: proposal.id });
          await onExecuted();
          notify(`已恢复任务候选「${proposal.title}」。`);
        },
      });
      await collapse.settle('dismiss', onExecuted);
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={collapse.wrapperClass}>
      <div className="stream-card-collapse-inner">
        <article className={`stream-card is-executable ${collapse.cardClass}`}>
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
          <button className="button seal compact" disabled={!!busy || collapse.settling} onClick={() => void confirm(true)}>
            {busy === 'today' ? <Spinner /> : <Check size={13} />}
            加入今日清单
          </button>
          <button className="button secondary compact" disabled={!!busy || collapse.settling} onClick={() => void confirm(false)}>
            {busy === 'confirm' ? <Spinner /> : null}
            仅收入任务库
          </button>
          <button className="text-button tiny" disabled={!!busy || collapse.settling} onClick={() => void reject()}>
            {busy === 'reject' ? <Spinner /> : <X size={12} />}
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenSource}>
            查看原文 <ArrowRight size={12} />
          </button>
        </div>
      </div>
        </article>
      </div>
    </div>
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
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}) {
  const [busy, setBusy] = useState('');
  const collapse = useStampCollapse();

  const handle = async (accept: boolean) => {
    if (busy || collapse.settling) return;
    setBusy(accept ? 'accept' : 'reject');
    try {
      await execute(accept ? 'confirm_proposal' : 'reject_proposal', { proposalId: proposal.id });
      if (accept) {
        notify('已确认并存入项目记录。');
      } else {
        notify('已忽略该事实候选。', false, {
          label: '撤销',
          onClick: async () => {
            await execute('reopen_proposal', { proposalId: proposal.id });
            await onExecuted();
            notify('已恢复该事实候选。');
          },
        });
      }
      await collapse.settle(accept ? 'done' : 'dismiss', onExecuted);
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={collapse.wrapperClass}>
      <div className="stream-card-collapse-inner">
        <article className={`stream-card is-executable ${collapse.cardClass}`}>
      <div className="stream-card-main">
        <div className="stream-card-meta">
          <span className="stream-tag is-attention">待确认{KIND_LABELS[proposal.kind] ?? '事实'}</span>
          <span>{projectName}</span>
          <span>· {proposal.origin === 'ai' ? 'AI 提取' : '手动整理'}</span>
        </div>
        <h3 className="stream-card-title">{proposal.content}</h3>
        <div className="stream-oneclick-bar">
          <button className="button seal compact" disabled={!!busy || collapse.settling} onClick={() => void handle(true)}>
            {busy === 'accept' ? <Spinner /> : <Check size={13} />}
            确认入库
          </button>
          <button className="text-button tiny" disabled={!!busy || collapse.settling} onClick={() => void handle(false)}>
            {busy === 'reject' ? <Spinner /> : <X size={12} />}
            忽略
          </button>
          <button className="text-button tiny" style={{ marginLeft: 'auto' }} onClick={onOpenSource}>
            查看原文 <ArrowRight size={12} />
          </button>
        </div>
      </div>
        </article>
      </div>
    </div>
  );
}
