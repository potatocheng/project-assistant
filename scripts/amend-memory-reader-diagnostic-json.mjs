// A post-run syntactic amendment. Never edits raw outputs, answers or the registered evaluator.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, parseJudge, ALL_ARMS } from './memory-reader-diagnostic.mjs';

export function appendOnlyMissingFinalBrace(text, order, finishReason) {
  if (finishReason !== 'stop' || typeof text !== 'string' || !text.trimEnd().endsWith('}')) throw new Error('Not an eligible completed JSON object');
  try { JSON.parse(text); throw new Error('Original JSON is valid; no amendment permitted'); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const amended = text + '}';
  const grades = parseJudge(amended, order);
  // All grade strings and reasons remain byte-for-byte in the provider output.
  return { grades, amended, originalSha256: hash(text), amendedSha256: hash(amended), appended: '}' };
}

export async function amend(root) {
  const originalFile = path.join(root, 'docs/memory-reader-diagnostic-results.json');
  const originalBytes = await readFile(originalFile), original = JSON.parse(originalBytes);
  const registrationFile = path.join(root, 'docs/memory-reader-diagnostic-preregistration.json');
  const registration = JSON.parse(await readFile(registrationFile));
  if (original.complete || original.usage.requests !== 100 || original.integrity.frozenFilesUnchanged !== true) throw new Error('Expected completed requests with a protocol-only failure');
  const receiptsFile = path.join(root, original.workspace, 'receipts.jsonl'), receiptBytes = await readFile(receiptsFile);
  if (hash(receiptBytes) !== original.integrity.receiptsSha256) throw new Error('Raw receipts changed');
  const receipts = receiptBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  const failing = original.cases.filter(c => c.error);
  if (failing.length !== 1 || failing[0].id !== '747b847d687f703cc20a87877c5b138f26ff137d') throw new Error('Unexpected missing judge; amendment is limited to the observed one');
  const result = structuredClone(original), changes = [];
  for (const c of failing) {
    const receipt = receipts.find(r => r.id === `${c.id}:judge`);
    const provider = JSON.parse(receipt.responseText), text = provider.choices[0].message.content;
    const repaired = appendOnlyMissingFinalBrace(text, c.anonymousOrder, provider.choices[0].finish_reason);
    const amended = result.cases.find(row => row.id === c.id);
    amended.grades = repaired.grades;
    amended.originalProtocolError = amended.error;
    delete amended.error;
    changes.push({ questionId: c.id, receiptIndex: receipt.index, originalError: c.error, kind: 'append-single-final-object-brace',
      originalContentSha256: repaired.originalSha256, amendedContentSha256: repaired.amendedSha256, appended: repaired.appended,
      semanticFieldsChanged: 0, modelRequests: 0 });
  }
  for (const arm of ALL_ARMS) {
    const grades = result.cases.filter(c => c.answerable).map(c => c.grades?.[arm]?.answerCorrect);
    Object.assign(result.arms[arm], { completeCorrect: grades.filter(g => g === 'yes').length,
      partial: grades.filter(g => g === 'partial').length, incorrect: grades.filter(g => g === 'no').length,
      uncertainOrMissing: grades.filter(g => !g || g === 'uncertain').length,
      unanswerableCorrect: result.cases.filter(c => !c.answerable && c.grades?.[arm]?.answerCorrect === 'yes').length });
  }
  result.complete = result.cases.every(c => !c.error && ALL_ARMS.every(a => c.grades?.[a]));
  result.technicalAmendment = { kind: 'post-run-syntax-only-derived-report', originalFile: path.relative(root, originalFile),
    originalSha256: hash(originalBytes), modelRequests: 0, changes };
  const resultText = JSON.stringify(result, null, 2), outputFile = path.join(root, 'docs/memory-reader-diagnostic-audited-results.json');
  const audit = { version: 'memory-reader-diagnostic-syntax-amendment-v1', recordedAt: new Date().toISOString(),
    source: { file: path.relative(root, originalFile), sha256: hash(originalBytes), complete: original.complete },
    registrationSha256: hash(JSON.stringify(registration)), rawReceiptsSha256: hash(receiptBytes),
    output: { file: path.relative(root, outputFile), sha256: hash(resultText), complete: result.complete }, changes,
    originalArtifactsUnchanged: true, originalAnswersUnchanged: true, newApiRequests: 0,
    note: 'Post-hoc technical correction of one missing terminal object brace. No grades/reasons are invented or modified. The full-document invalid span answer remains a genuine production binding failure.' };
  if (hash(await readFile(originalFile)) !== hash(originalBytes) || hash(await readFile(receiptsFile)) !== hash(receiptBytes)) throw new Error('Original artifact changed during amendment');
  await writeFile(outputFile, resultText, { flag: 'wx' });
  await writeFile(path.join(root, 'docs/memory-reader-diagnostic-technical-amendment.json'), JSON.stringify(audit, null, 2), { flag: 'wx' });
  return { complete: result.complete, arms: result.arms, usage: result.usage, requests: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await amend(path.resolve(import.meta.dirname, '..'))));
