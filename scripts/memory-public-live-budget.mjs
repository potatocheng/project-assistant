// Offline accounting only. Never calls a provider or changes prior artifacts.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const budgetHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const budgetCanonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const relative = (root, file) => path.relative(root, file).replaceAll('\\', '/');
const equal = (a, b) => budgetCanonical(a) === budgetCanonical(b);
const safeCount = n => Number.isSafeInteger(n) && n >= 0;
const parse = bytes => JSON.parse(bytes.toString('utf8'));
const within = (file, directory) => file.startsWith(directory + path.sep);

export async function readVerifiedBudgetRun(root, requested) {
  const initial = parse(await readFile(path.resolve(root, requested)));
  const tag = initial.outputTag;
  if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) throw new Error('Budget prior output tag');
  const compactFile = path.join(root, 'docs', `memory-public-live-${tag}-results.json`);
  const compactBytes = await readFile(compactFile), compact = parse(compactBytes);
  if (compact.artifactKind !== 'compact_public_live_report') throw new Error('Budget prior requires immutable compact artifact');
  const detailFile = path.resolve(root, compact.detailFile);
  if (!within(detailFile, path.join(root, '.local-data'))) throw new Error('Budget prior details outside isolated artifacts');
  const detailBytes = await readFile(detailFile), report = parse(detailBytes);
  if (budgetHash(detailBytes) !== compact.detailSha256 || report.outputTag !== tag || report.datasetSha256 !== compact.datasetSha256) throw new Error('Budget prior artifact fingerprint mismatch');
  const workspace = await realpath(path.resolve(root, report.workspace));
  if (!within(workspace, await realpath(path.join(root, '.local-data'))) || await realpath(detailFile) !== path.join(workspace, 'results.json')) throw new Error('Budget prior workspace mismatch');
  const transcriptFile = path.join(workspace, 'receipts.jsonl'), transcriptBytes = await readFile(transcriptFile);
  const receipts = transcriptBytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!Array.isArray(report.receipts) || report.receipts.length !== receipts.length) throw new Error('Budget prior receipt count mismatch');
  const byIndex = new Map(receipts.map(receipt => [receipt.index, receipt]));
  if (byIndex.size !== receipts.length || new Set(report.receipts.map(receipt => receipt.index)).size !== receipts.length) throw new Error('Budget prior duplicate receipt');
  let totalTokens = 0;
  for (const metadata of report.receipts) {
    const raw = byIndex.get(metadata.index);
    if (!raw || !safeCount(metadata.index) || metadata.index < 1 || metadata.index > receipts.length) throw new Error('Budget prior receipt index');
    const { request, responseText, ...captured } = raw;
    assert.deepEqual(captured, metadata, 'Budget prior receipt metadata mismatch');
    if (budgetHash(JSON.stringify(request)) !== metadata.requestSha256) throw new Error('Budget prior request fingerprint');
    const provider = JSON.parse(responseText);
    if (!safeCount(provider.usage?.total_tokens) || !safeCount(metadata.usage?.total_tokens)) throw new Error('Budget prior usage incomplete');
    assert.deepEqual(provider.usage, metadata.usage, 'Budget prior provider usage mismatch');
    totalTokens += metadata.usage.total_tokens;
  }
  if (!safeCount(totalTokens) || report.usage?.total_tokens !== totalTokens) throw new Error('Budget prior usage total mismatch');
  const entry = { file: relative(root, compactFile), sha256: budgetHash(compactBytes), detailFile: relative(root, detailFile),
    detailSha256: budgetHash(detailBytes), transcriptFile: relative(root, transcriptFile), transcriptSha256: budgetHash(transcriptBytes),
    workspace: report.workspace, outputTag: report.outputTag, startedAt: report.startedAt, finishedAt: report.finishedAt,
    requests: receipts.length, totalTokens };
  return { report, entry, workspaceKey: process.platform === 'win32' ? workspace.toLowerCase() : workspace };
}

