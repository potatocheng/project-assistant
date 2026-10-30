import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { budgetHash, budgetCanonical, buildPriorRunLedger, remainingRunBudget } from './memory-public-live-budget.mjs';

export const qaStructuredRegistrationFile = 'docs/memory-qa-structured-preregistration.json';
const equal = (a, b) => budgetCanonical(a) === budgetCanonical(b);
export const structuredDevelopmentLimits = Object.freeze({ maxRequests: 1200, maxTokens: 6000000, maxFreshAttempts: 3, maxDiagnosticPairs: 1 });
export function qaStructuredBudgetState(registration, { split, ledger = null, maxRequests, maxTokens, currentTag }) {
  if (!equal(registration.limits.development, structuredDevelopmentLimits)
      || !equal(registration.limits.full, { maxRequests: 2000, maxTokens: 12000000 })) throw new Error('Structured registered budget cannot be extended or reset');
  if (!['development', 'all'].includes(split)) throw new Error('Structured live split must be development or all');
  if (split === 'all' && ledger) throw new Error('Structured full budget is separate; omit prior-run');
  const entries = ledger?.entries ?? [], priorAttempts = entries.filter(e => /^qa-structured-dev(?:-|$)/.test(e.outputTag)).length;
  const diagnosticTags = entries.filter(e => e.outputTag.startsWith('qa-structured-diag-')).map(e => e.outputTag);
  if (diagnosticTags.length > 2 || new Set(diagnosticTags).size !== diagnosticTags.length) throw new Error('Only one frozen-memory diagnostic pair is registered');
  if (split === 'development' && currentTag?.startsWith('qa-structured-dev') && priorAttempts >= 3) throw new Error('All three registered fresh development attempts are already spent');
  if (currentTag?.startsWith('qa-structured-diag-') && diagnosticTags.includes(currentTag)) throw new Error('Diagnostic arm already spent; resume its isolated workspace');
  const limits = split === 'development' ? registration.limits.development : registration.limits.full;
  return { limits: remainingRunBudget({ maxRequests, maxTokens, ledger, effectiveLimits: limits }), registeredLimits: limits,
    priorAttempts, attempt: split === 'development' && !currentTag?.startsWith('qa-structured-diag-') ? priorAttempts + 1 : null,
    diagnosticArmsSpent: diagnosticTags };
}
export function assertQaStructuredTag(split, tag) {
  if (split === 'development' ? !/^qa-structured-(?:dev(?:-[a-z0-9-]+)?|diag-(?:baseline|candidate))$/.test(tag ?? '') : tag !== 'qa-structured-full')
    throw new Error('Structured tags must be dev[-version], diag-baseline/diag-candidate or the single full');
}
export function assertQaStructuredPriorCoverage(ledger, knownRuns, currentTag) {
  const billed = new Set((ledger?.entries ?? []).map(e => e.outputTag));
  if (knownRuns.some(tag => tag !== currentTag && !billed.has(tag))) throw new Error('Structured prior ledger omitted an existing fresh run, including failed or interrupted runs');
}
export async function loadQaStructuredRegistration(root, before) {
  const bytes = await readFile(path.resolve(root, qaStructuredRegistrationFile)), registration = JSON.parse(bytes);
  if (registration.version !== 'memory-qa-structured-preregistration-v1' || !Number.isFinite(Date.parse(registration.registeredAt))
      || before && Date.parse(registration.registeredAt) > Date.parse(before)) throw new Error('Structured registration must precede tests/live');
  qaStructuredBudgetState(registration, { split: 'development', maxRequests: 1200, maxTokens: 6000000 });
  for (const anchor of [registration.baselineDevelopment, registration.costReferenceDevelopment, registration.baselineFull,
    registration.diagnosticFrozenMemory]) if (!anchor || budgetHash(await readFile(path.resolve(root, anchor.file))) !== anchor.sha256) throw new Error('Structured registered comparison or frozen-memory anchor changed');
  const historical = [];
  for (const round of registration.historicalRounds ?? []) {
    const ledger = await buildPriorRunLedger(root, round.ledger.entries.at(-1).file,
      { datasetSha256: registration.datasetSha256, model: registration.model, tagPrefix: round.name + '-dev', split: 'development' });
    if (!equal(ledger, round.ledger)) throw new Error('Structured historical failed-round ledger changed');
    historical.push({ name: round.name, ledger });
  }
  if (!historical.some(r => r.name === 'qa-targeted' && r.ledger.requests === 977 && r.ledger.totalTokens === 4480674)
      || !historical.some(r => r.name === 'qa-calibrated' && r.ledger.requests === 829 && r.ledger.totalTokens === 3652548)) throw new Error('Structured historical failures must remain separately billed');
  const baselineBinary = registration.baselineBinary;
  if (!baselineBinary || budgetHash(await readFile(path.resolve(root, baselineBinary.file))) !== baselineBinary.sha256) throw new Error('Structured baseline binary fingerprint changed');
  const budgetRegistration = { file: qaStructuredRegistrationFile, sha256: budgetHash(bytes), registeredAt: registration.registeredAt,
    developmentLimits: registration.limits.development, fullLimits: registration.limits.full,
    historicalLedgerSha256: historical.map(r => ({ name: r.name, sha256: r.ledger.sha256 })) };
  return { registration, budgetRegistration, historical };
}
async function knownStructuredRuns(root) {
  const tags = [];
  for (const file of (await readdir(path.join(root, 'docs'))).filter(f => /^memory-public-live-qa-structured-(?:dev|diag-).*results\.json$/.test(f)))
    tags.push(JSON.parse(await readFile(path.join(root, 'docs', file))).outputTag);
  for (const dir of (await readdir(path.join(root, '.local-data'))).filter(d => d.startsWith('public-memory-live-'))) {
    try { const r = JSON.parse(await readFile(path.join(root, '.local-data', dir, 'progress.json'))); if (r.split === 'development' && r.outputTag?.startsWith('qa-structured-') && r.receipts?.length) tags.push(r.outputTag); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...new Set(tags)];
}
export async function prepareQaStructuredBudget(root, { split, priorFile, model, datasetSha256, before, currentTag, maxRequests, maxTokens }) {
  assertQaStructuredTag(split, currentTag);
  const evidence = await loadQaStructuredRegistration(root, before), { registration } = evidence;
  if (registration.model !== model || registration.datasetSha256 !== datasetSha256) throw new Error('Structured model/dataset mismatch');
  const ledger = priorFile ? await buildPriorRunLedger(root, priorFile, { datasetSha256, model, tagPrefix: 'qa-structured-', split: 'development' }) : null;
  if (split === 'development') assertQaStructuredPriorCoverage(ledger, await knownStructuredRuns(root), currentTag);
  return { ...evidence, ledger, ...qaStructuredBudgetState(registration, { split, ledger, maxRequests, maxTokens, currentTag }) };
}
export async function verifyQaStructuredRecordedBudget(root, report) {
  assertQaStructuredTag(report.split, report.outputTag);
  const evidence = await loadQaStructuredRegistration(root, report.startedAt), recorded = report.priorBudgetLedger;
  if (report.budgetAuthorization || report.model !== evidence.registration.model || report.datasetSha256 !== evidence.registration.datasetSha256) throw new Error('Structured recorded registration mismatch');
  const ledger = recorded ? await buildPriorRunLedger(root, recorded.entries.at(-1)?.file,
    { datasetSha256: report.datasetSha256, model: report.model, tagPrefix: 'qa-structured-', split: 'development' }) : null;
  if (!equal(recorded ?? null, ledger) || !equal(report.budgetRegistration, evidence.budgetRegistration) || !!report.priorRun !== !!ledger) throw new Error('Structured recorded cumulative ledger changed');
  if (ledger) { const last = ledger.entries.at(-1); if (path.resolve(root, last.workspace) !== path.resolve(root, report.priorRun.workspace)
    || last.requests !== report.priorRun.requests || last.totalTokens !== report.priorRun.totalTokens) throw new Error('Structured immediate prior mismatch'); }
  const state = qaStructuredBudgetState(evidence.registration, { split: report.split, ledger, currentTag: report.outputTag,
    maxRequests: report.limits.requests + (ledger?.requests ?? 0), maxTokens: report.limits.observedTotalTokens + (ledger?.totalTokens ?? 0) });
  if (report.receipts.length > report.limits.requests || report.usage.total_tokens > report.limits.observedTotalTokens) throw new Error('Structured observed budget exceeded');
  return { ...evidence, ledger, ...state };
}
