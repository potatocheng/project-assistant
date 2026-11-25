// Materialize the production context using the real configured-model selector.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { selectHabitsForTurn, renderSystemPrompt, serializeContextForProxy } from '../../src/components/shell/pi-copilot-agent.ts';
import { openEvaluationHost } from './copilot-evaluation-host.mjs';

const [profilePath, originalPath, outputPath, tracePath, endpoint, model, embeddingUrl, embeddingModel] = process.argv.slice(2);
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const [profiles, originals] = await Promise.all([read(profilePath), read(originalPath)]);
assert.equal(profiles.length, originals.length);
const host = await openEvaluationHost(endpoint, model, embeddingUrl, embeddingModel);
const requests = [], trace = [];
try {
  for (const [i, { topic, index, question, habits }] of profiles.entries()) {
    const original = originals[i];
    assert.deepEqual([topic, index], [original.topic, original.index]);
    let selectorResult = null, error = null;
    const start = performance.now();
    const {evidence, focus} = await selectHabitsForTurn(habits, '', '工作台', question, async (command, payload) => {
      try { selectorResult = await host.call(command, payload); return selectorResult; }
      catch (e) { error = e.message; throw e; }
    });
    const content = renderSystemPrompt({ projects: [] }, '', '2026-10-20', '工作台', null, [], evidence, focus);
    const user = {role:'user',content:[{type:'text',text:original.messages[1].content}],timestamp:0};
    const wire = serializeContextForProxy({systemPrompt:content,messages:[user]});
    requests.push({ ...original, messages: wire.messages });
    trace.push({ topic, index, selected: evidence.map(h => h.id), focus:focus.map(h => h.id), selectorResult, error,
      durationMs: Math.round(performance.now()-start) });
  }
} finally {
  await host.close();
}
await writeFile(outputPath, JSON.stringify(requests), { flag: 'wx' });
await writeFile(tracePath, JSON.stringify(trace, null, 2), { flag: 'wx' });
console.log('Prepared', requests.length, 'paired model inputs.');