export async function buildPriorRunLedger(root, requested, expected = {}) {
  const seen = new Set(), entries = [];
  async function visit(file) {
    const value = await readVerifiedBudgetRun(root, file), { report, entry, workspaceKey } = value;
    if (seen.has(workspaceKey)) throw new Error('Budget prior chain cycle or duplicate workspace');
    seen.add(workspaceKey);
    if (expected.datasetSha256 && report.datasetSha256 !== expected.datasetSha256 || expected.model && report.model !== expected.model
        || expected.tagPrefix && !report.outputTag.startsWith(expected.tagPrefix) || expected.split && report.split !== expected.split) throw new Error('Budget prior model/dataset/round mismatch');
    if (report.priorRun) {
      const priorDetail = path.resolve(root, report.priorRun.workspace, 'results.json');
      if (!within(priorDetail, path.join(root, '.local-data'))) throw new Error('Budget prior chain path');
      const prior = await visit(priorDetail);
      if (path.resolve(root, report.priorRun.workspace) !== path.resolve(root, prior.entry.workspace)
          || report.priorRun.requests !== prior.entry.requests || report.priorRun.totalTokens !== prior.entry.totalTokens) throw new Error('Budget prior immediate linkage mismatch');
    }
    if (report.priorBudgetLedger) {
      const priorLedger = makePriorLedger(entries);
      if (!equal(priorLedger, report.priorBudgetLedger)) throw new Error('Budget prior embedded cumulative ledger mismatch');
    }
    entries.push(entry);
    return value;
  }
  if (requested) await visit(requested);
  return makePriorLedger(entries);
}

export function makePriorLedger(entries) {
  const result = { version: 'memory-public-live-prior-ledger-v1', entries,
    requests: entries.reduce((n, entry) => n + entry.requests, 0), totalTokens: entries.reduce((n, entry) => n + entry.totalTokens, 0) };
  return { ...result, sha256: budgetHash(budgetCanonical(result)) };
}

export async function loadBudgetAddendum(root, file, { ledger, before } = {}) {
  const resolved = path.resolve(root, file), bytes = await readFile(resolved), value = parse(bytes);
  const baseBytes = await readFile(path.resolve(root, value.baseRegistration?.file)), base = parse(baseBytes);
  if (value.version !== 'memory-qa-calibrated-budget-addendum-v1' || value.baseRegistration.sha256 !== budgetHash(baseBytes)
      || value.baseThresholdsSha256 !== budgetHash(budgetCanonical(base.thresholds)) || base.version !== 'memory-qa-calibrated-preregistration-v1') throw new Error('Budget addendum immutable base/threshold fingerprint');
  if (!equal(value.originalDevelopmentLimits, base.limits.development)
      || !equal(value.originalDevelopmentLimits, { maxRequests: 600, maxTokens: 3000000 })
      || !equal(value.extension, { maxRequests: 300, maxTokens: 1500000 })
      || !equal(value.effectiveDevelopmentLimits, { maxRequests: 900, maxTokens: 4500000 })
      || !equal(value.fullLimitsUnchanged, base.limits.full)) throw new Error('Budget addendum permitted arithmetic');
  if (!Number.isFinite(Date.parse(value.registeredAt)) || before && !(Date.parse(value.registeredAt) <= Date.parse(before))) throw new Error('Budget addendum must precede tests/live');
  const bound = await buildPriorRunLedger(root, value.boundPriorLedger.entries.at(-1).file,
    { datasetSha256: base.datasetSha256, model: base.model, tagPrefix: 'qa-calibrated-dev', split: 'development' });
  if (!equal(bound, value.boundPriorLedger) || bound.entries.length !== 2
      || bound.entries.some(entry => !(Date.parse(entry.finishedAt) <= Date.parse(value.registeredAt)))) throw new Error('Budget addendum bound failed pilots changed');
  if (ledger && (ledger.entries.length < bound.entries.length
      || !bound.entries.every((entry, index) => equal(entry, ledger.entries[index])))) throw new Error('Budget addendum cannot omit either earlier pilot');
  if (ledger && ledger.entries.slice(bound.entries.length).some(entry => !(Date.parse(entry.startedAt) >= Date.parse(value.registeredAt)))) throw new Error('Later prior run predates budget authorization');
  if (!Array.isArray(value.failedGates) || value.failedGates.length !== 2 || new Set(value.failedGates.map(gate => gate.file)).size !== 2) throw new Error('Budget addendum must retain both failed gates');
  for (const [index, gate] of value.failedGates.entries()) {
    const gateBytes = await readFile(path.resolve(root, gate.file)), parsed = parse(gateBytes);
    if (budgetHash(gateBytes) !== gate.sha256 || parsed.passed !== false
        || path.resolve(root, parsed.report) !== path.resolve(root, bound.entries[index].file)) throw new Error('Budget addendum prior failed gate changed');
  }
  const authorization = { file: relative(root, resolved), sha256: budgetHash(bytes), registeredAt: value.registeredAt,
    baseRegistrationSha256: value.baseRegistration.sha256, baseThresholdsSha256: value.baseThresholdsSha256,
    originalDevelopmentLimits: value.originalDevelopmentLimits, effectiveDevelopmentLimits: value.effectiveDevelopmentLimits,
    boundPriorLedgerSha256: value.boundPriorLedger.sha256 };
  return { document: value, authorization, base, ledger };
}

