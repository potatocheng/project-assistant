import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPriorRunLedger, loadBudgetAddendum, remainingRunBudget, budgetHash, budgetCanonical, verifyRecordedBudget } from './memory-public-live-budget.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-budget-test-'));
  t.after(async () => { assert(path.basename(root).startsWith('memory-budget-test-')); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'docs')); await mkdir(path.join(root, '.local-data'));
  async function saveRun(tag, tokens, prior = null) {
    const workspace = `.local-data/public-memory-live-${tag}`; await mkdir(path.join(root, workspace), { recursive: true });
    const request = { model: 'unit', messages: [{ role: 'user', content: '{}' }] }, usage = { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens };
    const receipt = { index: 1, phase: 'qa', requestSha256: budgetHash(JSON.stringify(request)), usage };
    const raw = { ...receipt, request, responseText: JSON.stringify({ model: 'unit', usage }) };
    const report = { outputTag: tag, workspace, split: 'development', datasetSha256: 'data', model: 'unit', startedAt: '2026-10-20T01:00:00Z',
      finishedAt: '2026-10-20T02:00:00Z', receipts: [receipt], usage: { total_tokens: tokens }, priorRun: prior ? { workspace: prior.workspace, requests: 1, totalTokens: prior.usage.total_tokens } : null };
    await writeFile(path.join(root, workspace, 'receipts.jsonl'), JSON.stringify(raw) + '\n'); await persist(report);
    return report;
  }
  async function persist(report) {
    const detailFile = `${report.workspace}/results.json`, bytes = JSON.stringify(report);
    await writeFile(path.join(root, detailFile), bytes);
    await writeFile(path.join(root, 'docs', `memory-public-live-${report.outputTag}-results.json`), JSON.stringify({ ...report,
      artifactKind: 'compact_public_live_report', detailFile, detailSha256: budgetHash(bytes) }));
  }
  const a = await saveRun('qa-calibrated-dev-a', 100), b = await saveRun('qa-calibrated-dev-b', 200, a);
  const priorFile = `docs/memory-public-live-${b.outputTag}-results.json`;
  const ledger = await buildPriorRunLedger(root, priorFile, { model: 'unit', datasetSha256: 'data', tagPrefix: 'qa-calibrated-dev', split: 'development' });
  const base = { version: 'memory-qa-calibrated-preregistration-v1', datasetSha256: 'data', model: 'unit', thresholds: { accuracy: 14, protocol: 0 },
    limits: { development: { maxRequests: 600, maxTokens: 3000000 }, full: { maxRequests: 2000, maxTokens: 12000000 } } };
  const baseFile = 'docs/base.json', baseBytes = JSON.stringify(base); await writeFile(path.join(root, baseFile), baseBytes);
  const failedGates = [];
  for (const name of ['a', 'b']) { const file = `docs/gate-${name}.json`, bytes = JSON.stringify({ passed: false, report: `docs/memory-public-live-qa-calibrated-dev-${name}-results.json` }); await writeFile(path.join(root, file), bytes); failedGates.push({ file, sha256: budgetHash(bytes) }); }
  const addendum = { version: 'memory-qa-calibrated-budget-addendum-v1', registeredAt: '2026-10-20T03:00:00Z',
    baseRegistration: { file: baseFile, sha256: budgetHash(baseBytes) }, baseThresholdsSha256: budgetHash(budgetCanonical(base.thresholds)),
    originalDevelopmentLimits: base.limits.development, extension: { maxRequests: 300, maxTokens: 1500000 },
    effectiveDevelopmentLimits: { maxRequests: 900, maxTokens: 4500000 }, fullLimitsUnchanged: base.limits.full, boundPriorLedger: ledger, failedGates };
  const addendumFile = 'docs/addendum.json'; await writeFile(path.join(root, addendumFile), JSON.stringify(addendum));
  return { root, a, b, ledger, priorFile, baseFile, addendum, addendumFile, persist };
}

test('recursive prior accounting includes both failed runs once and cannot reset to the immediate prior only', async t => {
  const f = await fixture(t); assert.equal(f.ledger.requests, 2); assert.equal(f.ledger.totalTokens, 300);
  const result = remainingRunBudget({ maxRequests: 900, maxTokens: 4500000, ledger: f.ledger, effectiveLimits: { maxRequests: 900, maxTokens: 4500000 } });
  assert.deepEqual(result, { requests: 898, observedTotalTokens: 4499700 });
  const again = await buildPriorRunLedger(f.root, `docs/../${f.priorFile}`); assert.deepEqual(again, f.ledger);
});

