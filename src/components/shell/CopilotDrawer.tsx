import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown, Check, CheckCircle2, ClipboardList, FileText, Plus,
  RotateCcw, Send, Settings2, ShieldAlert, Sparkles, Square, Wrench, X,
} from 'lucide-react';
import type { Agent, AgentEvent } from '@mariozechner/pi-agent-core';
import { asError, execute } from '../../api';
import { clearDraft, readDraft, writeDraft } from '../../drafts';
import { MOTION, prefersReducedMotion } from '../../design/motion';
import type { AppState, AssistantPreferences, EntityAlias, Evidence, HabitsCenter, ManagementKind, Page, UserHabit } from '../../types';
import type { AssistantAnswer, AssistantCitation } from '../delivery/types';
import { type ToastAction, usePresence, useSwipeDismiss } from '../interaction';
import { Spinner, useModalLayer } from '../ui';
import { planCopilotAction } from './copilot-actions';
import {
  createPmCopilotAgent,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './pi-copilot-agent';
import './copilot.css';

interface Props {
  open: boolean;
  onClose: () => void;
  contextLabel: string;
  state: AppState;
  projectId: string;
  date: string;
  initialQuestion: { id: number; text: string } | null;
  onInitialQuestionConsumed: () => void;
  onChanged: () => Promise<unknown>;
  onNavigate: (page: Page) => void;
  onTaskOpen: (taskId: string, projectId: string) => void;
  onEvidence: (evidence: Evidence) => void;
  onManagementOpen: (kind: ManagementKind, id: string, projectId: string) => void;
  onMemoryOpen: (id: string, projectId?: string) => void;
  onModelSettings: () => void;
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}

type TimelineItem =
  | { id: string; kind: 'user'; text: string }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      error?: string;
      citations?: AssistantCitation[];
      action?: { label: string; page: Page };
    }
  | { id: string; kind: 'tool'; toolCallId: string; toolName: string; label: string; status: 'running' | 'done' | 'error' };

const TOOL_LABELS: Record<string, string> = {
  get_projects_overview: '读取项目进度总览',
  list_tasks: '查询任务清单',
  get_governance_items: '查询风险与待决策',
  get_proactive_items: '查询主动推进建议',
  search_project_memory: '检索可信项目记忆与资料',
  ask_verified_memory: '核验项目事实与原文依据',
  create_task: '新建项目任务',
  update_task: '更新任务状态或排期',
  create_risk_or_decision: '记录风险或待决策',
  generate_daily_report: '生成今日工作日报',
};

function sanitizeTimeline(items: TimelineItem[]): TimelineItem[] {
  return items.slice(-60).map(item =>
    item.kind === 'tool' && item.status === 'running'
      ? {
          ...item,
          status: 'error',
          label: item.label.includes('上次已中断') ? item.label : `${item.label}（上次已中断）`,
        }
      : item,
  );
}