export function remainingRunBudget({ maxRequests, maxTokens, ledger, immediatePrior, effectiveLimits }) {
  if (effectiveLimits && (maxRequests > effectiveLimits.maxRequests || maxTokens > effectiveLimits.maxTokens)) throw new Error('Requested budget exceeds registered authorization');
  const priorRequests = ledger?.requests ?? immediatePrior?.receipts.length ?? 0;
  const priorTokens = ledger?.totalTokens ?? immediatePrior?.usage.total_tokens ?? 0;
  const requests = maxRequests - priorRequests, observedTotalTokens = maxTokens - priorTokens;
  if (!Number.isSafeInteger(requests) || requests < 1 || !Number.isSafeInteger(observedTotalTokens) || observedTotalTokens < 1) throw new Error('No registered cumulative budget remains');
  return { requests, observedTotalTokens };
}

export async function verifyRecordedBudget(root, report) {
  const recorded = report.priorBudgetLedger;
  if (report.budgetAuthorization && report.split === 'development' && !recorded) throw new Error('Extended development omitted cumulative prior ledger');
  if (report.priorRun && report.evaluationSha256?.['scripts/memory-public-live-budget.mjs'] && !recorded) throw new Error('New budget path omitted cumulative prior ledger');
  const ledger = recorded ? await buildPriorRunLedger(root, recorded.entries.at(-1)?.file,
    { datasetSha256: report.datasetSha256, model: report.model, tagPrefix: 'qa-calibrated-dev', split: 'development' }) : null;
  if (recorded && !equal(recorded, ledger)) throw new Error('Recorded cumulative prior budget changed');
  if (ledger) {
    const last = ledger.entries.at(-1);
    if (!last || !report.priorRun || path.resolve(root, last.workspace) !== path.resolve(root, report.priorRun.workspace)
        || last.requests !== report.priorRun.requests || last.totalTokens !== report.priorRun.totalTokens) throw new Error('Recorded immediate prior disagrees with cumulative ledger');
  }
  const evidence = report.budgetAuthorization ? await loadBudgetAddendum(root, report.budgetAuthorization.file, { ledger, before: report.startedAt }) : null;
  if (evidence && (evidence.base.datasetSha256 !== report.datasetSha256 || evidence.base.model !== report.model)) throw new Error('Budget authorization dataset/model mismatch');
  if (evidence && !equal(evidence.authorization, report.budgetAuthorization)) throw new Error('Recorded budget authorization changed');
  return { ledger, ...(evidence ?? {}) };
}
