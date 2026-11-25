import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeCopilotHabitFeedback,
  buildSystemPrompt,
  compactConversation,
  createPmAgentTools,
  createPmCopilotAgent,
  prefillArgsFromHabits,
  selectHabitsForTurn,
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
  assert.match(prompt, /对于用户交由你选择的部分，按适用的历史偏好/);
  assert.match(prompt, /项目事实须核实，写入操作须单独授权/);
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

test('buildSystemPrompt excludes lowUtilityWarning habits and ranks project-scoped context-relevant habits first', () => {
  const mk = (id, overrides) => ({
    id,
    projectId: null,
    patternKey: `k:${id}`,
    category: 'workflow',
    title: `标题-${id}`,
    instruction: `指令-${id}`,
    rule: {},
    status: 'active',
    confidence: 0.85,
    appliedCount: 2,
    acceptedCount: 2,
    overriddenCount: 0,
    utilityScore: 0.75,
    lowUtilityWarning: false,
    version: 1,
    lastAppliedAt: null,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
    ...overrides,
  });
  const habits = [
    mk('degraded', { projectId: 'p1', instruction: '已衰减低效习惯不应注入', utilityScore: 0.25, lowUtilityWarning: true }),
    mk('other_proj', { projectId: 'p2', instruction: '其他项目习惯不应注入' }),
    mk('global_low', { projectId: null, category: 'filtering', instruction: '全局低相关习惯', utilityScore: 0.6 }),
    mk('scoped_writing', { projectId: 'p1', category: 'writing', instruction: '本项目汇报写作习惯', utilityScore: 0.9 }),
  ];
  const prompt = buildSystemPrompt(baseState, 'p1', '2026-11-24', '工作汇报与日报', null, [], habits);
  assert.doesNotMatch(prompt, /已衰减低效习惯不应注入/);
  assert.doesNotMatch(prompt, /其他项目习惯不应注入/);
  assert.match(prompt, /本项目汇报写作习惯/);
  assert.ok(
    prompt.indexOf('本项目汇报写作习惯') < prompt.indexOf('全局低相关习惯'),
    'expected scoped writing habit ranked ahead of global filtering habit on report page',
  );
});

test('attributeCopilotHabitFeedback isolates tool and field overrides without cross-tool collateral damage', () => {
  const mk = (id, rule) => ({
    id,
    projectId: 'p1',
    patternKey: id,
    category: 'workflow',
    title: id,
    instruction: id,
    rule,
    status: 'active',
    confidence: 0.9,
    appliedCount: 1,
    acceptedCount: 1,
    overriddenCount: 0,
    utilityScore: 0.67,
    lowUtilityWarning: false,
    version: 1,
    lastAppliedAt: null,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
  });
  const habits = [
    mk('h_task_prio', { action: 'copilot_default', tool: 'create_task', field: 'priority', value: 'high' }),
    mk('h_task_assignee', { action: 'copilot_default', tool: 'create_task', field: 'assignee', value: '王明' }),
    mk('h_risk_sev', { action: 'copilot_default', tool: 'create_risk_or_decision', field: 'severity', value: 'high' }),
  ];
  // User edits ONLY create_task.priority (high -> low), keeping assignee = 王明, never touching create_risk_or_decision
  const out = attributeCopilotHabitFeedback(
    habits,
    'p1',
    'create_task',
    'edited_and_approved',
    { priority: 'high', assignee: '王明' },
    { priority: 'low', assignee: '王明' },
  );
  assert.deepEqual(out.appliedHabitIds, ['h_task_prio']);
  assert.deepEqual(out.acceptedHabitIds, ['h_task_assignee']);
  // An unrelated default was never applied to this draft.
  for (const decision of ['rejected', 'edited_and_approved']) {
    const unrelated = attributeCopilotHabitFeedback(habits, 'p1', 'create_task', decision,
      { priority: 'medium' }, { priority: 'low' });
    assert.deepEqual(unrelated.appliedHabitIds, []);
    assert.deepEqual(unrelated.acceptedHabitIds, []);
  }
});

