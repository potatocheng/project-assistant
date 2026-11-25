// Score the public work-topic MCQs with a local llama.cpp server.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [input, output, endpoint] = process.argv.slice(2);
const url = new URL('/v1/chat/completions', endpoint);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
const cases = [];
for (const { topic, index, expected, messages } of JSON.parse(await readFile(input))) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0, seed: 42, max_tokens: 4, grammar: 'root ::= [ABCD]' }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(await response.text());
  const reply = await response.json();
  const predicted = reply.choices[0].message.content.trim();
  assert.match(predicted, /^[ABCD]$/);
  cases.push({ topic, index, expected, predicted, correct: predicted === expected, model: reply.model });
}
const correct = cases.filter(item => item.correct).length;
await writeFile(output, JSON.stringify({ correct, total: cases.length, cases }, null, 2), { flag: 'wx' });
console.log(`${correct}/${cases.length}`);
