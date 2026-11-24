import test from 'node:test';
import assert from 'node:assert/strict';
import { createPmCopilotAgent } from '../src/components/shell/pi-copilot-agent.ts';

const baseState = () => ({
  workspace: { dataDir: '/tmp/test', schemaVersion: 1, recoveredJobs: 0 },
  projects: [{ id: 'p1', name: '客户服务平台一期', description: '', createdAt: '2026-11-01' }],
  sources: [],
  proposals: [],
  memories: [],
  jobs: [],
  backups: [],
  aiSettings: {
    provider: 'openai_compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    outputFormat: 'json_object',
    timeoutSeconds: 30,
    autoExtract: true,
    remoteConsent: true,
    configured: true,
    hasApiKey: true,
  },
  memoryReviewCount: 0,
  tasks: [
    {
      id: 't1',
      projectId: 'p1',
      title: '确认页面设计稿',
      description: '',
      category: 'action',
      assignee: '王磊',
      priority: 'high',
      status: 'in_progress',
      progress: 60,
      dueDate: '2026-11-23',
      plannedDate: '2026-11-23',
      version: 3,
      origin: 'manual',
      memoryId: null,
      memoryRevision: null,
      createdAt: '2026-11-01',
      updatedAt: '2026-11-23',
    },
  ],
  taskProposals: [],
  reports: [],
});

test('Pi Agent runs read-only tools automatically and gates write tools behind HITL approval', async () => {
  const executedCommands = [];
  let turn = 0;
  const approvals = [];
  let mutatedCount = 0;

  const executor = async (command, payload) => {
    executedCommands.push({ command, payload });
    if (command === 'copilot_agent_turn') {
      turn += 1;
      if (turn === 1) {
        // Turn 1: model calls read-only list_tasks
        return {
          model: 'test-model',
          provider: 'openai_compatible',
          content: '',
          toolCalls: [{ id: 'call_read_1', name: 'list_tasks', arguments: { projectId: 'p1' } }],
          stopReason: 'toolUse',
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        };
      }
      if (turn === 2) {
        // Turn 2: model calls write tool update_task
        return {
          model: 'test-model',
          provider: 'openai_compatible',
          content: '',
          toolCalls: [
            {
              id: 'call_write_1',
              name: 'update_task',
              arguments: { taskId: 't1', dueDate: '2026-11-27', note: '顺延至周五' },
            },
          ],
          stopReason: 'toolUse',
          usage: { inputTokens: 150, outputTokens: 25, totalTokens: 175 },
        };
      }
      // Turn 3: final summary
      return {
        model: 'test-model',
        provider: 'openai_compatible',
        content: '已将「确认页面设计稿」截止日期顺延至 2026-11-27。',
        toolCalls: [],
        stopReason: 'stop',
        usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
      };
    }
    if (command === 'update_task') {
      return { id: 't1', dueDate: payload.dueDate };
    }
    return {};
  };

  const agent = createPmCopilotAgent({
    executor,
    getState: baseState,
    getDate: () => '2026-11-23',
    getProjectId: () => 'p1',
    getContextLabel: () => '今日行动流',
    onMutated: async () => { mutatedCount += 1; },
    requestApproval: async (req) => {
      approvals.push(req);
      return true;
    },
  });

  await agent.prompt('把确认页面设计稿延到周五');
  await agent.waitForIdle();

  // Read tool never triggered approval; write tool triggered exactly 1 approval
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'update_task');
  assert.match(approvals[0].summary, /确认页面设计稿/);
  assert.equal(mutatedCount, 1);

  // Backend received the real update_task payload with baseVersion: 3
  const writeCall = executedCommands.find(c => c.command === 'update_task');
  assert.ok(writeCall);
  assert.equal(writeCall.payload.baseVersion, 3);
  assert.equal(writeCall.payload.dueDate, '2026-11-27');

  // Final assistant message exists
  const lastMsg = agent.state.messages.at(-1);
  assert.equal(lastMsg.role, 'assistant');
  assert.match(lastMsg.content[0].text, /2026-11-27/);
});

test('Pi Agent blocks write tool safely when user rejects HITL approval', async () => {
  const executedCommands = [];
  let turn = 0;

  const executor = async (command, payload) => {
    executedCommands.push({ command, payload });
    if (command === 'copilot_agent_turn') {
      turn += 1;
      if (turn === 1) {
        return {
          model: 'test-model',
          provider: 'openai_compatible',
          content: '',
          toolCalls: [
            {
              id: 'call_create_1',
              name: 'create_task',
              arguments: { projectId: 'p1', title: '测试任务' },
            },
          ],
          stopReason: 'toolUse',
          usage: { inputTokens: 80, outputTokens: 15, totalTokens: 95 },
        };
      }
      return {
        model: 'test-model',
        provider: 'openai_compatible',
        content: '好的，已取消创建该任务。',
        toolCalls: [],
        stopReason: 'stop',
        usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
      };
    }
    return {};
  };

  const agent = createPmCopilotAgent({
    executor,
    getState: baseState,
    getDate: () => '2026-11-23',
    getProjectId: () => 'p1',
    getContextLabel: () => '今日行动流',
    onMutated: async () => {},
    requestApproval: async () => false,
  });

  await agent.prompt('帮我建个测试任务');
  await agent.waitForIdle();

  // Backend create_task must NEVER have been called
  assert.equal(executedCommands.some(c => c.command === 'create_task'), false);
  const lastMsg = agent.state.messages.at(-1);
  assert.equal(lastMsg.role, 'assistant');
  assert.match(lastMsg.content[0].text, /取消/);
});
