// Usage: node scripts/benchmarks/summarize-locomo.mjs <report.json> ...
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function metrics(cases) {
  let anyAt1 = 0;
  let anyAt5 = 0;
  let allAt5 = 0;
  let recall = 0;
  for (const { gold, selected } of cases) {
    assert.ok(gold.length > 0);
    const top = new Set(selected.slice(0, 5));
    const hits = gold.filter(id => top.has(id)).length;
    anyAt1 += Number(gold.includes(selected[0]));
    anyAt5 += Number(hits > 0);
    allAt5 += Number(hits === gold.length);
    recall += hits / gold.length;
  }
  return { questions: cases.length, anyAt1, anyAt5, allAt5, meanRecallAt5: recall / cases.length };
}

const files = process.argv.slice(2);
assert.ok(files.length, 'Pass at least one LoCoMo report');
const results = {};
let reference;
for (const file of files) {
  const { datasetSha256, cases } = JSON.parse(await readFile(file, 'utf8'));
  const inputs = { datasetSha256, cases: cases.map(({ project, index, category, split, gold }) =>
    ({ project, index, category, split, gold })) };
  if (reference) assert.deepEqual(inputs, reference, 'Reports must contain identical evaluation cases');
  else reference = inputs;
  results[file] = {};
  for (const split of ['development', 'holdout']) {
    const rows = cases.filter(item => item.split === split);
    assert.ok(rows.length);
    results[file][split] = metrics(rows);
  }
}
console.log(JSON.stringify(results, null, 2));
