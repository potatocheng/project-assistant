// Evaluate the preference list actually included in Cadence's Copilot prompt.
// Usage: node scripts/benchmark-prefeval.mjs <benchmark_dataset> <new-report.json>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const agentModule = process.env.PREFEVAL_AGENT_MODULE
  ? pathToFileURL(path.resolve(process.env.PREFEVAL_AGENT_MODULE)).href
  : '../src/components/shell/pi-copilot-agent.ts';
const { buildSystemPrompt } = await import(agentModule);

const [dataset, output] = process.argv.slice(2);
const sha = text => createHash('sha256').update(text).digest('hex');
const dir = path.join(dataset, 'explicit_preference');
const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
assert.equal(files.length, 20);
const topics = [];
const hashes = {};
const mcqOutput = process.env.PREFEVAL_MCQ_INPUT;
const mcqFiles = new Map();
const mcqHashes = {};
for (const file of files) {
  const bytes = await readFile(path.join(dir, file));
  hashes[file] = sha(bytes);
  topics.push(JSON.parse(bytes).map(({ preference, question }, i) => ({
    id: sha(`prefeval-v1/${file}/${i}`), preference, question,
  })));
  if (mcqOutput) {
    const options = await readFile(path.join(dataset, 'mcq_options', file));
    mcqFiles.set(file, JSON.parse(options));
    mcqHashes[file] = sha(options);
  }
}
assert.equal(sha(JSON.stringify(hashes)), '601dbef13239dbcae09dba9d213a31adea49a5749c4e048b4fe4db8dbc7ee5a5',
  'Explicit preferences do not match the pinned PrefEval revision');
if (mcqOutput) assert.equal(sha(JSON.stringify(mcqHashes)),
  'bdd3a2319cd237c0c22a9dd14b6e7f1cf86fe1070a38c4c0349e018bbc33cf6f',
  'Multiple-choice options do not match the pinned PrefEval revision');
const devTopics = new Set([...files].sort((a, b) => sha(a).localeCompare(sha(b))).slice(0, 4));
const cases = [];
const workTopic = 'professional_work_location_style.json';
const mcqSet = process.env.PREFEVAL_MCQ_SET ?? 'work';
assert.ok(['work', 'holdout', 'fresh', 'confirmation', 'roles'].includes(mcqSet));
const contextMode = process.env.PREFEVAL_CONTEXT ?? 'turn';
assert.ok(['turn', 'page'].includes(contextMode));
const questionFor = question => contextMode === 'turn' ? question : '';
const requests = [];
const profiles = [];
for (const [t, topic] of topics.entries()) {
  const includeTopic = mcqSet === 'work' ? files[t] === workTopic : !devTopics.has(files[t]);
  const mcq = includeTopic ? mcqFiles.get(files[t]) : null;
  const sampleIds = (items, salt, count) => new Set(items
    .map(item => [sha(`${salt}/${item.id}`), item.id])
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, count).map(([, id]) => id));
  const previous = sampleIds(topic, 'mcq-holdout-v1', 4);
  const unused = topic.filter(item => !previous.has(item.id));
  const fresh = sampleIds(unused, 'cadence-answer-transfer-v1', 8);
  const confirmation = sampleIds(unused.filter(item => !fresh.has(item.id)), 'cadence-evidence-delivery-v1', 8);
  const roles = sampleIds(unused.filter(item => !fresh.has(item.id) && !confirmation.has(item.id)), 'cadence-separate-history-v1', 6);
  const sample = { work: null, holdout: previous, fresh, confirmation, roles }[mcqSet];
  for (const [i, target] of topic.entries()) {
    // One preference from each topic. Stable IDs randomize tie order independently
    // of relevance. No topic, explanation, question or answer appears in a habit.
    const habits = topics.map((choices, j) => {
      const pick = parseInt(sha(`${target.id}/${j}`).slice(0, 8), 16) % choices.length;
      const item = t === j ? target : choices[pick];
      return {
        id: item.id, projectId: null, category: 'workflow', status: 'active',
        title: '个人偏好', instruction: item.preference, rule: {},
        confidence: 0.9, utilityScore: 0.5, updatedAt: '2026-10-20',
      };
    });
    const prompt = buildSystemPrompt({ projects: [] }, '', '2026-10-20', '工作台',
      null, [], habits, questionFor(target.question));
    const instructions = prompt.split('\n').filter(line => line.startsWith('- [工作流] '))
      .map(line => line.slice('- [工作流] '.length));
    assert.ok(instructions.length <= 12);
    const rank = instructions.indexOf(target.preference) + 1;
    cases.push({ topic: files[t], index: i, split: devTopics.has(files[t]) ? 'development' : 'holdout',
      rank: rank || null });
    if (mcq && (!sample || sample.has(target.id))) {
      const item = mcq[i];
      const mcqHabits = habits.map(h => h.id === target.id ? { ...h, instruction: item.preference } : h);
      const system = buildSystemPrompt({ projects: [] }, '', '2026-10-20', '工作台',
        null, [], mcqHabits, questionFor(item.question));
      const options = item.classification_task_options;
      assert.equal(options.length, 4);
      const order = options.map((_, j) => j).sort((a, b) =>
        sha(`${target.id}/option/${a}`).localeCompare(sha(`${target.id}/option/${b}`)));
      const letters = 'ABCD';
      const question = [item.question, ...order.map((j, k) => `${letters[k]}. ${options[j]}`),
        "Choose the best response for this user. Reply with one letter."].join('\n');
      requests.push({ topic: files[t], index: i, expected: letters[order.indexOf(0)],
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }] });
      if (process.env.PREFEVAL_MCQ_PROFILES) {
        profiles.push({ topic: files[t], index: i, question: item.question, habits: mcqHabits });
      }
    }
  }
}
const summary = {};
for (const split of ['development', 'holdout']) {
  const rows = cases.filter(c => c.split === split);
  summary[split] = { n: rows.length, ...Object.fromEntries([1, 5, 12].map(k =>
    [`hitAt${k}`, rows.filter(c => c.rank !== null && c.rank <= k).length])) };
}
await writeFile(output, JSON.stringify({ datasetRevision: '50795054b5ff5f418d2b768a331d71e480f93331', contextMode,
  hashes, candidates: topics.length, summary, cases }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(summary));
if (mcqOutput) {
  assert.equal(requests.length, { work: 36, holdout: 64, fresh: 128, confirmation: 128, roles: 96 }[mcqSet]);
  await writeFile(mcqOutput, JSON.stringify(requests), { flag: 'wx' });
  if (process.env.PREFEVAL_MCQ_PROFILES) {
    await writeFile(process.env.PREFEVAL_MCQ_PROFILES, JSON.stringify(profiles), { flag: 'wx' });
  }
}
