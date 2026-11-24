import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot, Check, CheckCircle2, ClipboardList, FileSearch, Plus,
  RotateCcw, Send, Settings2, ShieldAlert, Sparkles, Square, Wrench, X,
} from 'lucide-react';
import type { Agent, AgentEvent } from '@mariozechner/pi-agent-core';
import { execute } from '../../api';
import { clearDraft, readDraft, writeDraft } from '../../drafts';
import type { AppState, AssistantPreferences, EntityAlias, Evidence, HabitsCenter, ManagementKind, Page, UserHabit } from '../../types';
import { Spinner } from '../ui';
import {
  buildSystemPrompt,
  createPmCopilotAgent,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './pi-copilot-agent';

const AssistantWorkspace = lazy(() =>
  import('../delivery/AssistantWorkspace').then(m => ({ default: m.AssistantWorkspace }))
);

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
  notify: (message: string, error?: boolean) => void;
}

type TimelineItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; error?: string }
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
  const [mode, setMode] = useState<'agent' | 'citations'>('agent');
  const [input, setInput] = useState('');
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<{
    request: ToolApprovalRequest;
    draftArgs: Record<string, unknown>;
    rememberAsHabit: boolean;
    resolve: (decision: ToolApprovalDecision) => void;
  } | null>(null);
  const [qaQuestion, setQaQuestion] = useState<{ id: number; text: string } | null>(null);
  const preferencesRef = useRef<AssistantPreferences | null>(null);
  const aliasesRef = useRef<EntityAlias[]>([]);
  const habitsRef = useRef<UserHabit[]>([]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all([
      execute<AssistantPreferences>('get_assistant_preferences').catch(() => null),
      execute<{ aliases: EntityAlias[] }>('list_entity_aliases', projectId ? { projectId } : {}).catch(() => null),
      execute<HabitsCenter>('get_habits_center', projectId ? { projectId } : {}).catch(() => null),
    ]).then(([prefs, aliasRes, habitsRes]) => {
      if (!active) return;
      preferencesRef.current = prefs;
      aliasesRef.current = aliasRes?.aliases ?? [];
      habitsRef.current = habitsRes?.habits ?? [];
      if (agentRef.current) {
        agentRef.current.state.systemPrompt = buildSystemPrompt(
          stateRef.current,
          projectIdRef.current,
          dateRef.current,
          contextLabelRef.current,
          preferencesRef.current,
          aliasesRef.current,
          habitsRef.current,
        );
      }
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

  const agentRef = useRef<Agent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledInitialRef = useRef<number | null>(null);
  const loadedWorkspaceRef = useRef<string | null>(null);
  const workspaceKey = state.workspace.dataDir || 'default';

  const modelReady = !!state.aiSettings.configured;

  // Restore persisted Copilot timeline per workspace
  useEffect(() => {
    let active = true;
    loadedWorkspaceRef.current = null;
    void readDraft<{ version?: number; items?: TimelineItem[] }>('copilot:timeline:default')
      .then(saved => {
        if (!active) return;
        if (saved && Array.isArray(saved.items)) {
          setTimeline(saved.items.slice(-60));
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

  // Lazily create a persistent Pi Agent instance for this drawer session.
  const ensureAgent = (): Agent => {
    if (agentRef.current) {
      agentRef.current.state.systemPrompt = buildSystemPrompt(
        stateRef.current,
        projectIdRef.current,
        dateRef.current,
        contextLabelRef.current,
        preferencesRef.current,
        aliasesRef.current,
        habitsRef.current,
      );
      return agentRef.current;
    }

    const agent = createPmCopilotAgent({
      executor: execute,
      getState: () => stateRef.current,
      getDate: () => dateRef.current,
      getProjectId: () => projectIdRef.current,
      getContextLabel: () => contextLabelRef.current,
      getPreferences: () => preferencesRef.current,
      getAliases: () => aliasesRef.current,
      getHabits: () => habitsRef.current,
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

  const sendPrompt = async (raw: string) => {
    const text = raw.trim();
    if (!text || running) return;
    if (!modelReady) {
      setMode('citations');
      setQaQuestion({ id: Date.now(), text });
      notify('尚未配置 AI 模型，已切换到本地依据问答模式。');
      return;
    }
    setInput('');
    setTimeline(prev => [...prev, { id: `user-${Date.now()}`, kind: 'user', text }]);
    const agent = ensureAgent();
    try {
      await agent.prompt(text);
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : '副驾驶运行出错，请重试。';
      setTimeline(prev => [...prev, { id: `err-${Date.now()}`, kind: 'assistant', text: '', error: msg }]);
      setRunning(false);
    }
  };

  // Auto-handle incoming prompts from TodayStream or WorkRhythmBar
  useEffect(() => {
    if (!open || !initialQuestion || handledInitialRef.current === initialQuestion.id) return;
    handledInitialRef.current = initialQuestion.id;
    if (modelReady) {
      setMode('agent');
      void sendPrompt(initialQuestion.text);
    } else {
      setMode('citations');
      setQaQuestion(initialQuestion);
    }
    onInitialQuestionConsumed();
  }, [open, initialQuestion, modelReady]);

  // Auto-scroll timeline to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline, approval, running]);

  if (!open) return null;

  const projectName = state.projects.find(p => p.id === projectId)?.name ?? '全部项目';

  const resetSession = () => {
    agentRef.current?.abort();
    agentRef.current?.reset();
    setApproval(null);
    setTimeline([]);
    setRunning(false);
    void clearDraft('copilot:timeline:default').catch(() => {});
  };

  return (
    <aside className="copilot-drawer" aria-label="AI 副驾驶">
      <div className="copilot-drawer-header">
        <div className="copilot-drawer-title">
          <Sparkles size={16} />
          <span>AI 副驾驶</span>
          <span className="copilot-engine-badge">智能代理</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {mode === 'agent' && timeline.length > 0 && (
            <button
              className="icon-button small"
              title="开启新对话"
              aria-label="开启新对话"
              disabled={running}
              onClick={resetSession}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button className="icon-button small" aria-label="收起 AI 副驾驶" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="copilot-drawer-context">
        <span>当前：<strong>{contextLabel}</strong> · <strong>{projectName}</strong></span>
        <div className="copilot-mode-switch" role="tablist" aria-label="副驾驶模式">
          <button
            role="tab"
            aria-selected={mode === 'agent'}
            className={mode === 'agent' ? 'is-active' : ''}
            onClick={() => setMode('agent')}
          >
            <Bot size={12} />智能代理
          </button>
          <button
            role="tab"
            aria-selected={mode === 'citations'}
            className={mode === 'citations' ? 'is-active' : ''}
            onClick={() => setMode('citations')}
          >
            <FileSearch size={12} />原文问答
          </button>
        </div>
      </div>

      {mode === 'agent' ? (
        <div className="copilot-agent-pane">
          <div className="copilot-agent-scroll" ref={scrollRef}>
            {!modelReady && (
              <div className="copilot-setup-banner">
                <div>
                  <strong>配置模型后启用多步智能副驾驶</strong>
                  <p>支持自主查询项目进度、任务、风险与记忆，并弹出确认卡帮你改排期、建任务、写日报。</p>
                </div>
                <button className="button primary compact" onClick={onModelSettings}>
                  <Settings2 size={13} />配置模型
                </button>
              </div>
            )}

            {timeline.length === 0 ? (
              <div className="copilot-empty">
                <div className="copilot-empty-icon"><Sparkles size={20} /></div>
                <strong>直接说你要查什么，或让我替你做什么</strong>
                <p>只读查询自动执行，修改任务、记录风险或生成日报前会先出确认卡请你拍板。</p>
                <div className="copilot-starter-list">
                  <button type="button" onClick={() => void sendPrompt('帮我盘点当前项目的延期风险和阻塞任务，给出今天最优先推进的 3 件事')}>
                    <Sparkles size={13} />盘点延期风险与今日 Top 3 优先事项
                  </button>
                  <button type="button" onClick={() => void sendPrompt('帮我生成今天的工作日报草稿')}>
                    <ClipboardList size={13} />一键生成今日工作日报
                  </button>
                  <button type="button" onClick={() => setInput('帮我新建任务：明天')}>
                    <Plus size={13} />自然语言新建任务并安排日期
                  </button>
                  <button type="button" onClick={() => setInput('记录风险：')}>
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
                    </div>
                  );
                })}

                {running && !approval && (
                  <div className="copilot-thinking" role="status">
                    <Spinner />
                    <span>AI 副驾驶正在分析与核对项目记录…</span>
                  </div>
                )}
              </div>
            )}

            {/* Human-in-the-Loop Write Tool Approval Card (PAHF inline parameter override + habit learning) */}
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
                  <div className="memory-form-row" style={{ marginTop: 8 }}>
                    {approval.request.toolName === 'create_task' && (
                      <label style={{ fontSize: 12 }}>
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
                    )}
                    <label style={{ fontSize: 12 }}>
                      负责人
                      <input
                        aria-label="确认卡负责人"
                        value={String(approval.draftArgs.assignee ?? '')}
                        placeholder="留空不改"
                        onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, assignee: e.target.value } } : prev)}
                      />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      截止日期
                      <input
                        aria-label="确认卡截止日期"
                        type="date"
                        value={String(approval.draftArgs.dueDate ?? '')}
                        onChange={(e) => setApproval(prev => prev ? { ...prev, draftArgs: { ...prev.draftArgs, dueDate: e.target.value || null } } : prev)}
                      />
                    </label>
                  </div>
                )}
                {approval.request.toolName === 'create_risk_or_decision' && (
                  <div className="memory-form-row" style={{ marginTop: 8 }}>
                    <label style={{ fontSize: 12 }}>
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
                    <label style={{ fontSize: 12 }}>
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
                {approval.request.toolName !== 'generate_daily_report' && (
                  <label className="checkbox-row" style={{ margin: '8px 0 4px', fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={approval.rememberAsHabit}
                      onChange={(e) => setApproval(prev => prev ? { ...prev, rememberAsHabit: e.target.checked } : prev)}
                    />
                    <span>记住本次参数调整为个人工作习惯</span>
                  </label>
                )}
                <div className="copilot-action-buttons">
                  <button
                    type="button"
                    className="button primary compact"
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

          <form
            className="copilot-agent-composer"
            onSubmit={e => {
              e.preventDefault();
              void sendPrompt(input);
            }}
          >
            <textarea
              aria-label="给 AI 副驾驶发消息"
              rows={2}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendPrompt(input);
                }
              }}
              placeholder="输入问题或指令，回车发送（Shift+Enter 换行）…"
              disabled={running}
            />
            <div className="copilot-agent-composer-bar">
              <span className="copilot-composer-hint">
                {modelReady ? `模型：${state.aiSettings.model}` : '未配置模型'}
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
      ) : (
        <div className="copilot-drawer-body">
          <Suspense fallback={<div className="loading-view"><Spinner /><span>正在加载原文问答…</span></div>}>
            <AssistantWorkspace
              state={state}
              projectId={projectId}
              date={date}
              initialQuestion={qaQuestion}
              onInitialQuestionConsumed={() => setQaQuestion(null)}
              onChanged={onChanged}
              onTaskOpen={onTaskOpen}
              onEvidence={onEvidence}
              onManagementOpen={onManagementOpen}
              onMemoryOpen={onMemoryOpen}
              onModelSettings={onModelSettings}
              notify={notify}
            />
          </Suspense>
        </div>
      )}
    </aside>
  );
}
