import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function loadComponent(path, imports = require) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'require', 'React', compiled)(exports, imports, React);
  return exports;
}
const shared = loadComponent('../work/shared.tsx');
const { AssistanceRunRecordsContent } = loadComponent('./AssistanceRunRecordsContent.tsx', name => name === '../work/shared' ? shared : require(name));

const budget = { date: '2026-11-03', reservedRequests: 2, reportedTokens: 120, unknownUsageRequests: 1, globalRequestLimit: 100, projectRequestLimit: 60 };
const run = {
  runId: 'run-1', status: 'failed', request: { kind: 'coach' },
  createdAt: '2026-11-03T01:00:00Z', updatedAt: '2026-11-03T01:01:00Z',
  unresolvedRequest: false, errorCode: 'PRIVATE_ERROR_CONTENT',
  queryTrace: { modelCalls: 2, reportedTokens: 120, usageComplete: false, stages: [{ usage: { totalTokens: 120 } }, { usage: null }] },
};
function render(data = {}, projectScoped = false) {
  return renderToStaticMarkup(React.createElement(AssistanceRunRecordsContent, { projectScoped, data: { budget, runs: [run], total: 1, offset: 0, ...data } }));
}

test('project request count is not shown as global remaining allowance', () => {
  const html = render({}, true);
  assert.match(html, /本项目模型建议额度/);
  assert.match(html, /已占用 2 \/ 60 次请求/);
  assert.match(html, /此处未读取全局余量/);
  assert.doesNotMatch(html, /剩余 98|剩余 58|已占用 2 \/ 100/);
  assert.match(html, /共 2 次请求/);
  assert.match(html, /本地规则整理与到期复查不调用模型/);
});

test('failed analysis with no reported usage is unknown rather than zero tokens', () => {
  const html = render({
    budget: { ...budget, reservedRequests: 1, reportedTokens: 0 },
    runs: [{ ...run, queryTrace: { modelCalls: 1, reportedTokens: 0, usageComplete: false, stages: [{ usage: null }] } }],
  });
  assert.match(html, /分析未完成/);
  assert.match(html, /实际用量未知/);
  assert.doesNotMatch(html, /0 tokens|PRIVATE_ERROR_CONTENT/);
  assert.match(html, /原分析请求数：1 次/);
});

test('partial usage retains reported tokens and flags the unknown remainder', () => {
  const html = render();
  assert.match(html, /已占用 2 \/ 100 次请求/);
  assert.match(html, /已报告 120 tokens/);
  assert.match(html, /另有 1 次请求未报告用量，实际总量未知/);
  assert.match(html, /不是本次查看新增的消耗/);
});

test('interrupted in-flight reservation remains an unconfirmed request with unknown usage', () => {
  const html = render({ runs: [{ ...run, status: 'interrupted', unresolvedRequest: true, errorCode: 'RESTART_INTERRUPTED', queryTrace: { modelCalls: 0, reportedTokens: 0, usageComplete: true, stages: [] } }] });
  assert.match(html, /已中断/);
  assert.match(html, /原分析请求数：1 次（含 1 次结果未确认的预留请求）/);
  assert.match(html, /应用重启时中断/);
  assert.match(html, /实际用量未知/);
  assert.doesNotMatch(html, /原分析请求数：0|已报告 0 tokens/);
});

test('empty records and running or completed statuses are distinct, with only ten recent records', () => {
  const empty = render({ runs: [], total: 0, budget: { ...budget, reservedRequests: 0, reportedTokens: 0, unknownUsageRequests: 0 } });
  assert.match(empty, /当前范围暂无模型分析记录/);
  assert.match(empty, /尚无模型请求/);
  const html = render({ runs: Array.from({ length: 12 }, (_, index) => ({ ...run, runId: `run-${index}`, status: index === 0 ? 'running' : 'succeeded' })), total: 12 });
  assert.match(html, /分析中/);
  assert.match(html, /已完成核验/);
  assert.match(html, /最近 10 条分析记录/);
  assert.equal((html.match(/<article>/g) ?? []).length, 10);
});
