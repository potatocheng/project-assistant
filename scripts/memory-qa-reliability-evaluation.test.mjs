import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  qaReliabilityRegistrationFile, qaReliabilityPreLiveFile, qaReliabilityLimits,
  qaStructuredEvaluationFiles, assertQaReliabilityRun, loadQaReliabilityRegistration,
  prepareQaStructuredBudget, verifyStructuredPreLive, verifyQaReliabilityRecordedBudget,
} from './memory-qa-reliability-evaluation.mjs';
import { budgetHash } from './memory-public-live-budget.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hash = text => budgetHash(text);
async function put(directory, file, value) {
  await mkdir(path.dirname(path.resolve(directory, file)), { recursive: true });
  const bytes = JSON.stringify(value);
  await writeFile(path.resolve(directory, file), bytes);
  return hash(bytes);
}
async function fixture() {
  await mkdir(path.join(root, '.local-data'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.local-data/qa-reliability-unit-'));
  const baseline = { model: 'fixture-model', datasetSha256: hash('fixture'), complete: true, split: 'development' };
  const baselineFile = 'docs/memory-public-live-qa-structured-dev-v3-results.json';
  const baselineSha = await put(directory, baselineFile, baseline);
  const verification = { completedAt: '2026-10-23T05:00:00.000Z', rustPassed: 440, nodePassed: 213,
    clippyPassed: true, buildPassed: true, liveModelRequests: 0,
    sourceSha256: { 'crates/core/src/question_flow.rs': hash('source') }, binarySha256: hash('binary') };
  const existingFile = '.local-data/verification.json';
  const existingSha = await put(directory, existingFile, verification);
  const registration = { version: 'memory-qa-reliability-preregistration-v1', registeredAt: '2026-10-23T06:00:00.000Z',
    datasetSha256: baseline.datasetSha256, model: baseline.model,
    baselineDevelopment: { file: baselineFile, sha256: baselineSha }, limits: { development: qaReliabilityLimits },
    productionSha256: { 'question_flow.rs': hash('source') }, binarySha256: hash('binary'),
    existingVerification: { file: existingFile, sha256: existingSha } };
  await put(directory, qaReliabilityRegistrationFile, registration);
  const args = { split: 'development', currentTag: 'qa-reliability-dev', model: baseline.model, datasetSha256: baseline.datasetSha256,
    before: '2026-10-23T07:00:00.000Z', maxRequests: 400, maxTokens: 2_000_000 };
  return { directory, registration, args, baseline };
}

test('reliability permits one named development run with independent unchanged limits', () => {
  const registration = { limits: { development: qaReliabilityLimits } };
  const valid = { split: 'development', currentTag: 'qa-reliability-dev', maxRequests: 400, maxTokens: 2_000_000 };
  assert.deepEqual(assertQaReliabilityRun(valid, registration), { requests: 400, observedTotalTokens: 2_000_000 });
  for (const override of [{ split: 'all' }, { currentTag: 'qa-reliability-dev-v2' }, { currentTag: 'qa-structured-dev-v4' },
    { priorFile: 'old-result.json' }, { maxRequests: 401 }, { maxTokens: 2_000_001 }, { maxRequests: 0 }]) {
    assert.throws(() => assertQaReliabilityRun({ ...valid, ...override }, registration));
  }
  assert.throws(() => assertQaReliabilityRun(valid, { limits: { development: { ...qaReliabilityLimits, maxFreshAttempts: 2 } } }));
});

test('reliability registration binds original baseline and verified production hashes', async () => {
  const { directory, registration, args, baseline } = await fixture();
  const checked = await loadQaReliabilityRegistration(directory, args.before);
  assert.equal(checked.registration.binarySha256, registration.binarySha256);
  await assert.rejects(loadQaReliabilityRegistration(directory, '2026-10-23T05:00:00.000Z'), /precede/);
  await put(directory, registration.baselineDevelopment.file, { ...baseline, model: 'changed' });
  await assert.rejects(loadQaReliabilityRegistration(directory, args.before), /baseline changed/);
});

test('another fresh attempt is forbidden and resume binds original workspace and budget', async () => {
  const { directory, registration, args } = await fixture();
  const first = await prepareQaStructuredBudget(directory, args);
  const workspace = '.local-data/public-memory-live-original';
  const progress = { outputTag: args.currentTag, split: args.split, workspace, model: args.model, datasetSha256: args.datasetSha256,
    startedAt: args.before, budgetRegistration: first.budgetRegistration, limits: first.limits, receipts: [] };
  await put(directory, `${workspace}/progress.json`, progress);
  await assert.rejects(prepareQaStructuredBudget(directory, args), /already exists/);
  const resumed = await prepareQaStructuredBudget(directory, { ...args, resumeRoot: path.resolve(directory, workspace) });
  assert.equal(resumed.attempt, 1); assert.equal(resumed.ledger, null);
  await assert.rejects(prepareQaStructuredBudget(directory, { ...args, resumeRoot: path.resolve(directory, '.local-data/public-memory-live-other') }), /only original/);
  await assert.rejects(prepareQaStructuredBudget(directory, { ...args, maxRequests: 399, resumeRoot: path.resolve(directory, workspace) }), /cannot change/);
  await put(directory, `${workspace}/progress.json`, { ...progress, budgetRegistration: { ...first.budgetRegistration, sha256: hash('forged') } });
  await assert.rejects(prepareQaStructuredBudget(directory, { ...args, resumeRoot: path.resolve(directory, workspace) }), /cannot change/);
  assert.equal(registration.limits.development.maxFreshAttempts, 1);
});

test('pre-live evidence binds later successful harness tests and exact source binary evaluation', async () => {
  const { directory, registration, args } = await fixture();
  const loaded = await loadQaReliabilityRegistration(directory, args.before);
  const evaluationSha256 = { 'scripts/memory-qa-reliability-evaluation.mjs': hash('harness') };
  const evidence = { version: 'memory-qa-reliability-pre-live-v1', passed: true,
    startedAt: '2026-10-23T06:01:00.000Z', finishedAt: '2026-10-23T06:02:00.000Z',
    commands: [{ command: 'node --test scripts/memory-qa-reliability-evaluation.test.mjs scripts/report-memory-qa-reliability.test.mjs', exitCode: 0 }],
    registrationSha256: loaded.budgetRegistration.sha256, productionSha256: registration.productionSha256,
    binarySha256: registration.binarySha256, evaluationSha256 };
  const input = { productionSha256: registration.productionSha256, binarySha256: registration.binarySha256,
    evaluationSha256, registration, before: args.before };
  await put(directory, qaReliabilityPreLiveFile, evidence);
  assert.equal((await verifyStructuredPreLive(directory, input)).commands, 1);
  for (const override of [{ binarySha256: hash('changed') }, { evaluationSha256: {} }, { productionSha256: {} }, { diagnosticArm: 'baseline' }]) {
    await assert.rejects(verifyStructuredPreLive(directory, { ...input, ...override }), /do not match/);
  }
  for (const override of [{ passed: false }, { commands: [{ command: 'node --test', exitCode: 1 }] },
    { startedAt: '2026-10-23T05:00:00.000Z' }, { finishedAt: '2026-10-23T08:00:00.000Z' }, { registrationSha256: hash('changed') }]) {
    await put(directory, qaReliabilityPreLiveFile, { ...evidence, ...override });
    await assert.rejects(verifyStructuredPreLive(directory, input), /do not match/);
  }
});

test('recorded budget preserves failure costs and cannot import historical runs or inflate limits', async () => {
  const { directory, registration, args } = await fixture();
  const loaded = await prepareQaStructuredBudget(directory, args);
  const report = { outputTag: args.currentTag, split: args.split, startedAt: args.before, model: args.model,
    datasetSha256: args.datasetSha256, productionSha256: registration.productionSha256, binarySha256: registration.binarySha256,
    budgetRegistration: loaded.budgetRegistration, limits: loaded.limits, baseline: { file: registration.baselineDevelopment.file },
    receipts: [{ status: 200, usage: { total_tokens: 100 } }, { error: 'content failure', usage: { total_tokens: 250 } }],
    usage: { total_tokens: 350 } };
  assert.equal((await verifyQaReliabilityRecordedBudget(directory, report)).attempt, 1);
  for (const override of [{ priorRun: {} }, { priorBudgetLedger: {} }, { diagnostic: {} },
    { usage: { total_tokens: 349 } }, { receipts: [{ usage: null }] },
    { limits: { requests: 401, observedTotalTokens: 2_000_000 } }, { binarySha256: hash('changed') }]) {
    await assert.rejects(verifyQaReliabilityRecordedBudget(directory, { ...report, ...override }));
  }
});

test('reliability fingerprint covers new harness checks and shared grading without generated-output cycles', () => {
  for (const name of ['scripts/evaluate-memory-qa-reliability-live.mjs', 'scripts/memory-qa-reliability-evaluation.test.mjs',
    'scripts/report-memory-qa-reliability.mjs', 'scripts/report-memory-qa-reliability.test.mjs',
    'scripts/verify-memory-qa-reliability-results.mjs', 'scripts/memory-qa-structured-judges.mjs', qaReliabilityRegistrationFile]) {
    assert.ok(qaStructuredEvaluationFiles.includes(name), name);
  }
  assert.equal(new Set(qaStructuredEvaluationFiles).size, qaStructuredEvaluationFiles.length);
  assert.ok(!qaStructuredEvaluationFiles.includes(qaReliabilityPreLiveFile));
  assert.ok(!qaStructuredEvaluationFiles.some(file => /-(?:report\.md|metrics\.json|results\.json)$/.test(file)));
});

test('isolated runner preserves the original production and anonymous judge execution loop', async () => {
  const source = await readFile(path.join(root, 'scripts/evaluate-memory-qa-structured-live.mjs'), 'utf8');
  const expected = source.replaceAll("from './memory-qa-structured-evaluation-files.mjs'", "from './memory-qa-reliability-evaluation.mjs'")
    .replaceAll("from './memory-qa-structured-pre-live.mjs'", "from './memory-qa-reliability-evaluation.mjs'")
    .replaceAll("from './memory-qa-structured-budget.mjs'", "from './memory-qa-reliability-evaluation.mjs'")
    .replaceAll('currentTag: currentRoundTag,', 'currentTag: currentRoundTag, resumeRoot: evidenceResumeRoot,')
    .replaceAll("'qa-structured-", "'qa-reliability-").replaceAll("name: 'qa-structured'", "name: 'qa-reliability'")
    .replaceAll('Dedicated structured harness accepts only qa-structured tags', 'Dedicated reliability harness accepts only qa-reliability tags');
  assert.equal(await readFile(path.join(root, 'scripts/evaluate-memory-qa-reliability-live.mjs'), 'utf8'), expected);
});
