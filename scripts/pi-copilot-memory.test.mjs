import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  createPmAgentTools,
  createPmCopilotAgent,
} from '../src/components/shell/pi-copilot-agent.ts';

const baseState = {
  workspace: { dataDir: '/tmp/demo', schemaVersion: 16, recoveredJobs: 0 },
  projects: [{ id: 'p1', name: '支付重构二期', description: '', createdAt: '2026-11-24T00:00:00Z' }],
  sources: [],
  proposals: [],
  memories: [
    // Even if stale/archived memories exist in frontend AppState, Copilot must NOT read them directly!
    {
      id: 'stale-local',
      projectId: 'p1',
      kind: 'fact',
      content: '旧版未过滤内存记忆：老王负责支付',
      revision: 1,
      state: 'active',
      sourceTitle: '旧记录',
      confirmedAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
  ],
  jobs: [],
  backups: [],
  aiSettings: {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
    outputFormat: 'json_object',
    timeoutSeconds: 60,
    autoExtract: false,
    remoteConsent: false,
    configured: true,
    hasApiKey: false,
  },
  memoryReviewCount: 1,
  tasks: [],
  taskProposals: [],
  reports: [],
};

test('buildSystemPrompt injects explicit preferences, aliases, and grounding rules', () => {
  const prompt = buildSystemPrompt(
    baseState,
    'p1',
    '2026-11-24',
    '项目工作台',
    {
      role: '支付交付项目经理，优先关注阻塞与上线风险',
      answerStyle: 'concise',
      reportFormat: 'brief',
      reminderStyle: 'direct',
      version: 2,
    },
    [
      {
        id: 'a1',
        projectId: 'p1',
        canonical: '王明',
        aliases: ['老王', '后端王哥'],
        kind: 'person',
        note: '后端负责人',
        version: 1,
        createdAt: '2026-11-24T00:00:00Z',
        updatedAt: '2026-11-24T00:00:00Z',
      },
    ],
  );
  assert.match(prompt, /支付交付项目经理/);
  assert.match(prompt, /简洁/);
  assert.match(prompt, /直接利落/);
  assert.match(prompt, /王明 = 老王 \/ 后端王哥/);
  assert.match(prompt, /绝不能覆盖项目客观事实/);
  assert.match(prompt, /ask_verified_memory/);
});

test('search_project_memory and ask_verified_memory delegate to Rust verified commands', async () => {
  const calls = [];
  const executor = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'search_verified_memories') {
      return {
        memories: [
          {
            id: 'm1',
            projectId: 'p1',
            kind: 'decision',
            content: '支付重构核心模块由王明负责。',
            revision: 2,
            origin: 'user_correction',
            evidenceLabel: '人工纠正（含原文依据）',
            sourceTitle: '周会纪要',
            updatedAt: '2026-11-24T01:00:00Z',
            evidence: [{ sourceTitle: '周会纪要', locator: '第 1 段', text: '支付重构核心模块由王明负责' }],
          },
        ],
        sourcePassages: [],
        sources: [{ id: 's1', title: '周会纪要', importedAt: '2026-11-24T00:00:00Z' }],
        pendingReviewCount: 2,
        searchTrace: { hybridRetrieval: { enabled: true, backend: 'sqlite-vec', fusion: 'rrf' } },
      };
    }
    if (command === 'ask_assistant') {
      return {
        status: 'answered',
        grounded: true,
        answer: '支付重构核心模块由王明负责。',
        unknowns: [],
        citations: [{ id: 'memory:m1', kind: 'memory', sourceTitle: '周会纪要', revision: 2 }],
      };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const tools = createPmAgentTools({
    executor,
    getState: () => baseState,
    getDate: () => '2026-11-24',
    getProjectId: () => 'p1',
    onMutated: async () => {},
  });

  const searchTool = tools.find((t) => t.name === 'search_project_memory');
  const askTool = tools.find((t) => t.name === 'ask_verified_memory');
  assert.ok(searchTool, 'search_project_memory tool missing');
  assert.ok(askTool, 'ask_verified_memory tool missing');

  const searchOut = await searchTool.execute('c1', { query: '老王负责什么' });
  const searchJson = JSON.parse(searchOut.content[0].text);
  assert.equal(calls[0].command, 'search_verified_memories');
  assert.equal(calls[0].payload.projectId, 'p1');
  assert.equal(calls[0].payload.date, '2026-11-24');
  assert.equal(searchJson.memories.length, 1);
  assert.equal(searchJson.memories[0].id, 'm1');
  assert.equal(searchJson.memories[0].origin, 'user_correction');
  assert.equal(searchJson.pendingReviewCount, 2);
  assert.match(searchJson.pendingReviewNotice, /2 条待确认/);
  assert.equal(searchJson.hybridRetrieval.backend, 'sqlite-vec');

  const askOut = await askTool.execute('c2', { question: '谁负责支付重构核心模块？' });
  const askJson = JSON.parse(askOut.content[0].text);
  assert.equal(calls[1].command, 'ask_assistant');
  assert.equal(calls[1].payload.useModel, true);
  assert.equal(askJson.grounded, true);
  assert.equal(askJson.status, 'answered');
  assert.equal(askJson.citations[0].revision, 2);
});

test('buildSystemPrompt injects active confirmed user habits and skips paused habits', () => {
  const prompt = buildSystemPrompt(
    baseState,
    'p1',
    '2026-11-24',
    '项目工作台',
    null,
    [],
    [
      {
        id: 'h1',
        projectId: 'p1',
        patternKey: 'writing:risks_first',
        category: 'writing',
        title: '汇报先列风险与阻塞',
        instruction: '输出日报或周报草稿时，先把风险与阻塞放在最前面。',
        rule: {},
        status: 'active',
        confidence: 0.9,
        appliedCount: 4,
        acceptedCount: 4,
        overriddenCount: 0,
        utilityScore: 0.83,
        lowUtilityWarning: false,
        version: 1,
        lastAppliedAt: null,
        createdAt: '2026-11-24T00:00:00Z',
        updatedAt: '2026-11-24T00:00:00Z',
      },
      {
        id: 'h2',
        projectId: 'p1',
        patternKey: 'workflow:paused_rule',
        category: 'workflow',
        title: '已暂停规则',
        instruction: '这条已暂停规则不应出现在系统提示中。',
        rule: {},
        status: 'paused',
        confidence: 0.5,
        appliedCount: 5,
        acceptedCount: 1,
        overriddenCount: 4,
        utilityScore: 0.28,
        lowUtilityWarning: true,
        version: 2,
        lastAppliedAt: null,
        createdAt: '2026-11-24T00:00:00Z',
        updatedAt: '2026-11-24T00:00:00Z',
      },
    ],
  );
  assert.match(prompt, /用户已确认的个人工作习惯/);
  assert.match(prompt, /先把风险与阻塞放在最前面/);
  assert.match(prompt, /绝不能覆盖客观项目事实/);
  assert.doesNotMatch(prompt, /这条已暂停规则不应出现在系统提示中/);
});

test('createPmCopilotAgent applies PAHF inline overrideArgs and fires record_copilot_feedback', async () => {
  const calls = [];
  let turn = 0;

  const executor = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'copilot_agent_turn') {
      turn += 1;
      if (turn === 1) {
        return {
          model: 'qwen2.5:7b',
          provider: 'ollama',
          content: '',
          toolCalls: [
            {
              id: 'call_create_pahf',
              name: 'create_task',
              arguments: {
                projectId: 'p1',
                title: '补齐压测报告',
                priority: 'medium',
                assignee: '李四',
              },
            },
          ],
          stopReason: 'toolUse',
          usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        };
      }
      return {
        model: 'qwen2.5:7b',
        provider: 'ollama',
        content: '已按你的调整创建任务并记住个人习惯。',
        toolCalls: [],
        stopReason: 'stop',
        usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
      };
    }
    if (command === 'create_task') {
      return { id: 't_new', ...payload };
    }
    if (command === 'record_copilot_feedback') {
      return { recorded: true, createdHabits: [{ id: 'h_new' }] };
    }
    return {};
  };

  const agent = createPmCopilotAgent({
    executor,
    getState: () => baseState,
    getDate: () => '2026-11-24',
    getProjectId: () => 'p1',
    getContextLabel: () => '项目工作台',
    onMutated: async () => {},
    requestApproval: async () => ({
      approved: true,
      overrideArgs: { priority: 'high', assignee: '王明' },
      rememberAsHabit: true,
    }),
  });

  await agent.prompt('帮我建个补齐压测报告的任务');
  await agent.waitForIdle();

  const createCall = calls.find((c) => c.command === 'create_task');
  assert.ok(createCall, 'create_task should have been executed');
  assert.equal(createCall.payload.priority, 'high');
  assert.equal(createCall.payload.assignee, '王明');

  const feedbackCall = calls.find((c) => c.command === 'record_copilot_feedback');
  assert.ok(feedbackCall, 'record_copilot_feedback should have been fired');
  assert.equal(feedbackCall.payload.toolName, 'create_task');
  assert.equal(feedbackCall.payload.decision, 'edited_and_approved');
  assert.equal(feedbackCall.payload.rememberAsHabit, true);
  assert.equal(feedbackCall.payload.originalArgs.priority, 'medium');
  assert.equal(feedbackCall.payload.finalArgs.priority, 'high');
  assert.equal(feedbackCall.payload.finalArgs.assignee, '王明');
});
