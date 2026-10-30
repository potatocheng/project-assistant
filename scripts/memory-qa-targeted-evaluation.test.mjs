import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { evaluationRoundForTag } from './memory-evaluation-round.mjs';
import { qaTargetedEvaluationFiles, fingerprintQaTargetedEvaluation } from './memory-qa-targeted-evaluation-files.mjs';
import { publicLiveOptions } from './memory-public-live-options.mjs';
import { buildPriorRunLedger } from './memory-public-live-budget.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('new targeted tag selects its own complete manifest without changing historical round dispatch',async()=>{
  for(const[tag,name]of[['qa-targeted-dev','qa-targeted'],['qa-calibrated-dev-v3','qa-calibrated'],['qa-efficient-full','qa-efficient'],['retrieval-full','retrieval']])assert.equal(evaluationRoundForTag(tag).name,name);
  const hashes=await fingerprintQaTargetedEvaluation(root);assert.equal(Object.keys(hashes).length,qaTargetedEvaluationFiles.length);
  for(const file of ['scripts/memory-qa-targeted-capture.mjs','scripts/memory-qa-targeted-budget.mjs','docs/memory-qa-targeted-preregistration.json'])assert.match(hashes[file],/^[a-f0-9]{64}$/);
});
test('quality, recovery-cost and full references are deliberately distinct immutable artifacts',async()=>{
  const r=JSON.parse(await readFile(path.join(root,'docs/memory-qa-targeted-preregistration.json')));
  assert.match(r.baselineDevelopment.file,/qa-calibrated-dev-v3/);assert.match(r.costReferenceDevelopment.file,/qa-efficient-dev-v2/);assert.match(r.baselineFull.file,/qa-efficient-full/);
  assert.equal(r.baselineDevelopment.original.combinedQaTokens,333357);assert.equal(r.costReferenceDevelopment.combinedQaTokens,262191);
  assert.deepEqual(r.limits.development,{maxRequests:1200,maxTokens:6000000,maxFreshAttempts:4});
});
test('new CLI budget uses existing validated options and does not add request retry knobs',()=>{
  const r=publicLiveOptions(['--output-tag','qa-targeted-dev','--split','development','--judge-mode','separated','--max-requests','1200','--max-tokens','6000000'],root);
  assert.equal(r.maxRequests,1200);assert.equal(r.maxTokens,6000000);assert.equal(r.judges,'separated');
});
test('old calibrated expenses cannot enter a new targeted prior-run chain',async()=>{
  await assert.rejects(buildPriorRunLedger(root,'docs/memory-public-live-qa-calibrated-dev-v3-results.json',{tagPrefix:'qa-targeted-dev',split:'development'}),/round mismatch/);
});
