import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Render the actual component. No model or browser connection is involved.
const source = readFileSync(new URL('./AssistanceContent.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
new Function('exports', 'React', compiled)(exports, React);

const analysis = {
  generatedAt: '2026-11-03T01:00:00Z', cached: false, model: 'fixture-model', referenceCount: 2,
  limited: false, limitations: [],
  review: { status: 'passed', checks: [], unknowns: [], limitation: '同模型语义复核，不等同人工验收' },
};
function render(trace, extra = {}) {
  return renderToStaticMarkup(React.createElement(exports.AssistanceMeta, { data: { ...analysis, queryTrace: trace, ...extra } }));
}

test('unknown provider usage is shown as unknown, never as zero consumption', () => {
  const html = render({ modelCalls: 2, reportedTokens: 0, usageComplete: false, stages: [{ usage: null }, {}] });
  assert.match(html, /实际消耗未知/);
  assert.doesNotMatch(html, /0 tokens/);
  assert.match(html, /包含生成与复核/);
});

test('partial provider usage stays explicitly incomplete', () => {
  const html = render({ modelCalls: 2, reportedTokens: 120, usageComplete: false, stages: [{ usage: { totalTokens: 120 } }, { usage: null }] });
  assert.match(html, /120 tokens/);
  assert.match(html, /部分调用未报告用量/);
});

test('cached results label the original cost without implying new requests', () => {
  const html = render({ modelCalls: 2, reportedTokens: 240, usageComplete: true, cacheHit: true, stages: [{ usage: { totalTokens: 120 } }, { usage: { totalTokens: 120 } }] }, { cached: true });
  assert.match(html, /原分析调用模型 2 次/);
  assert.match(html, /没有新增模型请求/);
  assert.match(html, /上方用量为原分析记录/);
});

test('legacy results never claim a review and review text is escaped', () => {
  assert.doesNotMatch(render(undefined, { review: undefined }), /已完成模型复核/);
  const html = render(undefined, { review: { ...analysis.review, unknowns: ['<script>unexpected()</script>'] } });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