test('Copilot selects habits for the current user turn on the same page', async () => {
  const prompts = [];
  const selections = [];
  const habits = Array.from({ length: 14 }, (_, i) => ({
    id: String(i).padStart(2, '0'), projectId: null, category: 'workflow', status: 'active',
    confidence: 0.9, utilityScore: 0.5, title: '个人偏好',
    instruction: i === 13 ? '核对发票时先列税率' : i === 12 ? '排期优先标出里程碑' : '按部门归档' + i,
  }));
  habits.push({ ...habits[13], projectId: 'p2', instruction: '另一项目单独核对发票税率' });
  const agent = createPmCopilotAgent({
    getState: () => baseState, getDate: () => '2026-11-24', getProjectId: () => '',
    getContextLabel: () => '工作台', getHabits: () => habits,
    onMutated: async () => {}, requestApproval: async () => false,
    executor: async (name, payload) => {
      if (name === 'rank_copilot_habits') {
        selections.push(payload.question);
        const match = payload.candidates.findIndex(p => p.includes(payload.question.includes('税率') ? '税率' : '里程碑'));
        assert.ok(match >= 0);
        return { indices: [match+1] };
      }
      assert.equal(name, 'copilot_agent_turn');
      prompts.push({user:payload.messages.filter(m=>m.role==='user').at(-1).content,
        focus:payload.messages[0].content.split('与本轮相关的历史偏好（供默认选择参考）').at(-1)});
      return { content: '好', toolCalls: [], stopReason: 'stop' };
    },
  });
  await agent.prompt('帮我核对这张发票的税率');
  await agent.prompt('帮我整理排期和里程碑');
  assert.equal(selections.length, 2);
  assert.equal(prompts[0].user, '帮我核对这张发票的税率');
  assert.equal(prompts[1].user, '帮我整理排期和里程碑');
  assert.match(prompts[0].focus, /核对发票时先列税率/);
  assert.doesNotMatch(prompts[0].focus, /另一项目|排期优先标出里程碑/);
  assert.match(prompts[1].focus, /排期优先标出里程碑/);
  assert.doesNotMatch(prompts[1].focus, /另一项目|核对发票时先列税率/);
});

test('A semantic match can focus confirmed evidence without dropping the local shortlist on failure', async () => {
  const habit = (id, instruction, overrides = {}) => ({ id, instruction, title: '约定', projectId: null,
    category: 'workflow', status: 'active', confidence: .9, utilityScore: .5, ...overrides });
  const eligible = [
    habit('fax', 'Send invoice copies by fax.'), habit('desk', 'Contact the duty desk about an outage.'),
    habit('archive', 'Archive the weekly record.'), habit('rent', 'Use the north office.'),
    habit('clips', 'Draft short videos.'), habit('too-long', 'Oversized'.repeat(1000)),
  ];
  const all = [...eligible, habit('misc', 'Private cross-scope', {projectId:'p2'}),
    habit('old', 'Private inactive', {status:'paused'}), habit('low', 'Private degraded', {lowUtilityWarning:true})];
  const pick = (question, run) => selectHabitsForTurn(all, 'p1', '', question, run);
  const selected = await pick('Who should hear about a service interruption?', async (_name, payload) => {
    assert.ok(payload.candidates.every(text => !/Private|Oversized/.test(text)));
    const id = payload.candidates.findIndex(text => text.includes('outage'))+1;
    return { indices: [id, id] };
  });
  assert.deepEqual(selected.focus, [eligible[1]]);
  assert.deepEqual(new Set(selected.evidence), new Set(eligible));
  assert.deepEqual((await pick('invoice', async () => ({indices:[]}))).focus, [eligible[0]]);
  for (const run of [async () => ({indices:[0,999]}), async () => ({indices:['1']}),
    async () => ({indices:[1,2,3,4,5]}), async () => { throw new Error('offline'); }]) {
    const fallback = await pick('invoice', run);
    assert.deepEqual(fallback.focus, [eligible[0]]);
    assert.deepEqual(new Set(fallback.evidence), new Set(eligible));
  }
});

test('Copilot waits for the loaded profile and reuses the same selection across a tool round', async () => {
  let selections = 0;
  let profile = [];
  const prompts = [];
  const agent = createPmCopilotAgent({
    getState: () => baseState, getDate: () => '2026-11-24', getProjectId: () => 'p1', getContextLabel: () => '工作台',
    getHabits: () => [...profile], waitForProfile: async () => {
      profile = Array.from({length:7}, (_,i) => ({id:String(i), title:'格式', instruction:'输出格式'+i,
        category:'writing', projectId:null, status:'active', confidence:1, utilityScore:.5}));
    },
    onMutated: async () => {}, requestApproval: async () => false,
    executor: async (name, payload) => {
      if (name === 'rank_copilot_habits') { selections++; return {indices:[1]}; }
      assert.equal(name, 'copilot_agent_turn');
      prompts.push(payload.messages[0].content);
      return prompts.length === 1
        ? {content:'',toolCalls:[{id:'read',name:'list_tasks',arguments:{}}],stopReason:'toolUse'}
        : {content:'完成',toolCalls:[],stopReason:'stop'};
    },
  });
  await agent.prompt('我的任务还有哪些？');
  assert.equal(selections, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /输出格式0/);
  assert.equal(prompts[0], prompts[1]);
  assert.deepEqual(agent.state.messages.find(m=>m.role==='user').content, [{type:'text',text:'我的任务还有哪些？'}]);
});

