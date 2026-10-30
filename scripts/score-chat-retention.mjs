// Scores human annotations. No model calls or private data discovery.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {scoreChatRetention} from '../src/quality/score.mjs';
export {scoreChatRetention};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error('Usage: node scripts/score-chat-retention.mjs annotations.json [scores.json]');
  const report = JSON.stringify(scoreChatRetention(JSON.parse(await readFile(input, 'utf8'))), null, 2) + '\n';
  if (output) await writeFile(output, report);
  else process.stdout.write(report);
}
