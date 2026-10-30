const layers = new Set(['durable', 'working', 'clarify', 'archive']);
export function scoreChatRetention(data) {
  if (!Array.isArray(data.facts)) throw new Error('facts must contain the complete human fact inventory, including missed facts');
  const ids = new Set();
  let labelled = 0, correctLayer = 0, required = 0, kept = 0, wronglyKept = 0, archive = 0;
  const checks = { supportCorrect: [0, 0], conditionsComplete: [0, 0], replacementCorrect: [0, 0] };
  const confusion = {};
  for (const fact of data.facts) {
    if (!fact.id || ids.has(fact.id)) throw new Error('Every fact needs a unique id');
    ids.add(fact.id);
    if (fact.expectedLayer == null) continue;
    if (!layers.has(fact.expectedLayer) || (fact.observedLayer !== 'missing' && !layers.has(fact.observedLayer))) throw new Error(`Invalid layer for ${fact.id}`);
    labelled++;
    if (fact.expectedLayer === fact.observedLayer) correctLayer++;
    const key = `${fact.expectedLayer} → ${fact.observedLayer}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    if (fact.expectedLayer !== 'archive') {
      required++;
      if (['durable', 'working', 'clarify'].includes(fact.observedLayer)) kept++;
    } else {
      archive++;
      if (['durable', 'working', 'clarify'].includes(fact.observedLayer)) wronglyKept++;
    }
    for (const key of Object.keys(checks)) {
      if (fact[key] == null) continue;
      if (typeof fact[key] !== 'boolean') throw new Error(`${key} must be boolean or null`);
      checks[key][1]++;
      if (fact[key]) checks[key][0]++;
    }
  }
  const ratio = (a, b) => b ? a / b : null;
  const complete = data.inventoryComplete === true && labelled === data.facts.length;
  const cost = {};
  for (const key of ['messageCount', 'modelCalls', 'tokens', 'reviewCount']) {
    const value = data[key];
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${key} must be a nonnegative integer`);
    cost[key] = value ?? null;
  }
  return {
    inventoryComplete: complete, facts: data.facts.length, labelled, unlabelled: data.facts.length - labelled,
    layerAccuracy: ratio(correctLayer, labelled),
    requiredInformationRecall: complete ? ratio(kept, required) : null,
    unnecessaryRetentionRate: complete ? ratio(wronglyKept, archive) : null,
    ...Object.fromEntries(Object.entries(checks).map(([key, [yes, total]]) => [key, { reviewed: total, rate: ratio(yes, total) }])),
    confusion, ...cost,
    callsPerThousandMessages: cost.modelCalls != null && cost.messageCount > 0 ? 1000 * cost.modelCalls / cost.messageCount : null,
    reviewsPerThousandMessages: cost.reviewCount != null && cost.messageCount > 0 ? 1000 * cost.reviewCount / cost.messageCount : null,
  };
}