test('A vector match outside the previous twelve expands the evidence without evicting any original', async () => {
  const profile = Array.from({length:18}, (_,i)=>({id:String(i).padStart(2,'0'), title:'约定', instruction:'格式'+i,
    category:'writing', projectId:null, status:'active', confidence:1, utilityScore:.5}));
  const pick = executor=>selectHabitsForTurn(profile,'','工作台','Help with a handoff',executor);
  const local = await pick(async()=>({indices:[]}));
  const expanded = await pick(async()=>({indices:[18]}));
  assert.equal(local.evidence.length,12);
  assert.deepEqual(expanded.evidence,[...local.evidence,profile[17]]);
  assert.deepEqual(expanded.focus,[profile[17]]);
});

test('A project switch during semantic selection cannot send the old project habits to the answering model', async () => {
  let project = 'p1';
  let prompt = '';
  const habits = Array.from({length:6}, (_,i) => ({
    id:String(i), title:'约定', instruction:'原项目私人约定'+i, category:'writing', projectId:'p1',
    status:'active', confidence:1, utilityScore:.5,
  }));
  habits.push({...habits[0], id:'new', instruction:'新项目使用交接簿', projectId:'p2'});
  const agent = createPmCopilotAgent({
    getState: () => baseState, getDate: () => '2026-11-24', getProjectId: () => project,
    getHabits: () => habits, getContextLabel: () => '工作台', onMutated: async () => {}, requestApproval: async () => false,
    executor: async (name, payload) => {
      if (name === 'rank_copilot_habits') {
        project = 'p2';
        return {indices:[1]};
      }
      prompt = payload.messages[0].content;
      return {content:'完成',toolCalls:[],stopReason:'stop'};
    },
  });
  await agent.prompt('请给一个建议');
  assert.match(prompt, /新项目使用交接簿/);
  assert.doesNotMatch(prompt, /原项目私人约定/);
});

test('prefillArgsFromHabits fills missing workflow defaults without overriding explicit values', () => {
  const mk = (id, overrides) => ({
    id,
    projectId: null,
    patternKey: id,
    category: 'workflow',
    title: id,
    instruction: id,
    rule: { action: 'copilot_default', tool: 'create_task', field: 'priority', value: 'high' },
    status: 'active',
    confidence: 0.9,
    appliedCount: 1,
    acceptedCount: 1,
    overriddenCount: 0,
    utilityScore: 0.7,
    lowUtilityWarning: false,
    version: 1,
    lastAppliedAt: null,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
    ...overrides,
  });
  const habits = [
    mk('global_prio', { projectId: null, rule: { action: 'copilot_default', tool: 'create_task', field: 'priority', value: 'low' } }),
    mk('proj_prio', { projectId: 'p1', rule: { action: 'copilot_default', tool: 'create_task', field: 'priority', value: 'high' } }),
    mk('other_proj', { projectId: 'p2', rule: { action: 'copilot_default', tool: 'create_task', field: 'assignee', value: '李静' } }),
    mk('paused_assignee', { projectId: 'p1', status: 'paused', rule: { action: 'copilot_default', tool: 'create_task', field: 'assignee', value: '暂停人' } }),
    mk('low_util_assignee', { projectId: 'p1', lowUtilityWarning: true, rule: { action: 'copilot_default', tool: 'create_task', field: 'assignee', value: '低效人' } }),
    mk('other_tool', { projectId: 'p1', rule: { action: 'copilot_default', tool: 'create_risk_or_decision', field: 'severity', value: 'high' } }),
    mk('valid_assignee', { projectId: 'p1', rule: { action: 'copilot_default', tool: 'create_task', field: 'assignee', value: '王明' } }),
  ];

  // Missing priority & empty assignee get filled; project-scoped priority wins over global
  const filled = prefillArgsFromHabits(habits, 'p1', 'create_task', {
    projectId: 'p1',
    title: '压测准备',
    assignee: '',
  });
  assert.equal(filled.args.priority, 'high');
  assert.equal(filled.args.assignee, '王明');
  assert.deepEqual(filled.filled.map(f => `${f.field}:${f.value}`), ['priority:high', 'assignee:王明']);

  // Explicit values are never overridden
  const explicit = prefillArgsFromHabits(habits, 'p1', 'create_task', {
    projectId: 'p1',
    title: '压测准备',
    priority: 'medium',
    assignee: '张敏',
  });
  assert.equal(explicit.args.priority, 'medium');
  assert.equal(explicit.args.assignee, '张敏');
  assert.equal(explicit.filled.length, 0);
});

