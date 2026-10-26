// Offline round registration and cumulative accounting. No provider access.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { budgetHash, budgetCanonical, buildPriorRunLedger, remainingRunBudget } from './memory-public-live-budget.mjs';

export const qaTargetedRegistrationFile = 'docs/memory-qa-targeted-preregistration.json';
const equal = (a, b) => budgetCanonical(a) === budgetCanonical(b);
export function qaTargetedBudgetState(registration, { split, ledger = null, maxRequests, maxTokens }) {
  if (!equal(registration.limits.development, { maxRequests: 1200, maxTokens: 6000000, maxFreshAttempts: 4 })
      || !equal(registration.limits.full, { maxRequests: 2000, maxTokens: 12000000 })) throw new Error('Targeted registered budget cannot be extended or reset');
  if (!['development', 'all'].includes(split)) throw new Error('Targeted live split must be development or all');
  if (split === 'all' && ledger) throw new Error('Targeted full budget is separate; omit prior-run');
  const priorAttempts = ledger?.entries.length ?? 0;
  if (split === 'development' && priorAttempts >= 4) throw new Error('All four registered fresh development attempts are already spent');
  const limits = split === 'development' ? registration.limits.development : registration.limits.full;
  return { limits: remainingRunBudget({ maxRequests, maxTokens, ledger, effectiveLimits: limits }),
    registeredLimits: limits, priorAttempts, attempt: split === 'development' ? priorAttempts + 1 : null };
}

export function assertQaTargetedPriorCoverage(ledger, knownRuns, currentTag) {
  const billed = new Set((ledger?.entries ?? []).map(entry => entry.outputTag));
  if (knownRuns.some(tag => tag !== currentTag && !billed.has(tag))) throw new Error('Targeted prior ledger omitted an existing fresh development run');
}

export function assertQaTargetedTag(split, tag) {
  if (split === 'development' ? !/^qa-targeted-dev(?:-[a-z0-9-]+)?$/.test(tag ?? '') : tag !== 'qa-targeted-full')
    throw new Error('Targeted tags must use qa-targeted-dev[-version] or the single qa-targeted-full');
}

export async function loadQaTargetedRegistration(root, before) {
  const bytes = await readFile(path.resolve(root, qaTargetedRegistrationFile)), registration = JSON.parse(bytes);
  if (registration.version !== 'memory-qa-targeted-preregistration-v1' || !Number.isFinite(Date.parse(registration.registeredAt))
      || before && !(Date.parse(registration.registeredAt) <= Date.parse(before))) throw new Error('Targeted registration must precede live/tests');
  qaTargetedBudgetState(registration, { split: 'development', maxRequests: 1200, maxTokens: 6000000 });
  for (const anchor of [registration.baselineDevelopment, registration.costReferenceDevelopment, registration.baselineFull])
    if (budgetHash(await readFile(path.resolve(root, anchor.file))) !== anchor.sha256) throw new Error('Targeted registered comparison anchor changed');
  const historical = await buildPriorRunLedger(root, registration.historicalRound.ledger.entries.at(-1).file,
    { datasetSha256: registration.datasetSha256, model: registration.model, tagPrefix: 'qa-calibrated-dev', split: 'development' });
  if (!equal(historical, registration.historicalRound.ledger) || historical.entries.length !== 3
      || historical.requests !== 829 || historical.totalTokens !== 3652548) throw new Error('Targeted historical three failed attempts changed');
  if (registration.historicalRound.failedGates.length !== 3) throw new Error('Targeted historical failed gates incomplete');
  for (const [index, anchor] of registration.historicalRound.failedGates.entries()) {
    const gateBytes = await readFile(path.resolve(root, anchor.file)), gate = JSON.parse(gateBytes);
    if (budgetHash(gateBytes) !== anchor.sha256 || gate.passed !== false
        || path.resolve(root, gate.report) !== path.resolve(root, historical.entries[index].file)) throw new Error('Targeted historical failed gate changed');
  }
  const budgetRegistration = { file: qaTargetedRegistrationFile, sha256: budgetHash(bytes), registeredAt: registration.registeredAt,
    developmentLimits: registration.limits.development, fullLimits: registration.limits.full,
    historicalLedgerSha256: historical.sha256 };
  return { registration, budgetRegistration, historical };
}

export async function prepareQaTargetedBudget(root, { split, priorFile, model, datasetSha256, before, currentTag, maxRequests, maxTokens }) {
  assertQaTargetedTag(split, currentTag);
  const evidence = await loadQaTargetedRegistration(root, before), { registration } = evidence;
  if (registration.model !== model || registration.datasetSha256 !== datasetSha256) throw new Error('Targeted budget model/dataset mismatch');
  const ledger = priorFile ? await buildPriorRunLedger(root, priorFile,
    { datasetSha256, model, tagPrefix: 'qa-targeted-dev', split: 'development' }) : null;
  if (split === 'development') {
    const known = (await readdir(path.resolve(root, 'docs'))).filter(file => /^memory-public-live-qa-targeted-dev(?:-[a-z0-9-]+)?-results\.json$/.test(file));
    const tags = await Promise.all(known.map(async file => JSON.parse(await readFile(path.resolve(root, 'docs', file))).outputTag));
    assertQaTargetedPriorCoverage(ledger, tags, currentTag);
  }
  return { ...evidence, ledger, ...qaTargetedBudgetState(registration, { split, ledger, maxRequests, maxTokens }) };
}

export async function verifyQaTargetedRecordedBudget(root, report) {
  assertQaTargetedTag(report.split, report.outputTag);
  const evidence = await loadQaTargetedRegistration(root, report.startedAt), recorded = report.priorBudgetLedger;
  if (report.budgetAuthorization) throw new Error('Targeted is an independent round, not a calibrated budget addendum');
  if (report.model !== evidence.registration.model || report.datasetSha256 !== evidence.registration.datasetSha256) throw new Error('Targeted recorded model/dataset mismatch');
  const ledger = recorded ? await buildPriorRunLedger(root, recorded.entries.at(-1)?.file,
    { datasetSha256: report.datasetSha256, model: report.model, tagPrefix: 'qa-targeted-dev', split: 'development' }) : null;
  if (!equal(recorded ?? null, ledger) || !equal(report.budgetRegistration, evidence.budgetRegistration)) throw new Error('Targeted recorded registration or cumulative ledger changed');
  if (!!report.priorRun !== !!ledger) throw new Error('Targeted immediate prior and cumulative ledger disagree');
  if (ledger) {
    const last = ledger.entries.at(-1);
    assert.equal(path.resolve(root, last.workspace), path.resolve(root, report.priorRun.workspace));
    assert.equal(last.requests, report.priorRun.requests); assert.equal(last.totalTokens, report.priorRun.totalTokens);
  }
  const state = qaTargetedBudgetState(evidence.registration, { split: report.split, ledger,
    maxRequests: report.limits.requests + (ledger?.requests ?? 0), maxTokens: report.limits.observedTotalTokens + (ledger?.totalTokens ?? 0) });
  if (report.receipts.length > report.limits.requests || report.usage.total_tokens > report.limits.observedTotalTokens) throw new Error('Targeted observed usage exceeded declared budget');
  return { ...evidence, ledger, ...state };
}
