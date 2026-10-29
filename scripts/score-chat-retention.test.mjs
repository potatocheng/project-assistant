import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreChatRetention } from './score-chat-retention.mjs';

test('unlabelled or prediction-only inventories cannot claim recall', () => {
  const report = scoreChatRetention({ facts: [{ id: 'one', expectedLayer: 'durable', observedLayer: 'durable' }, { id: 'two', expectedLayer: null }] });
  assert.equal(report.requiredInformationRecall, null);
  assert.equal(report.unlabelled, 1);
  assert.equal(report.supportCorrect.rate, null);
  assert.equal(report.callsPerThousandMessages, null);
});
test('missed information, noise and wrong layers are counted separately', () => {
  const report = scoreChatRetention({ inventoryComplete: true, messageCount: 200, modelCalls: 3, reviewCount: 2, facts: [
    { id: 'miss', expectedLayer: 'durable', observedLayer: 'missing' },
    { id: 'working', expectedLayer: 'working', observedLayer: 'durable', supportCorrect: true, conditionsComplete: false },
    { id: 'noise', expectedLayer: 'archive', observedLayer: 'durable', replacementCorrect: false },
  ] });
  assert.equal(report.requiredInformationRecall, 0.5);
  assert.equal(report.unnecessaryRetentionRate, 1);
  assert.equal(report.layerAccuracy, 0);
  assert.equal(report.conditionsComplete.rate, 0);
  assert.equal(report.callsPerThousandMessages, 15);
  assert.equal(report.reviewsPerThousandMessages, 10);
});
test('invalid labels and duplicate observations fail instead of inflating scores', () => {
  assert.throws(() => scoreChatRetention({ facts: [{ id: 'one' }, { id: 'one' }] }));
  assert.throws(() => scoreChatRetention({ facts: [{ id: 'one', expectedLayer: 'durable', observedLayer: null }] }));
});
