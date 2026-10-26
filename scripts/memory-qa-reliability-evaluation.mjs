// One independently authorized fresh20 run. Historical rounds stay immutable.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { budgetHash, budgetCanonical, remainingRunBudget } from './memory-public-live-budget.mjs';
import { readPublicLiveReport } from './memory-public-live-io.mjs';

export const qaReliabilityRegistrationFile = 'docs/memory-qa-reliability-preregistration.json';
export const qaReliabilityPreLiveFile = 'docs/memory-qa-reliability-pre-live.json';
export const qaReliabilityLimits = Object.freeze({ maxRequests: 400, maxTokens: 2_000_000, maxFreshAttempts: 1 });
const tag = 'qa-reliability-dev';
const baselineFile = 'docs/memory-public-live-qa-structured-dev-v3-results.json';
const equal = (a, b) => budgetCanonical(a) === budgetCanonical(b);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeCount = value => Number.isSafeInteger(value) && value >= 0;

// Compatibility names keep the isolated runner's execution loop unchanged.
export const qaStructuredEvaluationFiles = Object.freeze([
  'scripts/evaluate-memory-qa-reliability-live.mjs',
  'scripts/memory-qa-reliability-evaluation.mjs',
  'scripts/memory-qa-reliability-evaluation.test.mjs',
  'scripts/verify-memory-qa-reliability-results.mjs',
  'scripts/report-memory-qa-reliability.mjs',
  'scripts/report-memory-qa-reliability.test.mjs',
  qaReliabilityRegistrationFile,
  'scripts/memory-qa-structured-options.mjs',
  'scripts/memory-qa-structured-judges.mjs',
  'scripts/memory-qa-structured-capture.mjs',
  'scripts/memory-qa-structured-freeze.mjs',
  'scripts/memory-qa-structured-review-mapping.mjs',
  'scripts/memory-qa-structured-observations.mjs',
  'scripts/score-memory-qa-structured-live.mjs',
  'scripts/compare-memory-public-live.mjs',
  'scripts/verify-memory-qa-structured-results.mjs',
  'scripts/memory-qa-structured-budget.mjs',
  'scripts/memory-public-live-judges.mjs',
  'scripts/memory-public-live-options.mjs',
  'scripts/memory-public-live-io.mjs',
  'scripts/verify-memory-public-live.mjs',
  'scripts/capture-memory-evaluation-references.mjs',
  'scripts/memory-public-live-budget.mjs',
]);

export async function fingerprintQaStructuredEvaluation(root) {
  return Object.fromEntries(await Promise.all(qaStructuredEvaluationFiles.map(async file =>
    [file, budgetHash(await readFile(path.resolve(root, file)))])));
}

export function assertQaReliabilityRun({ split, currentTag, priorFile, maxRequests, maxTokens }, registration) {
  if (split !== 'development' || currentTag !== tag) throw new Error('Reliability permits only the single qa-reliability-dev fresh20 run');
  if (priorFile) throw new Error('Reliability is independent; historical runs cannot enter its prior ledger');
  if (!equal(registration.limits?.development, qaReliabilityLimits)) throw new Error('Reliability registered limits cannot be extended or reset');
  return remainingRunBudget({ maxRequests, maxTokens, effectiveLimits: qaReliabilityLimits });
}

