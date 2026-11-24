import { Agent, type AgentTool, type StreamFn } from '@mariozechner/pi-agent-core';
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type TSchema,
  type Tool,
  type ToolCall,
} from '@mariozechner/pi-ai';
import type { AppState, Page } from '../../types';

function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool<any> {
  return tool;
}

export type BackendExecutor = <T = unknown>(
  command: string,
  payload?: Record<string, unknown>,
) => Promise<T>;

export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  title: string;
  summary: string;
  details: string[];
  args: Record<string, unknown>;
}

export interface AgentTurnResponse {
  model: string;
  provider: string;
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  stopReason: 'stop' | 'length' | 'toolUse';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export const WRITE_TOOL_NAMES = new Set([
  'create_task',
  'update_task',
  'create_risk_or_decision',
  'generate_daily_report',
]);

function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function serializeContextForProxy(context: Context): {
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: context.systemPrompt.trim() });
  }
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: extractText(msg.content) });
    } else if (msg.role === 'assistant') {
      const text = extractText(msg.content);
      const toolCalls = msg.content
        .filter((part): part is ToolCall => part.type === 'toolCall')
        .map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: text || (toolCalls.length ? null : ''),
      };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      messages.push(entry);
    } else if (msg.role === 'toolResult') {
      messages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: extractText(msg.content) || (msg.isError ? '工具执行失败' : 'ok'),
      });
    }
  }

  const tools = (context.tools ?? []).map((tool: Tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  return { messages, tools };
}

export function createRustProxyStreamFn(executor: BackendExecutor): StreamFn {
  return (model: Model<any>, context: Context, options) => {
    const stream = createAssistantMessageEventStream();

    const makeBaseMessage = (): AssistantMessage => ({
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    void (async () => {
      const partial = makeBaseMessage();
      stream.push({ type: 'start', partial: { ...partial, content: [] } });

      try {
        if (options?.signal?.aborted) {
          const aborted: AssistantMessage = {
            ...partial,
            stopReason: 'aborted',
            errorMessage: '已取消本次思考',
            timestamp: Date.now(),
          };
          stream.push({ type: 'error', reason: 'aborted', error: aborted });
          stream.end(aborted);
          return;
        }

        const wire = serializeContextForProxy(context);
        const result = await executor<AgentTurnResponse>('copilot_agent_turn', wire);

        if (options?.signal?.aborted) {
          const aborted: AssistantMessage = {
            ...partial,
            stopReason: 'aborted',
            errorMessage: '已取消本次思考',
            timestamp: Date.now(),
          };
          stream.push({ type: 'error', reason: 'aborted', error: aborted });
          stream.end(aborted);
          return;
        }

        const content: AssistantMessage['content'] = [];
        if (result.content && result.content.trim()) {
          const idx = content.length;
          content.push({ type: 'text', text: result.content });
          const snap = { ...partial, content: [...content] };
          stream.push({ type: 'text_start', contentIndex: idx, partial: snap });
          stream.push({ type: 'text_delta', contentIndex: idx, delta: result.content, partial: snap });
          stream.push({ type: 'text_end', contentIndex: idx, content: result.content, partial: snap });
        }

        for (const call of result.toolCalls ?? []) {
          const idx = content.length;
          const toolCall: ToolCall = {
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? {},
          };
          content.push(toolCall);
          const snap = { ...partial, content: [...content] };
          stream.push({ type: 'toolcall_start', contentIndex: idx, partial: snap });
          stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial: snap });
        }

        const inputTokens = result.usage?.inputTokens ?? 0;
        const outputTokens = result.usage?.outputTokens ?? 0;
        const totalTokens = result.usage?.totalTokens ?? inputTokens + outputTokens;
        const reason: 'stop' | 'length' | 'toolUse' =
          (result.toolCalls?.length ?? 0) > 0
            ? 'toolUse'
            : result.stopReason === 'length'
              ? 'length'
              : 'stop';

        const finalMessage: AssistantMessage = {
          ...partial,
          model: result.model || model.id,
          content,
          stopReason: reason,
          usage: {
            input: inputTokens,
            output: outputTokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };
        stream.push({ type: 'done', reason, message: finalMessage });
        stream.end(finalMessage);
      } catch (caught) {
        const message =
          caught instanceof Error
            ? caught.message
            : typeof caught === 'object' && caught !== null && 'message' in caught
              ? String((caught as { message: unknown }).message)
              : '模型调用失败，请检查模型设置后重试。';
        const errMsg: AssistantMessage = {
          ...partial,
          stopReason: 'error',
          errorMessage: message,
          timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason: 'error', error: errMsg });
        stream.end(errMsg);
      }
    })();

    return stream;
  };
}

export function buildSystemPrompt(
  state: AppState,
  projectId: string,
  date: string,
  contextLabel: string,
): string {
  const activeProject = state.projects.find(p => p.id === projectId);
  const projectList = state.projects.map(p => `- ${p.name} (id: ${p.id})`).join('\n') || '（暂无项目）';
  return [
    '你是「项目助理」内置的 AI 副驾驶（基于 Pi Agent 运行时），专门协助项目经理高效推进日常交付与项目管理。',
    `当前日期：${date}`,
    `当前页面：${contextLabel}`,
    `当前项目范围：${activeProject ? `${activeProject.name} (id: ${activeProject.id})` : '全部项目'}`,
    `工作区项目列表：\n${projectList}`,
    '',
    '工作准则：',
    '1. 先查后说：回答进度、风险、任务或资料问题前，优先调用只读工具核实最新记录，严禁编造任务、日期或结论。',
    '2. 主动闭环：当用户要求新建任务、改期、标记完成、记录风险/决策或生成日报时，直接调用对应的写入工具；系统会自动向用户弹出确认卡，你无需在文字里重复要求用户手动复制或自己操作。',
    '3. 修改已有任务前，务必先调用 list_tasks 获取准确的 taskId 与 version。',
    '4. 表达简洁、结构清晰、使用中文大白话，重点突出下一步行动。',
  ].join('\n');
}

function summarizeApproval(
  toolName: string,
  args: Record<string, unknown>,
  state: AppState,
): { title: string; summary: string; details: string[] } {
  const projectName = (id: unknown) =>
    state.projects.find(p => p.id === id)?.name || String(id || '默认项目');

  if (toolName === 'create_task') {
    const details = [`项目：${projectName(args.projectId)}`];
    if (args.assignee) details.push(`负责人：${String(args.assignee)}`);
    if (args.dueDate) details.push(`截止日期：${String(args.dueDate)}`);
    if (args.plannedDate) details.push(`计划执行日：${String(args.plannedDate)}`);
    if (args.priority) details.push(`优先级：${String(args.priority)}`);
    return {
      title: '新建项目任务',
      summary: `创建任务「${String(args.title ?? '')}」`,
      details,
    };
  }

  if (toolName === 'update_task') {
    const existing = state.tasks.find(t => t.id === args.taskId);
    const details: string[] = [];
    if (args.status && existing && args.status !== existing.status) {
      details.push(`状态：${existing.status} → ${String(args.status)}`);
    }
    if (args.dueDate !== undefined && existing && args.dueDate !== existing.dueDate) {
      details.push(`截止日期：${existing.dueDate || '未设置'} → ${String(args.dueDate || '清除')}`);
    }
    if (args.progress !== undefined && existing && args.progress !== existing.progress) {
      details.push(`进度：${existing.progress}% → ${String(args.progress)}%`);
    }
    if (args.assignee !== undefined && existing && args.assignee !== existing.assignee) {
      details.push(`负责人：${existing.assignee || '未指定'} → ${String(args.assignee || '未指定')}`);
    }
    if (!details.length && args.note) details.push(`说明：${String(args.note)}`);
    return {
      title: '更新任务记录',
      summary: `更新「${existing?.title || String(args.title || args.taskId || '')}」`,
      details,
    };
  }

  if (toolName === 'create_risk_or_decision') {
    const isDecision = args.kind === 'decision';
    const details = [
      `项目：${projectName(args.projectId)}`,
      `类型：${isDecision ? '待拍板决策' : '项目风险'}`,
    ];
    if (args.severity) details.push(`严重度：${String(args.severity)}`);
    if (args.dueDate) details.push(`期限：${String(args.dueDate)}`);
    return {
      title: isDecision ? '新增待决策事项' : '记录项目风险',
      summary: `「${String(args.title ?? '')}」`,
      details,
    };
  }

  if (toolName === 'generate_daily_report') {
    return {
      title: '生成工作日报',
      summary: `生成 ${String(args.date || '今日')} 工作日报草稿并打开编辑页`,
      details: [args.projectId ? `范围：${projectName(args.projectId)}` : '范围：全部项目'],
    };
  }

  return {
    title: '确认执行操作',
    summary: `调用工具 ${toolName}`,
    details: [JSON.stringify(args)],
  };
}

export function createPmAgentTools(deps: {
  executor: BackendExecutor;
  getState: () => AppState;
  getDate: () => string;
  getProjectId: () => string;
  onMutated: () => Promise<unknown>;
  onNavigate?: (page: Page) => void;
}): AgentTool<any>[] {
  const { executor, getState, getDate, getProjectId, onMutated, onNavigate } = deps;

  const resolveProjectId = (provided?: string) => {
    const state = getState();
    if (provided && state.projects.some(p => p.id === provided)) return provided;
    const current = getProjectId();
    if (current && state.projects.some(p => p.id === current)) return current;
    return state.projects[0]?.id ?? '';
  };

  return [
    // ==================== Read-Only Tools (Auto-execute) ====================
    defineTool({
      name: 'get_projects_overview',
      label: '读取项目进度总览',
      description: '查询全部项目或单个项目的健康状态、任务完成数与里程碑风险。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: '可选，指定项目 ID，留空则查全部项目' })),
      }),
      execute: async (_id, params) => {
        const pid = params.projectId ?? getProjectId();
        const data = await executor('get_delivery_overview', { date: getDate(), projectId: pid });
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2).slice(0, 6000) }],
          details: { kind: 'read', projectId: pid },
        };
      },
    }),
    defineTool({
      name: 'list_tasks',
      label: '查询任务清单',
      description: '读取当前工作区的任务列表（包含 id、title、status、dueDate、assignee、progress、version），在更新任务前必须调用此工具获取 taskId 和 version。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: '可选，按项目 ID 筛选' })),
        status: Type.Optional(Type.String({ description: '可选，筛选状态：todo / in_progress / blocked / done / active' })),
        keyword: Type.Optional(Type.String({ description: '可选，按标题或负责人关键词筛选' })),
      }),
      execute: async (_id, params) => {
        const state = getState();
        const pid = params.projectId || getProjectId();
        const kw = (params.keyword || '').trim().toLowerCase();
        const filtered = state.tasks
          .filter(t => (!pid || t.projectId === pid))
          .filter(t => {
            if (!params.status || params.status === 'active') return t.status !== 'done' && t.status !== 'cancelled';
            return t.status === params.status;
          })
          .filter(t => !kw || t.title.toLowerCase().includes(kw) || (t.assignee || '').toLowerCase().includes(kw))
          .slice(0, 30)
          .map(t => ({
            id: t.id,
            projectId: t.projectId,
            projectName: state.projects.find(p => p.id === t.projectId)?.name ?? '',
            title: t.title,
            status: t.status,
            priority: t.priority,
            assignee: t.assignee,
            progress: t.progress,
            dueDate: t.dueDate,
            plannedDate: t.plannedDate,
            version: t.version,
          }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: filtered.length, tasks: filtered }, null, 2) }],
          details: { kind: 'read', count: filtered.length },
        };
      },
    }),
    defineTool({
      name: 'get_governance_items',
      label: '查询风险与待决策事项',
      description: '读取项目的风险、阻塞与待拍板决策记录。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: '可选，指定项目 ID' })),
      }),
      execute: async (_id, params) => {
        const pid = params.projectId ?? getProjectId();
        const data = await executor('get_governance_workspace', { date: getDate(), projectId: pid });
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2).slice(0, 6000) }],
          details: { kind: 'read' },
        };
      },
    }),
    defineTool({
      name: 'get_proactive_items',
      label: '查询主动推进与巡检建议',
      description: '读取系统检测到的延期风险、到期跟进和 AI 主动建议。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: '可选，指定项目 ID' })),
      }),
      execute: async (_id, params) => {
        const pid = params.projectId ?? getProjectId();
        const payload = pid ? { projectId: pid } : {};
        const [proactive, work] = await Promise.all([
          executor('get_proactive_center', payload).catch(() => null),
          executor('get_assistant_work', payload).catch(() => null),
        ]);
        return {
          content: [{ type: 'text', text: JSON.stringify({ proactive, work }, null, 2).slice(0, 6000) }],
          details: { kind: 'read' },
        };
      },
    }),
    defineTool({
      name: 'search_project_memory',
      label: '检索项目记忆与资料',
      description: '按关键词搜索已确认的项目事实、决策、需求、风险记忆及原始资料标题。',
      parameters: Type.Object({
        query: Type.String({ description: '要搜索的关键词' }),
        projectId: Type.Optional(Type.String({ description: '可选，限定项目 ID' })),
      }),
      execute: async (_id, params) => {
        const state = getState();
        const pid = params.projectId || getProjectId();
        const kw = params.query.trim().toLowerCase();
        const memories = state.memories
          .filter(m => (!pid || m.projectId === pid) && m.content.toLowerCase().includes(kw))
          .slice(0, 15)
          .map(m => ({ id: m.id, kind: m.kind, content: m.content, sourceTitle: m.sourceTitle }));
        const sources = state.sources
          .filter(s => (!pid || s.projectId === pid) && s.title.toLowerCase().includes(kw))
          .slice(0, 10)
          .map(s => ({ id: s.id, title: s.title, importedAt: s.importedAt }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ memories, sources }, null, 2) }],
          details: { kind: 'read', count: memories.length + sources.length },
        };
      },
    }),

    // ==================== Write Tools (HITL Approval via beforeToolCall) ====================
    defineTool({
      name: 'create_task',
      label: '新建项目任务',
      description: '在指定项目中创建一条新任务（会弹出确认卡等待用户确认后执行）。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: '目标项目 ID，不填则使用当前项目' })),
        title: Type.String({ description: '任务标题' }),
        description: Type.Optional(Type.String({ description: '可选，任务详细说明' })),
        assignee: Type.Optional(Type.String({ description: '可选，负责人姓名' })),
        priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
        dueDate: Type.Optional(Type.String({ description: '可选，截止日期 YYYY-MM-DD' })),
        plannedDate: Type.Optional(Type.String({ description: '可选，计划执行日期 YYYY-MM-DD' })),
      }),
      execute: async (_id, params) => {
        const pid = resolveProjectId(params.projectId);
        if (!pid) throw new Error('没有可用的目标项目，请先新建一个项目。');
        const created = await executor('create_task', {
          projectId: pid,
          title: params.title.trim(),
          description: (params.description || '').trim(),
          category: 'action',
          assignee: (params.assignee || '').trim(),
          priority: params.priority || 'medium',
          status: 'todo',
          progress: 0,
          dueDate: params.dueDate || null,
          plannedDate: params.plannedDate || null,
          note: '通过 Pi AI 副驾驶创建',
        });
        await onMutated();
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, task: created }) }],
          details: { kind: 'write', action: 'create_task' },
        };
      },
    }),
    defineTool({
      name: 'update_task',
      label: '更新任务状态或排期',
      description: '更新已有任务的状态（如 done / in_progress / blocked）、进度、截止日、计划日或负责人（需用户确认）。',
      parameters: Type.Object({
        taskId: Type.String({ description: '要修改的任务 ID（通过 list_tasks 获取）' }),
        status: Type.Optional(Type.Union([
          Type.Literal('todo'),
          Type.Literal('in_progress'),
          Type.Literal('blocked'),
          Type.Literal('done'),
          Type.Literal('cancelled'),
        ])),
        progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
        dueDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        plannedDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        assignee: Type.Optional(Type.String()),
        note: Type.Optional(Type.String({ description: '本次调整的原因或进展说明' })),
      }),
      execute: async (_id, params) => {
        const state = getState();
        const existing = state.tasks.find(t => t.id === params.taskId);
        if (!existing) throw new Error(`找不到任务 ${params.taskId}，请先调用 list_tasks 核对。`);
        const nextStatus = params.status ?? existing.status;
        const nextProgress = params.progress ?? (nextStatus === 'done' ? 100 : existing.progress);
        const updated = await executor('update_task', {
          taskId: existing.id,
          baseVersion: existing.version,
          title: existing.title,
          description: existing.description,
          category: existing.category,
          assignee: params.assignee ?? existing.assignee ?? '',
          priority: existing.priority,
          status: nextStatus,
          progress: nextProgress,
          dueDate: params.dueDate !== undefined ? params.dueDate : existing.dueDate,
          plannedDate: params.plannedDate !== undefined ? params.plannedDate : existing.plannedDate,
          note: params.note?.trim() || '通过 Pi AI 副驾驶更新',
        });
        await onMutated();
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, task: updated }) }],
          details: { kind: 'write', action: 'update_task' },
        };
      },
    }),
    defineTool({
      name: 'create_risk_or_decision',
      label: '记录项目风险或待决策',
      description: '在项目治理中新增一条风险（risk）或待拍板决策（decision）（需用户确认）。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: '目标项目 ID' })),
        kind: Type.Union([Type.Literal('risk'), Type.Literal('decision')]),
        title: Type.String({ description: '风险或待决策标题' }),
        description: Type.Optional(Type.String({ description: '背景与影响说明' })),
        severity: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
        dueDate: Type.Optional(Type.String({ description: '可选，处理期限 YYYY-MM-DD' })),
      }),
      execute: async (_id, params) => {
        const pid = resolveProjectId(params.projectId);
        if (!pid) throw new Error('没有可用的目标项目。');
        const created = await executor('save_governance_item', {
          projectId: pid,
          kind: params.kind,
          title: params.title.trim(),
          description: (params.description || '').trim(),
          owner: '我',
          severity: params.severity || 'medium',
          impact: (params.description || '待进一步评估影响范围').trim(),
          responsePlan: '待进一步确认处理方案与责任人',
          dueDate: params.dueDate || null,
          reviewDate: null,
          escalationTo: '',
          status: 'open',
          decisionMaker: '',
          conclusion: '',
          resolution: '',
          closureReason: '',
          links: [],
          evidenceIds: [],
          workDate: getDate(),
          note: '通过 Pi AI 副驾驶记录',
        });
        await onMutated();
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, item: created }) }],
          details: { kind: 'write', action: 'create_risk_or_decision' },
        };
      },
    }),
    defineTool({
      name: 'generate_daily_report',
      label: '生成工作日报草稿',
      description: '基于当日任务完成情况与项目进展生成工作日报草稿并打开编辑页（需用户确认）。',
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: '日期 YYYY-MM-DD，默认今天' })),
        projectId: Type.Optional(Type.String({ description: '可选，限定单个项目，不填则汇总全部项目' })),
      }),
      execute: async (_id, params) => {
        const targetDate = params.date || getDate();
        const pid = params.projectId ?? getProjectId();
        const report = await executor('generate_daily_report', {
          date: targetDate,
          ...(pid ? { projectId: pid } : {}),
          clientRequestId: crypto.randomUUID(),
        });
        await onMutated();
        onNavigate?.('reports');
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, report }) }],
          details: { kind: 'write', action: 'generate_daily_report' },
        };
      },
    }),
  ];
}