test('createPmCopilotAgent deterministically prefills approval card and executed tool payload from habits', async () => {
  const calls = [];
  let approvalReq = null;
  let turn = 0;
  const habits = [
    {
      id: 'h_prio_high',
      projectId: 'p1',
      patternKey: 'workflow:copilot:create_task:priority:high',
      category: 'workflow',
      title: '新建任务默认高优先级',
      instruction: '新建任务默认设高优先级',
      rule: { action: 'copilot_default', tool: 'create_task', field: 'priority', value: 'high' },
      status: 'active',
      confidence: 0.9,
      appliedCount: 2,
      acceptedCount: 2,
      overriddenCount: 0,
      utilityScore: 0.75,
      lowUtilityWarning: false,
      version: 1,
      lastAppliedAt: null,
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
    },
  ];
  const agent = createPmCopilotAgent({
    getState: () => baseState,
    getDate: () => '2026-11-25',
    getProjectId: () => 'p1',
    getContextLabel: () => '项目工作台',
    getHabits: () => habits,
    onMutated: async () => {},
    requestApproval: async (req) => {
      approvalReq = req;
      return true;
    },
    executor: async (command, payload) => {
      calls.push({ command, payload });
      if (command === 'copilot_agent_turn') {
        turn += 1;
        if (turn === 1) {
          return {
            model: 'qwen2.5:7b',
            provider: 'ollama',
            content: '',
            toolCalls: [{ id: 'c1', name: 'create_task', arguments: { projectId: 'p1', title: '核对灰度清单' } }],
            stopReason: 'toolUse',
          };
        }
        return { model: 'qwen2.5:7b', provider: 'ollama', content: '已创建。', toolCalls: [], stopReason: 'stop' };
      }
      if (command === 'create_task') return { id: 't_prefill', ...payload };
      return {};
    },
  });

  await agent.prompt('帮我建个核对灰度清单的任务');
  await agent.waitForIdle();

  assert.equal(approvalReq.args.priority, 'high');
  assert.ok(approvalReq.details.some(d => d.includes('已按你的习惯预填：优先级=高')));
  const createCall = calls.find(c => c.command === 'create_task');
  assert.equal(createCall.payload.priority, 'high');
  const feedbackCall = calls.find(c => c.command === 'record_copilot_feedback');
  assert.equal(feedbackCall.payload.decision, 'approved');
  assert.deepEqual(feedbackCall.payload.appliedHabitIds, ['h_prio_high']);
});

test('compactConversation folds older tool results, drops oldest whole turns into memo, and keeps toolCallId pairs intact', () => {
  const largeToolText = '详细日志条目 '.repeat(400);
  const mkAssistantToolTurn = (id, name, reply) => ([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: { projectId: 'p1' } }],
      api: 'openai-completions',
      provider: 'ollama',
      model: 'qwen2.5:7b',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 1,
    },
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: largeToolText }],
      isError: false,
      timestamp: 2,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: reply }],
      api: 'openai-completions',
      provider: 'ollama',
      model: 'qwen2.5:7b',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 3,
    },
  ]);

  const messages = [
    { role: 'user', content: '第1轮：检查最早的发布准备情况', timestamp: 10 },
    ...mkAssistantToolTurn('tc_1', 'inspect_release', '已完成第1轮发布检查并记录风险。'),
    { role: 'user', content: '第2轮：补充依赖排查', timestamp: 20 },
    ...mkAssistantToolTurn('tc_2', 'inspect_deps', '第2轮依赖全部就绪。'),
    { role: 'user', content: '第3轮：确认当前灰度任务', timestamp: 30 },
    ...mkAssistantToolTurn('tc_3', 'get_tasks', '第3轮任务保持最新状态。'),
    { role: 'user', content: '第4轮：生成今日结论', timestamp: 40 },
  ];

  // Turns 1-2 (older than the last 2) get folded; with a tight maxChars the oldest turn is then dropped to memo
  const compact = compactConversation(messages, { maxChars: 3200, keepFullTurns: 2 });
  assert.ok(compact.memo);
  assert.match(compact.memo, /第1轮/);
  assert.match(compact.memo, /inspect_release/);
  assert.match(compact.memo, /已完成第1轮发布检查并记录风险/);
  assert.ok(compact.memo.length <= 2000);

  // Original input is never mutated
  assert.equal(messages[2].content[0].text, largeToolText);

  // Turn 1 dropped; turn 2's toolResult folded while preserving toolCallId pair; turn 3 kept full
  assert.ok(!compact.messages.some(m => m.role === 'user' && m.content.includes('第1轮')));
  const foldedToolResult = compact.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'tc_2');
  assert.ok(foldedToolResult);
  assert.match(foldedToolResult.content[0].text, /^\[早期工具结果已折叠\] inspect_deps/);
  const fullToolResult = compact.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'tc_3');
  assert.ok(fullToolResult);
  assert.equal(fullToolResult.content[0].text, largeToolText);

  // Every remaining toolResult still has its matching toolCall in the preceding assistant message
  const toolCallIds = new Set(
    compact.messages.flatMap(m =>
      m.role === 'assistant' ? m.content.filter(p => p.type === 'toolCall').map(p => p.id) : [],
    ),
  );
  for (const msg of compact.messages) {
    if (msg.role === 'toolResult') assert.ok(toolCallIds.has(msg.toolCallId));
  }

  // Current turn is never dropped even if it alone exceeds maxChars
  const giantLast = compactConversation(
    [{ role: 'user', content: 'X'.repeat(5000), timestamp: 1 }],
    { maxChars: 100, keepFullTurns: 2 },
  );
  assert.equal(giantLast.messages.length, 1);
  assert.equal(giantLast.memo, null);
});