export async function loadQaReliabilityRegistration(root, before) {
  const bytes = await readFile(path.resolve(root, qaReliabilityRegistrationFile));
  const registration = JSON.parse(bytes);
  if (registration.version !== 'memory-qa-reliability-preregistration-v1'
      || !validDate(registration.registeredAt) || before && (!validDate(before) || Date.parse(registration.registeredAt) > Date.parse(before))) {
    throw new Error('Reliability registration must precede this run');
  }
  assertQaReliabilityRun({ split: 'development', currentTag: tag, maxRequests: 400, maxTokens: 2_000_000 }, registration);
  if (!sha(registration.datasetSha256) || !sha(registration.binarySha256) || !registration.model
      || !registration.productionSha256 || !Object.keys(registration.productionSha256).length
      || Object.entries(registration.productionSha256).some(([file, hash]) => !file.endsWith('.rs') || !sha(hash))) {
    throw new Error('Reliability registration must freeze the fixture, model, source and binary');
  }
  if (registration.baselineDevelopment?.file !== baselineFile
      || budgetHash(await readFile(path.resolve(root, baselineFile))) !== registration.baselineDevelopment.sha256) {
    throw new Error('Reliability historical baseline changed');
  }
  const baseline = await readPublicLiveReport(path.resolve(root, baselineFile));
  if (baseline.model !== registration.model || baseline.datasetSha256 !== registration.datasetSha256
      || baseline.complete !== true || baseline.split !== 'development') throw new Error('Reliability baseline model/fixture/split mismatch');
  const existing = registration.existingVerification;
  if (!existing?.file || !sha(existing.sha256)) throw new Error('Reliability requires existing production verification');
  const verificationBytes = await readFile(path.resolve(root, existing.file));
  if (budgetHash(verificationBytes) !== existing.sha256) throw new Error('Reliability production verification changed');
  const verification = JSON.parse(verificationBytes);
  if (!(verification.rustPassed >= 440 && verification.nodePassed >= 213)
      || verification.clippyPassed !== true || verification.buildPassed !== true || verification.liveModelRequests !== 0
      || verification.binarySha256 !== registration.binarySha256 || !validDate(verification.completedAt)
      || Date.parse(verification.completedAt) > Date.parse(registration.registeredAt)
      || !Object.keys(verification.sourceSha256 ?? {}).length
      || Object.entries(verification.sourceSha256).some(([file, hash]) => registration.productionSha256[file.replace(/^crates\/core\/src\//, '')] !== hash)) {
    throw new Error('Reliability production verification does not cover the registered code');
  }
  const budgetRegistration = { file: qaReliabilityRegistrationFile, sha256: budgetHash(bytes), registeredAt: registration.registeredAt,
    developmentLimits: qaReliabilityLimits, baselineSha256: registration.baselineDevelopment.sha256,
    productionManifestSha256: budgetHash(budgetCanonical(registration.productionSha256)), binarySha256: registration.binarySha256,
    existingVerificationSha256: existing.sha256 };
  return { registration, budgetRegistration, historical: [] };
}

async function knownRuns(root) {
  const runs = new Map();
  const add = report => {
    if (report.outputTag?.startsWith('qa-reliability-')) {
      if (!report.workspace) throw new Error('Reliability existing attempt lacks its original workspace');
      runs.set(path.resolve(root, report.workspace).toLowerCase(), report);
    }
  };
  for (const file of await readdir(path.resolve(root, 'docs'))) {
    if (/^memory-public-live-qa-reliability-.*-results\.json$/.test(file)) add(await readPublicLiveReport(path.resolve(root, 'docs', file)));
  }
  let dirs;
  try { dirs = await readdir(path.resolve(root, '.local-data')); }
  catch (error) { if (error.code === 'ENOENT') return [...runs.values()]; throw error; }
  for (const dir of dirs.filter(dir => dir.startsWith('public-memory-live-'))) {
    try { add(JSON.parse(await readFile(path.resolve(root, '.local-data', dir, 'progress.json')))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...runs.values()];
}

export async function prepareQaStructuredBudget(root, args) {
  const evidence = await loadQaReliabilityRegistration(root, args.before);
  const limits = assertQaReliabilityRun(args, evidence.registration);
  if (evidence.registration.model !== args.model || evidence.registration.datasetSha256 !== args.datasetSha256) {
    throw new Error('Reliability model/fixture mismatch');
  }
  const runs = await knownRuns(root);
  if (!args.resumeRoot && runs.length) throw new Error('The single reliability attempt already exists; resume its original workspace');
  if (args.resumeRoot) {
    const resolved = path.resolve(args.resumeRoot);
    const local = path.resolve(root, '.local-data') + path.sep;
    if (!resolved.startsWith(local) || !path.basename(resolved).startsWith('public-memory-live-')
        || runs.length !== 1 || path.resolve(root, runs[0].workspace) !== resolved) throw new Error('Reliability resume must use the only original workspace');
    const previous = JSON.parse(await readFile(path.join(resolved, 'progress.json')));
    if (previous.outputTag !== tag || previous.split !== 'development' || previous.model !== args.model
        || previous.datasetSha256 !== args.datasetSha256 || !equal(previous.budgetRegistration, evidence.budgetRegistration)
        || previous.priorRun || previous.priorBudgetLedger || previous.budgetAuthorization
        || previous.limits?.requests !== limits.requests || previous.limits?.observedTotalTokens !== limits.observedTotalTokens) {
      throw new Error('Reliability resume cannot change its registration, identity or budget');
    }
  }
  return { ...evidence, ledger: null, limits, registeredLimits: qaReliabilityLimits, attempt: 1 };
}

export async function verifyStructuredPreLive(root, { productionSha256, binarySha256, evaluationSha256, diagnosticArm, registration, before = new Date().toISOString() }) {
  const bytes = await readFile(path.resolve(root, qaReliabilityPreLiveFile)), evidence = JSON.parse(bytes);
  const registered = await loadQaReliabilityRegistration(root, before);
  if (!equal(registered.registration, registration) || diagnosticArm
      || evidence.version !== 'memory-qa-reliability-pre-live-v1' || evidence.passed !== true
      || !Array.isArray(evidence.commands) || !evidence.commands.length || evidence.commands.some(c => c.exitCode !== 0)
      || !validDate(evidence.startedAt) || !validDate(evidence.finishedAt)
      || Date.parse(evidence.startedAt) < Date.parse(registration.registeredAt)
      || Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt) || Date.parse(evidence.finishedAt) > Date.parse(before)
      || evidence.registrationSha256 !== registered.budgetRegistration.sha256
      || !equal(productionSha256, registration.productionSha256) || binarySha256 !== registration.binarySha256
      || !equal(evidence.productionSha256, productionSha256) || evidence.binarySha256 !== binarySha256
      || !equal(evidence.evaluationSha256, evaluationSha256)) throw new Error('Reliability pre-live tests or frozen execution fingerprints do not match');
  return { file: qaReliabilityPreLiveFile, sha256: budgetHash(bytes), finishedAt: evidence.finishedAt,
    commands: evidence.commands.length, executedSource: 'registered-production-and-passing-reliability-tests' };
}

export async function verifyQaReliabilityRecordedBudget(root, report) {
  const evidence = await loadQaReliabilityRegistration(root, report.startedAt);
  const limits = assertQaReliabilityRun({ split: report.split, currentTag: report.outputTag,
    maxRequests: report.limits?.requests, maxTokens: report.limits?.observedTotalTokens }, evidence.registration);
  if (report.priorRun || report.priorBudgetLedger || report.budgetAuthorization || report.diagnostic || report.paragraphControl
      || report.model !== evidence.registration.model || report.datasetSha256 !== evidence.registration.datasetSha256
      || !equal(report.budgetRegistration, evidence.budgetRegistration)
      || !equal(report.productionSha256, evidence.registration.productionSha256) || report.binarySha256 !== evidence.registration.binarySha256
      || report.baseline?.file?.replaceAll('\\', '/') !== baselineFile
      || report.receipts.length > limits.requests || !safeCount(report.usage?.total_tokens) || report.usage.total_tokens > limits.observedTotalTokens) {
    throw new Error('Reliability recorded run changed identity, evidence or exceeded its independent budget');
  }
  const tokens = report.receipts.reduce((sum, receipt) => {
    if (!safeCount(receipt.usage?.total_tokens)) throw new Error('Reliability recorded usage is incomplete');
    return sum + receipt.usage.total_tokens;
  }, 0);
  if (tokens !== report.usage.total_tokens) throw new Error('Reliability recorded token total differs from receipts');
  return { ...evidence, ledger: null, registeredLimits: qaReliabilityLimits, limits, attempt: 1 };
}