export function CopilotDrawer({
  open,
  onClose,
  contextLabel,
  state,
  projectId,
  date,
  initialQuestion,
  onInitialQuestionConsumed,
  onChanged,
  onNavigate,
  onTaskOpen,
  onEvidence,
  onManagementOpen,
  onMemoryOpen,
  onModelSettings,
  notify,
}: Props) {
  const [input, setInput] = useState('');
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{
    request: ToolApprovalRequest;
    draftArgs: Record<string, unknown>;
    rememberAsHabit: boolean;
    resolve: (decision: ToolApprovalDecision) => void;
  } | null>(null);
  const preferencesRef = useRef<AssistantPreferences | null>(null);
  const aliasesRef = useRef<EntityAlias[]>([]);
  const habitsRef = useRef<UserHabit[]>([]);
  const offlineSessionRef = useRef<Map<string, string>>(new Map());
  const profileReadyRef = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let active = true;
    profileReadyRef.current = Promise.all([
      execute<AssistantPreferences>('get_assistant_preferences').catch(() => null),
      execute<{ aliases: EntityAlias[] }>('list_entity_aliases', projectId ? { projectId } : {}).catch(() => null),
      execute<HabitsCenter>('get_habits_center', projectId ? { projectId } : {}).catch(() => null),
    ]).then(([prefs, aliasRes, habitsRes]) => {
      if (!active) return;
      preferencesRef.current = prefs;
      aliasesRef.current = aliasRes?.aliases ?? [];
      habitsRef.current = habitsRes?.habits ?? [];
    });
    return () => {
      active = false;
    };
  }, [open, projectId, state.assistantPreferenceVersion, state.workspace.revision]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const dateRef = useRef(date);
  dateRef.current = date;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const contextLabelRef = useRef(contextLabel);
  contextLabelRef.current = contextLabel;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const agentRef = useRef<Agent | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches,
  );
  const [drawerWidth, setDrawerWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('pa:copilot-w'));
      if (Number.isFinite(saved) && saved >= 300 && saved <= 560) return saved;
    } catch {
      // ignore storage errors
    }
    return 384;
  });
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const presence = usePresence(open, MOTION.exit);
  useModalLayer(drawerRef, isNarrow && presence.mounted);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const copilotReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isNarrow || !presence.mounted) {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    }
  }, [isNarrow, presence.mounted]);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
  }, []);

  useEffect(() => {
    if (!isNarrow || !presence.mounted) return;
    const node = drawerRef.current;
    if (!node) return;
    copilotReturnFocusRef.current = document.activeElement as HTMLElement | null;
    const getFocusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')).filter(el => {
        const cs = window.getComputedStyle(el);
        return (
          el.tabIndex >= 0 &&
          !el.matches(':disabled, input[type="hidden"]') &&
          !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
          el.getClientRects().length > 0 &&
          cs.visibility !== 'hidden' &&
          cs.visibility !== 'collapse'
        );
      });
    const raf = window.requestAnimationFrame(() => {
      if (!document.hasFocus()) return;
      const target = textareaRef.current ?? getFocusable()[0] ?? node;
      target.focus({ preventScroll: true });
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const modals = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
      if (modals.at(-1) !== node) return;
      const focusables = getFocusable();
      if (!focusables.length) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = focusables.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && current <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === -1 || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', trapFocus);
      const returnEl = copilotReturnFocusRef.current;
      const otherModal = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!otherModal && returnEl?.getClientRects().length && !returnEl.closest('[inert]')) {
        returnEl.focus({ preventScroll: true });
      }
    };
  }, [isNarrow, presence.mounted]);

  const handledInitialRef = useRef<number | null>(null);
  const loadedWorkspaceRef = useRef<string | null>(null);
  const workspaceKey = state.workspace.dataDir || 'default';
  const modelReady = !!state.aiSettings.configured;

  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const runningRef = useRef(running);
  runningRef.current = running;

  const handleClose = useCallback(() => {
    if (approvalRef.current) {
      approvalRef.current.resolve({ approved: false });
      setApproval(null);
    }
    if (runningRef.current) {
      agentRef.current?.abort();
      setRunning(false);
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const modals = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
      if (modals.some(el => el !== drawerRef.current)) return;
      event.preventDefault();
      handleClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, handleClose]);

  // Restore persisted Copilot timeline per workspace
  useEffect(() => {
    let active = true;
    loadedWorkspaceRef.current = null;
    void readDraft<{ version?: number; items?: TimelineItem[] }>('copilot:timeline:default')
      .then(saved => {
        if (!active) return;
        if (saved && Array.isArray(saved.items)) {
          setTimeline(sanitizeTimeline(saved.items));
        } else {
          setTimeline([]);
        }
        loadedWorkspaceRef.current = workspaceKey;
      })
      .catch(() => {
        if (active) loadedWorkspaceRef.current = workspaceKey;
      });
    return () => {
      active = false;
    };
  }, [workspaceKey]);

  // Persist Copilot timeline automatically
  useEffect(() => {
    if (loadedWorkspaceRef.current !== workspaceKey) return;
    const trimmed = timeline.slice(-60);
    const timer = window.setTimeout(() => {
      if (trimmed.length === 0) {
        void clearDraft('copilot:timeline:default').catch(() => {});
      } else {
        void writeDraft('copilot:timeline:default', { version: 1, items: trimmed }).catch(() => {});
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [timeline, workspaceKey]);

  const ensureAgent = (): Agent => {
    if (agentRef.current) return agentRef.current;

    const agent = createPmCopilotAgent({
      executor: execute,
      getState: () => stateRef.current,
      getDate: () => dateRef.current,
      getProjectId: () => projectIdRef.current,
      getContextLabel: () => contextLabelRef.current,
      getPreferences: () => preferencesRef.current,
      getAliases: () => aliasesRef.current,
      getHabits: () => habitsRef.current,
      waitForProfile: () => profileReadyRef.current,
      onMutated: async () => {
        await onChangedRef.current();
      },
      onNavigate: (page) => onNavigateRef.current(page),
      requestApproval: (req, signal) =>
        new Promise<ToolApprovalDecision>((resolve) => {
          if (signal?.aborted) {
            resolve(false);
            return;
          }
          const onAbort = () => {
            setApproval(prev => (prev?.request.toolCallId === req.toolCallId ? null : prev));
            resolve(false);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          setApproval({
            request: req,
            draftArgs: { ...req.args },
            rememberAsHabit: false,
            resolve: (decision) => {
              signal?.removeEventListener('abort', onAbort);
              setApproval(null);
              resolve(decision);
            },
          });
        }),
    });

    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'agent_start') {
        setRunning(true);
      } else if (event.type === 'tool_execution_start') {
        setTimeline(prev => [
          ...prev,
          {
            id: `tool-${event.toolCallId}`,
            kind: 'tool',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            label: TOOL_LABELS[event.toolName] ?? event.toolName,
            status: 'running',
          },
        ]);
      } else if (event.type === 'tool_execution_end') {
        setTimeline(prev =>
          prev.map(item =>
            item.kind === 'tool' && item.toolCallId === event.toolCallId
              ? { ...item, status: event.isError ? 'error' : 'done' }
              : item
          )
        );
        if (!event.isError && event.toolName === 'generate_daily_report') {
          notifyRef.current('已生成今日工作日报草稿。', false, {
            label: '查看汇报',
            onClick: () => onNavigateRef.current('reports'),
          });
        }
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        const text = event.message.content
          .map(part => (part.type === 'text' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
          .trim();
        const err = event.message.stopReason === 'error' ? event.message.errorMessage : undefined;
        if (text || err) {
          setTimeline(prev => [
            ...prev,
            {
              id: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              kind: 'assistant',
              text: text || '',
              error: err,
            },
          ]);
        }
      } else if (event.type === 'agent_end') {
        setRunning(false);
      }
    });

    agentRef.current = agent;
    return agent;
  };

  const runOfflinePrompt = async (text: string) => {
    const plan = planCopilotAction(text, {
      projects: stateRef.current.projects,
      tasks: stateRef.current.tasks,
      currentProjectId: projectIdRef.current,
      date: dateRef.current,
    });

    if (plan) {
      const toolCallId = `offline-${Date.now()}`;
      let request: ToolApprovalRequest;
      let initialArgs: Record<string, unknown>;
      if (plan.kind === 'create_task') {
        const pName = stateRef.current.projects.find(p => p.id === plan.projectId)?.name ?? '当前项目';
        initialArgs = {
          projectId: plan.projectId,
          title: plan.title,
          assignee: plan.assignee,
          priority: plan.priority,
          dueDate: plan.dueDate,
          plannedDate: plan.plannedDate,
        };
        request = {
          toolCallId,
          toolName: 'create_task',
          title: '新建项目任务',
          summary: plan.summary,
          details: [`项目：${pName}`],
          args: initialArgs,
        };
      } else if (plan.kind === 'reschedule_task') {
        initialArgs = {
          taskId: plan.task.id,
          dueDate: plan.newDueDate,
          status: plan.task.status,
          assignee: plan.task.assignee ?? '',
          plannedDate: plan.task.plannedDate,
        };
        request = {
          toolCallId,
          toolName: 'update_task',
          title: '调整任务截止日',
          summary: plan.summary,
          details: [`原截止日：${plan.task.dueDate || '未设置'} → 新截止日：${plan.newDueDate}`],
          args: initialArgs,
        };
      } else if (plan.kind === 'complete_task') {
        initialArgs = {
          taskId: plan.task.id,
          status: 'done',
          progress: 100,
          assignee: plan.task.assignee ?? '',
          dueDate: plan.task.dueDate,
          plannedDate: plan.task.plannedDate,
        };
        request = {
          toolCallId,
          toolName: 'update_task',
          title: '完成任务',
          summary: plan.summary,
          details: ['状态将更新为已完成（100%）'],
          args: initialArgs,
        };
      } else if (plan.kind === 'create_governance') {
        const pName = stateRef.current.projects.find(p => p.id === plan.projectId)?.name ?? '当前项目';
        initialArgs = {
          projectId: plan.projectId,
          kind: plan.govKind,
          title: plan.title,
          severity: plan.severity,
          dueDate: plan.dueDate,
        };
        request = {
          toolCallId,
          toolName: 'create_risk_or_decision',
          title: plan.govKind === 'decision' ? '新增待决策事项' : '记录项目风险',
          summary: plan.summary,
          details: [`项目：${pName}`],
          args: initialArgs,
        };
      } else {
        const pName = plan.projectId
          ? stateRef.current.projects.find(p => p.id === plan.projectId)?.name ?? '当前项目'
          : '全部项目';
        initialArgs = { date: plan.date, projectId: plan.projectId };
        request = {
          toolCallId,
          toolName: 'generate_daily_report',
          title: '生成工作日报',
          summary: plan.summary,
          details: [`范围：${pName}`],
          args: initialArgs,
        };
      }

      setApproval({
        request,
        draftArgs: { ...initialArgs },
        rememberAsHabit: false,
        resolve: async (rawDecision) => {
          setApproval(null);
          const decision = typeof rawDecision === 'boolean'
            ? { approved: rawDecision, overrideArgs: undefined }
            : rawDecision;
          if (!decision.approved) {
            setTimeline(prev => [
              ...prev,
              { id: `asst-${Date.now()}`, kind: 'assistant', text: '已取消本次操作。' },
            ]);
            return;
          }
          const args = { ...initialArgs, ...(decision.overrideArgs ?? {}) };
          setRunning(true);
          try {
            if (plan.kind === 'create_task') {
              await execute('create_task', {
                projectId: String(args.projectId || plan.projectId),
                title: String(args.title || plan.title).trim(),
                description: '',
                category: 'action',
                assignee: String(args.assignee ?? '').trim(),
                priority: String(args.priority || 'medium'),
                status: 'todo',
                progress: 0,
                dueDate: args.dueDate ? String(args.dueDate) : null,
                plannedDate: args.plannedDate ? String(args.plannedDate) : null,
                workDate: dateRef.current,
                clientRequestId: crypto.randomUUID(),
                note: '通过 AI 副驾驶快捷指令创建',
              });
              await onChangedRef.current();
              setTimeline(prev => [
                ...prev,
                {
                  id: `asst-${Date.now()}`,
                  kind: 'assistant',
                  text: `已创建任务「${String(args.title || plan.title)}」。`,
                  action: { label: '查看任务清单', page: 'tasks' },
                },
              ]);
              notifyRef.current(`已创建任务「${String(args.title || plan.title)}」。`);
            } else if (plan.kind === 'reschedule_task' || plan.kind === 'complete_task') {
              const target = stateRef.current.tasks.find(t => t.id === plan.task.id) ?? plan.task;
              const nextStatus = String(args.status || target.status);
              const nextProgress = nextStatus === 'done' ? 100 : target.progress;
              await execute('update_task', {
                taskId: target.id,
                baseVersion: target.version,
                title: target.title,
                description: target.description,
                category: target.category,
                assignee: String(args.assignee ?? target.assignee ?? ''),
                priority: target.priority,
                status: nextStatus,
                progress: nextProgress,
                dueDate: args.dueDate !== undefined ? args.dueDate : target.dueDate,
                plannedDate: args.plannedDate !== undefined ? args.plannedDate : target.plannedDate,
                workDate: dateRef.current,
                clientRequestId: crypto.randomUUID(),
                note: plan.kind === 'complete_task' ? '通过 AI 副驾驶标记完成' : '通过 AI 副驾驶调整排期',
              });
              await onChangedRef.current();
              const msg = plan.kind === 'complete_task'
                ? `已将「${target.title}」标记为已完成。`
                : `已将「${target.title}」截止日调整为 ${String(args.dueDate || plan.newDueDate)}。`;
              setTimeline(prev => [
                ...prev,
                { id: `asst-${Date.now()}`, kind: 'assistant', text: msg, action: { label: '查看任务清单', page: 'tasks' } },
              ]);
              notifyRef.current(msg);
            } else if (plan.kind === 'create_governance') {
              await execute('save_governance_item', {
                projectId: String(args.projectId || plan.projectId),
                kind: plan.govKind,
                title: String(args.title || plan.title).trim(),
                description: '',
                owner: '我',
                severity: String(args.severity || plan.severity),
                impact: '待进一步评估影响范围',
                responsePlan: '待进一步确认处理方案与责任人',
                dueDate: args.dueDate ? String(args.dueDate) : null,
                reviewDate: null,
                escalationTo: '',
                status: 'open',
                decisionMaker: '',
                conclusion: '',
                resolution: '',
                closureReason: '',
                links: [],
                evidenceIds: [],
                workDate: dateRef.current,
                note: '通过 AI 副驾驶快捷指令记录',
              });
              await onChangedRef.current();
              const msg = `已记录${plan.govKind === 'decision' ? '待决策' : '风险'}「${String(args.title || plan.title)}」。`;
              setTimeline(prev => [
                ...prev,
                { id: `asst-${Date.now()}`, kind: 'assistant', text: msg, action: { label: '查看风险与决策', page: 'governance' } },
              ]);
              notifyRef.current(msg);
            } else {
              const targetDate = String(args.date || dateRef.current);
              const pid = String(args.projectId ?? '');
              await execute('generate_daily_report', {
                date: targetDate,
                ...(pid ? { projectId: pid } : {}),
                clientRequestId: crypto.randomUUID(),
              });
              await onChangedRef.current();
              setTimeline(prev => [
                ...prev,
                {
                  id: `asst-${Date.now()}`,
                  kind: 'assistant',
                  text: `已生成 ${targetDate} 工作日报草稿。`,
                  action: { label: '查看汇报', page: 'reports' },
                },
              ]);
              notifyRef.current(`已生成 ${targetDate} 工作日报草稿。`, false, {
                label: '查看汇报',
                onClick: () => onNavigateRef.current('reports'),
              });
            }
          } catch (caught) {
            const err = asError(caught).message;
            setTimeline(prev => [...prev, { id: `err-${Date.now()}`, kind: 'assistant', text: '', error: err }]);
            notifyRef.current(err, true);
          } finally {
            setRunning(false);
          }
        },
      });
      return;
    }

    // Grounded local Q&A inline without switching tabs
    setRunning(true);
    try {
      const scopeKey = `${workspaceKey}:${projectIdRef.current || 'all'}`;
      let sessionId = offlineSessionRef.current.get(scopeKey);
      if (!sessionId) {
        const created = await execute<{ id: string }>('create_conversation', {
          projectId: projectIdRef.current || null,
        });
        sessionId = created.id;
        offlineSessionRef.current.set(scopeKey, sessionId);
      }
      const res = await execute<{ answer: AssistantAnswer }>('ask_conversation', {
        sessionId,
        question: text,
        subject: '',
        followUp: true,
        date: dateRef.current,
        useModel: false,
      });
      const note = res.answer.citations?.length
        ? ''
        : '\n\n*（以上为本地记录汇总；配置 AI 模型后可结合全文进行更深入推理与多步执行。）*';
      setTimeline(prev => [
        ...prev,
        {
          id: `asst-${Date.now()}`,
          kind: 'assistant',
          text: `${res.answer.answer || '当前暂无匹配记录。'}${note}`,
          citations: res.answer.citations ?? [],
        },
      ]);
    } catch (caught) {
      setTimeline(prev => [
        ...prev,
        { id: `err-${Date.now()}`, kind: 'assistant', text: '', error: asError(caught).message },
      ]);
    } finally {
      setRunning(false);
    }
  };

  const sendPrompt = async (raw: string) => {
    const text = raw.trim();
    if (!text || running) return;
    if (approval) {
      approval.resolve({ approved: false });
      setApproval(null);
    }
    setInput('');
    setTimeline(prev => [...prev, { id: `user-${Date.now()}`, kind: 'user', text }]);
    if (!modelReady) {
      await runOfflinePrompt(text);
      return;
    }
    const agent = ensureAgent();
    try {
      await agent.prompt(text);
    } catch (caught) {
      const msg = asError(caught).message;
      setTimeline(prev => [...prev, { id: `err-${Date.now()}`, kind: 'assistant', text: '', error: msg }]);
      setRunning(false);
    }
  };

  // Auto-handle incoming prompts from TodayStream or WorkRhythmBar
  useEffect(() => {
    if (!open || !initialQuestion || running || handledInitialRef.current === initialQuestion.id) return;
    handledInitialRef.current = initialQuestion.id;
    void sendPrompt(initialQuestion.text);
    onInitialQuestionConsumed();
  }, [open, initialQuestion, running]);

  // Smart auto-scroll timeline to bottom without interrupting upward reading
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'instant',
    });
    nearBottomRef.current = true;
    setShowJumpBottom(false);
  }, []);

  useEffect(() => {
    if (!presence.mounted) return;
    if (nearBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setShowJumpBottom(false);
    } else if (timeline.length > 0 || approval) {
      setShowJumpBottom(true);
    }
  }, [presence.mounted, timeline, approval, running]);

  useSwipeDismiss({
    ref: drawerRef,
    open,
    enabled: isNarrow && presence.mounted,
    direction: 'right',
    onClose: handleClose,
    scrimSelector: '.copilot-scrim',
  });

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isNarrow || event.button !== 0) return;
    event.preventDefault();
    const drawer = drawerRef.current;
    const shell = drawer?.closest('.app-shell');
    if (!drawer) return;

    const startX = event.clientX;
    const startW = drawer.getBoundingClientRect().width || drawerWidth;
    let latestW = startW;

    shell?.classList.add('is-resizing');

    const onMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      latestW = Math.round(Math.min(560, Math.max(300, startW + delta)));
      drawer.style.setProperty('--copilot-w', `${latestW}px`);
    };

    const cleanup = () => {
      shell?.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };

    const onUp = () => {
      cleanup();
      setDrawerWidth(latestW);
      try {
        window.localStorage.setItem('pa:copilot-w', String(latestW));
      } catch {
        // ignore storage errors
      }
    };

    const onCancel = () => {
      cleanup();
      drawer.style.setProperty('--copilot-w', `${drawerWidth}px`);
    };

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  if (!presence.mounted) return null;

  const projectName = state.projects.find(p => p.id === projectId)?.name ?? '全部项目';

  const resetSession = () => {
    const previous = timeline;
    if (approval) {
      approval.resolve({ approved: false });
      setApproval(null);
    }
    agentRef.current?.abort();
    agentRef.current?.reset();
    offlineSessionRef.current.clear();
    setTimeline([]);
    setRunning(false);
    void clearDraft('copilot:timeline:default').catch(() => {});
    if (previous.length > 0) {
      notify('已开启新对话。', false, {
        label: '撤销',
        onClick: () => {
          setTimeline(previous);
          notify('已恢复刚才的对话记录。');
        },
      });
    }
  };

  const openCitation = (c: AssistantCitation) => {
    if (c.taskId) {
      onTaskOpen(c.taskId, c.projectId || projectId);
      return;
    }
    if (c.memoryId) {
      onMemoryOpen(c.memoryId, c.projectId || projectId);
      return;
    }
    if (c.managementId && (c.kind === 'governance' || c.kind === 'change' || c.kind === 'deliverable' || c.kind === 'meeting' || c.kind === 'meeting_action' || c.kind === 'weekly_report')) {
      onManagementOpen(c.kind, c.managementId, c.projectId || projectId);
      return;
    }
    if (c.evidence?.[0]) {
      onEvidence(c.evidence[0]);
      return;
    }
    if (c.kind === 'report') onNavigate('reports');
  };

  return (
    <>
      {isNarrow && (
        <button
          type="button"
          className={`copilot-scrim ${presence.active ? 'is-active' : ''} ${presence.exiting ? 'is-leaving' : ''}`}
          aria-label="收起 AI 副驾驶"
          tabIndex={-1}
          onClick={handleClose}
        />
      )}
      <aside
        ref={drawerRef}
        className={`copilot-drawer ${presence.active ? 'is-active' : ''} ${presence.exiting ? 'is-leaving' : ''}`}
        style={isNarrow ? undefined : ({ '--copilot-w': `${drawerWidth}px` } as CSSProperties)}
        role={isNarrow ? 'dialog' : undefined}
        aria-modal={isNarrow || undefined}
        aria-label="AI 副驾驶"
        tabIndex={-1}
      >
        {!isNarrow && (
          <div
            className="copilot-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整 AI 副驾驶宽度，双击恢复默认宽度"
            onPointerDown={startResize}
            onDoubleClick={() => {
              setDrawerWidth(384);
              try {
                window.localStorage.setItem('pa:copilot-w', '384');
              } catch {
                // ignore storage errors
              }
            }}
          />
        )}
        <div className="copilot-drawer-inner">
          <div className="copilot-drawer-header">
        <div className="copilot-drawer-title">
          <Sparkles size={16} />
          <span>AI 副驾驶</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {timeline.length > 0 && (
            <button
              type="button"
              className="icon-button small"
              title="开启新对话"
              aria-label="开启新对话"
              disabled={running}
              onClick={resetSession}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button
            type="button"
            className="text-button tiny"
            title="打开完整历史问答页"
            onClick={() => onNavigate('assistant')}
          >
            问答历史
          </button>
          <button type="button" className="icon-button small" aria-label="收起 AI 副驾驶" onClick={handleClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="copilot-drawer-context">
        <span>当前：<strong>{contextLabel}</strong> · <strong>{projectName}</strong></span>
        {!modelReady && (
          <button type="button" className="text-button tiny" onClick={onModelSettings}>
            <Settings2 size={12} />配置模型
          </button>
        )}
      </div>

      <div className="copilot-agent-pane">
        <div
          className="copilot-agent-scroll"
          ref={scrollRef}
          onScroll={e => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            nearBottomRef.current = near;
            if (near) setShowJumpBottom(false);
          }}
        >
          {!modelReady && timeline.length === 0 && (
            <div className="copilot-setup-banner">
              <div>
                <strong>本地快捷指令与依据问答已就绪</strong>
                <p>暂未配置 AI 模型时，依然可直接用自然语言新建任务、改截止日、生成日报或查项目记录；配置模型可启用深度分析。</p>
              </div>
              <button type="button" className="button secondary compact" onClick={onModelSettings}>
                <Settings2 size={13} />去配置模型
              </button>
            </div>
          )}

          {timeline.length === 0 ? (
            <div className="copilot-empty">
              <div className="copilot-empty-icon"><Sparkles size={20} /></div>
              <strong>直接说你要查什么，或让我替你执行</strong>
              <p>只读查询自动返回依据；修改任务、记录风险或生成日报前会先弹出确认卡由你把关。</p>
              <div className="copilot-starter-list">
                <button type="button" onClick={() => void sendPrompt('目前有哪些逾期或阻塞事项？')}>
                  <Sparkles size={13} />盘点当前延期风险与阻塞任务
                </button>
                <button type="button" onClick={() => void sendPrompt('帮我生成今天的日报')}>
                  <ClipboardList size={13} />一键生成今日工作日报
                </button>
                <button type="button" onClick={() => { setInput('新建任务：明天'); textareaRef.current?.focus(); }}>
                  <Plus size={13} />自然语言新建任务并安排日期
                </button>
                <button type="button" onClick={() => { setInput('记录风险：'); textareaRef.current?.focus(); }}>
                  <ShieldAlert size={13} />记录一条项目风险或待决策
                </button>
              </div>
            </div>
          ) : (
            <div className="copilot-messages">
              {timeline.map(item => {
                if (item.kind === 'user') {
                  return (
                    <div key={item.id} className="copilot-bubble is-user">
                      {item.text}
                    </div>
                  );
                }
                if (item.kind === 'tool') {
                  return (
                    <div key={item.id} className={`copilot-tool-chip is-${item.status}`}>
                      {item.status === 'running' ? (
                        <Spinner />
                      ) : item.status === 'done' ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <X size={13} />
                      )}
                      <Wrench size={11} />
                      <span>{item.label}</span>
                    </div>
                  );
                }
                return (
                  <div key={item.id} className={`copilot-bubble is-assistant ${item.error ? 'is-error' : ''}`}>
                    {item.text && (
                      <div className="copilot-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                      </div>
                    )}
                    {item.error && <p className="copilot-error-text">{item.error}</p>}
                    {item.action && (
                      <div className="copilot-citations">
                        <button type="button" className="copilot-citation-btn" onClick={() => onNavigate(item.action!.page)}>
                          {item.action.label}
                        </button>
                      </div>
                    )}
                    {item.citations && item.citations.length > 0 && (
                      <div className="copilot-citations">
                        {item.citations.slice(0, 6).map((c, idx) => (
                          <button
                            key={c.id || idx}
                            type="button"
                            className="copilot-citation-btn"
                            onClick={() => openCitation(c)}
                          >
                            <FileText size={11} />
                            <span>{c.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {running && !approval && (
                <div className="copilot-thinking" role="status">
                  <Spinner />
                  <span>正在分析与核对项目记录…</span>
                </div>
              )}
            </div>
          )}

          {approval && (
            <div className="copilot-action-card" role="region" aria-label="待确认操作">
              <div className="copilot-action-card-head">
                <span className="stream-tag is-ai">
                  <Sparkles size={11} />{approval.request.title} · 等待确认
                </span>
              </div>
              <strong>{approval.request.summary}</strong>
              {approval.request.details.length > 0 && (
                <div className="copilot-action-meta">
                  {approval.request.details.map((line, i) => (
                    <span key={i}>{i > 0 ? ' · ' : ''}{line}</span>
                  ))}
                </div>
              )}
              {(approval.request.toolName === 'create_task' || approval.request.toolName === 'update_task') && (
                <div className="copilot-action-fields">
                  {approval.request.toolName === 'create_task' && (
                    <label className="is-full">
                      任务标题
                      <input
                        aria-label="确认卡任务标题"
                        value={String(approval.draftArgs.title ?? '')}
                        onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, title: e.target.value } } : prev)}
                      />
                    </label>
                  )}
                  {approval.request.toolName === 'create_task' ? (
                    <label>
                      优先级
                      <select
                        aria-label="确认卡任务优先级"
                        value={String(approval.draftArgs.priority ?? 'medium')}
                        onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, priority: e.target.value } } : prev)}
                      >
                        <option value="high">高</option>
                        <option value="medium">中</option>
                        <option value="low">低</option>
                      </select>
                    </label>
                  ) : (
                    <label>
                      状态
                      <select
                        aria-label="确认卡任务状态"
                        value={String(approval.draftArgs.status ?? 'in_progress')}
                        onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, status: e.target.value } } : prev)}
                      >
                        <option value="todo">待办</option>
                        <option value="in_progress">进行中</option>
                        <option value="blocked">阻塞</option>
                        <option value="done">已完成</option>
                      </select>
                    </label>
                  )}
                  <label>
                    负责人
                    <input
                      aria-label="确认卡负责人"
                      value={String(approval.draftArgs.assignee ?? '')}
                      placeholder="留空不改"
                      onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, assignee: e.target.value } } : prev)}
                    />
                  </label>
                  <label>
                    截止日期
                    <input
                      aria-label="确认卡截止日期"
                      type="date"
                      value={String(approval.draftArgs.dueDate ?? '')}
                      onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, dueDate: e.target.value || null } } : prev)}
                    />
                  </label>
                  <label>
                    计划执行日
                    <input
                      aria-label="确认卡计划执行日"
                      type="date"
                      value={String(approval.draftArgs.plannedDate ?? '')}
                      onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, plannedDate: e.target.value || null } } : prev)}
                    />
                  </label>
                </div>
              )}
              {approval.request.toolName === 'create_risk_or_decision' && (
                <div className="copilot-action-fields">
                  <label className="is-full">
                    标题
                    <input
                      aria-label="确认卡标题"
                      value={String(approval.draftArgs.title ?? '')}
                      onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, title: e.target.value } } : prev)}
                    />
                  </label>
                  <label>
                    严重度
                    <select
                      aria-label="确认卡严重度"
                      value={String(approval.draftArgs.severity ?? 'medium')}
                      onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, severity: e.target.value } } : prev)}
                    >
                      <option value="high">高</option>
                      <option value="medium">中</option>
                      <option value="low">低</option>
                    </select>
                  </label>
                  <label>
                    处理期限
                    <input
                      aria-label="确认卡处理期限"
                      type="date"
                      value={String(approval.draftArgs.dueDate ?? '')}
                      onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, dueDate: e.target.value || null } } : prev)}
                    />
                  </label>
                </div>
              )}
              {modelReady && approval.request.toolName !== 'generate_daily_report' && (
                <label className="checkbox-row" style={{ margin: '6px 0 2px', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={approval.rememberAsHabit}
                    onChange={(e) => setApproval(prev => prev ? { ...prev, rememberAsHabit: e.target.checked } : prev)}
                  />
                  <span>记住这次偏好，下次自动套用</span>
                </label>
              )}
              <div className="copilot-action-buttons">
                <button
                  type="button"
                  className="button seal compact"
                  onClick={() => approval.resolve({
                    approved: true,
                    overrideArgs: approval.draftArgs,
                    rememberAsHabit: approval.rememberAsHabit,
                  })}
                >
                  <Check size={13} />确认执行
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={() => approval.resolve({ approved: false })}
                >
                  <X size={13} />取消
                </button>
              </div>
            </div>
          )}
        </div>

        {showJumpBottom && (
          <button
            type="button"
            className="copilot-scroll-bottom"
            onClick={() => scrollToBottom(true)}
          >
            <ArrowDown size={12} />回到底部
          </button>
        )}

        <form
          className="copilot-agent-composer"
          onSubmit={e => {
            e.preventDefault();
            void sendPrompt(input);
          }}
        >
          <textarea
            ref={textareaRef}
            aria-label="给 AI 副驾驶发消息"
            rows={2}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (
                e.key === 'Enter'
                && !e.shiftKey
                && !e.nativeEvent.isComposing
                && e.keyCode !== 229
              ) {
                e.preventDefault();
                void sendPrompt(input);
              }
            }}
            placeholder="提问或下达指令（如：新建任务、延后截止日、生成日报），回车发送…"
            disabled={running}
          />
          <div className="copilot-agent-composer-bar">
            <span className="copilot-composer-hint">
              {modelReady ? `模型：${state.aiSettings.model}` : '本地模式 · 支持快捷指令与依据问答'}
            </span>
            {running ? (
              <button
                type="button"
                className="button secondary compact"
                onClick={() => agentRef.current?.abort()}
              >
                <Square size={12} />停止
              </button>
            ) : (
              <button
                type="submit"
                className="button primary compact"
                disabled={!input.trim()}
              >
                <Send size={13} />发送
              </button>
            )}
          </div>
        </form>
      </div>
        </div>
      </aside>
    </>
  );
}