test('createPmCopilotAgent compacts long context for proxy while keeping agent state history intact', async () => {
  let seenSystem = '';
  let seenMessages = [];
  const agent = createPmCopilotAgent({
    getState: () => baseState,
    getDate: () => '2026-11-25',
    getProjectId: () => 'p1',
    getContextLabel: () => '项目工作台',
    onMutated: async () => {},
    requestApproval: async () => true,
    executor: async (command, payload) => {
      if (command === 'copilot_agent_turn') {
        seenSystem = payload.messages[0].content;
        seenMessages = payload.messages.slice(1);
        return {
          model: 'qwen2.5:7b',
          provider: 'ollama',
          content: '收到。',
          toolCalls: [],
          stopReason: 'stop',
        };
      }
      return {};
    },
  });

  // Seed a multi-turn conversation exceeding 24k chars across older turns
  const hugeReply = '历史长正文'.repeat(3000);
  const makeTurn = (idx) => ([
    { role: 'user', content: `历史问题${idx}`, timestamp: idx * 10 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: `第${idx}轮结论：${hugeReply}` }],
      api: 'openai-completions',
      provider: 'ollama',
      model: 'qwen2.5:7b',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: idx * 10 + 1,
    },
  ]);
  agent.state.messages = [...makeTurn(1), ...makeTurn(2), ...makeTurn(3)];
  const beforeLen = agent.state.messages.length;

  await agent.prompt('当前最新问题');
  await agent.waitForIdle();

  assert.match(seenSystem, /早期对话备忘/);
  assert.match(seenSystem, /历史问题1/);
  assert.ok(seenMessages.length < beforeLen + 1);
  assert.equal(seenMessages[seenMessages.length - 1].content, '当前最新问题');
  // Agent's stored conversation state was not truncated
  assert.equal(agent.state.messages.length, beforeLen + 2);
});

test('propose_user_habit tool delegates pending habit proposal to Rust without requiring write approval', async () => {
  const calls = [];
  let mutated = 0;
  const tools = createPmAgentTools({
    executor: async (command, payload) => {
      calls.push({ command, payload });
      return {
        id: 'hp_explicit_1',
        status: 'pending',
        patternKey: 'explicit:writing:custom',
        ...payload,
      };
    },
    getState: () => baseState,
    getDate: () => '2026-11-25',
    getProjectId: () => 'p1',
    onMutated: async () => {
      mutated += 1;
    },
  });
  const tool = tools.find(t => t.name === 'propose_user_habit');
  assert.ok(tool);
  const res = await tool.execute('call_1', {
    category: 'writing',
    title: '高管周报省略常规巡检',
    instruction: '向老板汇报时跳过已完成且无异常的常规巡检项。',
    audience: 'executive',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'propose_user_habit');
  assert.equal(calls[0].payload.category, 'writing');
  assert.deepEqual(calls[0].payload.rule, { action: 'explicit_teaching', audience: 'executive' });
  assert.equal(calls[0].payload.projectId, undefined);
  assert.equal(mutated, 1);
  assert.match(res.content[0].text, /hp_explicit_1/);
});
