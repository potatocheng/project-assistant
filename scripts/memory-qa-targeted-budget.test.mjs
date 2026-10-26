import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { qaTargetedBudgetState, assertQaTargetedPriorCoverage, assertQaTargetedTag, loadQaTargetedRegistration } from './memory-qa-targeted-budget.mjs';
const registration = { limits: { development: { maxRequests: 1200, maxTokens: 6000000, maxFreshAttempts: 4 }, full: { maxRequests: 2000, maxTokens: 12000000 } } };
const ledger = { entries: [{ outputTag: 'qa-targeted-dev' }, { outputTag: 'qa-targeted-dev-v2' }], requests: 560, totalTokens: 2400000 };
test('targeted budget deducts every prior attempt and keeps full separate', () => {
  const state = qaTargetedBudgetState(registration, { split: 'development', ledger, maxRequests: 1200, maxTokens: 6000000 });
  assert.deepEqual(state.limits, { requests: 640, observedTotalTokens: 3600000 }); assert.equal(state.attempt, 3);
  assert.deepEqual(qaTargetedBudgetState(registration, { split: 'all', maxRequests: 2000, maxTokens: 12000000 }).limits, { requests: 2000, observedTotalTokens: 12000000 });
  assert.throws(() => qaTargetedBudgetState(registration, { split: 'all', ledger, maxRequests: 2000, maxTokens: 12000000 }), /separate/);
});
test('four fresh attempts and registered limits cannot be reset or extended', () => {
  assert.throws(() => qaTargetedBudgetState(registration, { split: 'development', ledger: { ...ledger, entries: [1,2,3,4] }, maxRequests: 1200, maxTokens: 6000000 }), /four/);
  assert.throws(() => qaTargetedBudgetState(registration, { split: 'development', maxRequests: 1201, maxTokens: 6000000 }), /exceeds/);
  const changed = structuredClone(registration); changed.limits.development.maxTokens++;
  assert.throws(() => qaTargetedBudgetState(changed, { split: 'development', maxRequests: 1200, maxTokens: 6000000 }), /cannot be extended/);
});
test('a fresh tag cannot silently forget an existing current-round pilot', () => {
  assert.doesNotThrow(() => assertQaTargetedPriorCoverage(ledger, ['qa-targeted-dev', 'qa-targeted-dev-v2'], 'qa-targeted-dev-v3'));
  assert.throws(() => assertQaTargetedPriorCoverage(null, ['qa-targeted-dev'], 'qa-targeted-dev-v2'), /omitted/);
  assert.doesNotThrow(() => assertQaTargetedPriorCoverage(null, ['qa-targeted-dev'], 'qa-targeted-dev'));
});
test('round tags cannot bypass developer-attempt accounting or start a second fresh full budget',()=>{
  assert.doesNotThrow(()=>assertQaTargetedTag('development','qa-targeted-dev-v4'));assert.doesNotThrow(()=>assertQaTargetedTag('all','qa-targeted-full'));
  assert.throws(()=>assertQaTargetedTag('development','qa-targeted-untracked'),/tags/);assert.throws(()=>assertQaTargetedTag('all','qa-targeted-full-v2'),/tags/);
});
test('immutable targeted registration binds all three historical receipt ledgers and failed gates', async () => {
  const value = await loadQaTargetedRegistration(path.resolve(import.meta.dirname, '..'));
  assert.equal(value.historical.requests, 829); assert.equal(value.historical.totalTokens, 3652548);
  assert.equal(value.historical.entries.length, 3); assert.equal(value.registration.thresholds.desktopComplete, 14);
  assert.equal(value.registration.baselineDevelopment.original.combinedQaTokens, 333357);
  assert.equal(value.registration.costReferenceDevelopment.combinedQaTokens, 262191);
});