export function createPmCopilotAgent(deps: {
  executor: BackendExecutor;
  getState: () => AppState;
  getDate: () => string;
  getProjectId: () => string;
  getContextLabel: () => string;
  onMutated: () => Promise<unknown>;
  onNavigate?: (page: Page) => void;
  requestApproval: (req: ToolApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
}): Agent {
  const { executor, getState, getDate, getProjectId, getContextLabel, onMutated, onNavigate, requestApproval } = deps;
  const ai = getState().aiSettings;
  const model: Model<any> = {
    id: ai.model || 'configured-model',
    name: ai.model || '已配置模型',
    api: 'openai-completions',
    provider: ai.provider || 'openai_compatible',
    baseUrl: ai.baseUrl || '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };

  const tools = createPmAgentTools({
    executor,
    getState,
    getDate,
    getProjectId,
    onMutated,
    onNavigate,
  });

  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(getState(), getProjectId(), getDate(), getContextLabel()),
      model,
      tools,
      thinkingLevel: 'off',
    },
    toolExecution: 'sequential',
    streamFn: createRustProxyStreamFn(executor),
    beforeToolCall: async (ctx, signal) => {
      if (!WRITE_TOOL_NAMES.has(ctx.toolCall.name)) {
        return undefined;
      }
      const args = (ctx.args && typeof ctx.args === 'object' ? ctx.args : {}) as Record<string, unknown>;
      const info = summarizeApproval(ctx.toolCall.name, args, getState());
      const approved = await requestApproval(
        {
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          title: info.title,
          summary: info.summary,
          details: info.details,
          args,
        },
        signal,
      );
      if (!approved) {
        return { block: true, reason: '用户取消了此操作，请尊重用户决定并简短告知。' };
      }
      return undefined;
    },
  });
}