test('prior linkage forgery, cycles, and wrong round/model/dataset fail closed', async t => {
  const f = await fixture(t);
  for (const expected of [{ model: 'other' }, { datasetSha256: 'other' }, { tagPrefix: 'another-round' }, { split: 'all' }])
    await assert.rejects(buildPriorRunLedger(f.root, f.priorFile, expected), /round mismatch/);
  f.b.priorRun.requests = 2; await f.persist(f.b); await assert.rejects(buildPriorRunLedger(f.root, f.priorFile), /linkage/);
  f.b.priorRun.requests = 1; await f.persist(f.b);
  f.a.priorRun = { workspace: f.b.workspace, requests: 1, totalTokens: 200 }; await f.persist(f.a);
  await assert.rejects(buildPriorRunLedger(f.root, f.priorFile), /cycle|duplicate workspace/);
});

test('raw provider usage and artifact hashes are verified rather than trusting claimed totals', async t => {
  const f = await fixture(t), transcript = path.join(f.root, f.b.workspace, 'receipts.jsonl');
  const raw = JSON.parse((await readFile(transcript, 'utf8')).trim()); raw.usage.total_tokens = 1;
  await writeFile(transcript, JSON.stringify(raw) + '\n'); await assert.rejects(buildPriorRunLedger(f.root, f.priorFile), /metadata|usage/);
  const detail = path.join(f.root, f.b.workspace, 'results.json'); await writeFile(detail, '{}');
  await assert.rejects(buildPriorRunLedger(f.root, f.priorFile), /fingerprint/);
});

test('the one-time addendum binds original thresholds, both pilots, time and permitted arithmetic', async t => {
  const f = await fixture(t), options = { ledger: f.ledger, before: '2026-10-20T04:00:00Z' };
  const result = await loadBudgetAddendum(f.root, f.addendumFile, options); assert.equal(result.authorization.effectiveDevelopmentLimits.maxRequests, 900);
  await assert.rejects(loadBudgetAddendum(f.root, f.addendumFile, { ...options, before: '2026-10-20T02:00:00Z' }), /precede/);
  await assert.rejects(loadBudgetAddendum(f.root, f.addendumFile, { ...options, ledger: { ...f.ledger, entries: f.ledger.entries.slice(1) } }), /omit/);
  f.addendum.extension.maxRequests++; await writeFile(path.join(f.root, f.addendumFile), JSON.stringify(f.addendum));
  await assert.rejects(loadBudgetAddendum(f.root, f.addendumFile, options), /arithmetic/);
});

test('a later run preserves and verifies its embedded full prior ledger; omission cannot buy budget', async t => {
  const f = await fixture(t), report = { model: 'unit', datasetSha256: 'data', split: 'development', startedAt: '2026-10-20T04:00:00Z', priorBudgetLedger: f.ledger, priorRun: { workspace: f.b.workspace, requests: 1, totalTokens: 200 } };
  const loaded = await loadBudgetAddendum(f.root, f.addendumFile, { ledger: f.ledger, before: report.startedAt }); report.budgetAuthorization = loaded.authorization;
  assert.equal((await verifyRecordedBudget(f.root, report)).ledger.requests, 2);
  report.priorBudgetLedger = { ...f.ledger, requests: 1 }; await assert.rejects(verifyRecordedBudget(f.root, report), /changed/);
  delete report.priorBudgetLedger; await assert.rejects(verifyRecordedBudget(f.root, report), /omitted/);
  assert.throws(() => remainingRunBudget({ maxRequests: 901, maxTokens: 4500000, ledger: f.ledger, effectiveLimits: loaded.authorization.effectiveDevelopmentLimits }), /exceeds/);
});

test('real preserved pilots reconcile exactly with the registered extension before new API calls', async () => {
  const root = process.cwd(), ledger = await buildPriorRunLedger(root, 'docs/memory-public-live-qa-calibrated-dev-v2-results.json');
  const extension = await loadBudgetAddendum(root, 'docs/memory-qa-calibrated-budget-addendum-1.json', { ledger, before: new Date().toISOString() });
  assert.equal(ledger.requests, 548); assert.equal(ledger.totalTokens, 2451045);
  assert.deepEqual(remainingRunBudget({ maxRequests: 900, maxTokens: 4500000, ledger, effectiveLimits: extension.authorization.effectiveDevelopmentLimits }), { requests: 352, observedTotalTokens: 2048955 });
});
