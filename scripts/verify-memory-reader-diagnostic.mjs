// Offline verification only. Writes its own replay files and integrity report;
// never changes registered inputs, receipts, answers, or historical results.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { capturedEvaluationReferences } from './capture-memory-evaluation-references.mjs';
import {
  ARMS, ALL_ARMS, LIMITS, hash, prepareCases, buildJobs, modelBody, buildJudge,
  parseJudge, requestReservation, validateUsage,
} from './memory-reader-diagnostic.mjs';

const root = path.resolve(import.meta.dirname, '..');
const registrationFile = 'docs/memory-reader-diagnostic-preregistration.json';
const summaryFile = 'docs/memory-reader-diagnostic-results.json';
const baselineFile = 'docs/memory-architecture-dev-v2-audited-results.json';
const integrityFile = 'docs/memory-reader-diagnostic-integrity.json';
const auditedFile = 'docs/memory-reader-diagnostic-audited-results.json';
const amendmentFile = 'docs/memory-reader-diagnostic-technical-amendment.json';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const canonical = value => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, message) => assert.deepEqual(canonical(actual), canonical(expected), message);
const digest = value => hash(JSON.stringify(value));

export function assertReaderHasNoLabels(value) {
  const forbidden = new Set(['expectedAnswers', 'humanAnswers', 'goldParagraphs', 'humanEvidenceAlternatives',
    'acceptableEvidenceSets', 'answerCorrect', 'answerable', 'historicalGrades', 'annotatedPolicy', 'historical']);
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!forbidden.has(key), `Reader contains evaluation-only field: ${key}`);
    assertReaderHasNoLabels(nested);
  }
}

export function verifyReceiptInventory(receipts, calls, cases) {
  assert.equal(calls.length, 80, 'Expected 80 registered reader requests');
  assert.equal(cases.length, 20, 'Expected 20 questions');
  assert.equal(receipts.length, 100, 'Run is incomplete: expected exactly 100 receipts');
  assert.equal(new Set(receipts.map(r => r.id)).size, 100, 'Duplicate request ID');
  assert.equal(new Set(calls.map(c => c.id)).size, 80, 'Duplicate reader job ID');
  let totalTokens = 0;
  const phases = { reader: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    judge: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  for (const [index, receipt] of receipts.entries()) {
    const phase = index < 80 ? 'reader' : 'judge';
    const id = index < 80 ? calls[index].id : `${cases[index - 80].id}:judge`;
    assert.equal(receipt.index, index + 1, 'Receipt sequence mismatch');
    assert.equal(receipt.id, id, 'Receipt task order mismatch');
    assert.equal(receipt.phase, phase, 'Receipt phase mismatch');
    assert.ok(!receipt.error, 'Failed provider call');
    assert.ok(Number.isInteger(receipt.status) && receipt.status >= 200 && receipt.status < 300, 'Provider HTTP failure');
    assert.equal(receipt.requestSha256, digest(receipt.request), 'Receipt request hash mismatch');
    assert.equal(receipt.request.model, 'deepseek-flash', 'Unexpected requested model');
    assert.equal(receipt.request.max_tokens, 4096, 'Output allowance changed');
    assert.equal(receipt.reservation, requestReservation(receipt.request), 'Receipt reservation mismatch');
    assert.ok(totalTokens + receipt.reservation <= 1600000, 'Pre-dispatch budget would have been exceeded');
    const provider = JSON.parse(receipt.responseText);
    const usage = validateUsage(provider, receipt.reservation);
    equal(receipt.usage, usage, 'Receipt usage differs from provider response');
    assert.equal(receipt.actualModel, provider.model, 'Actual model metadata mismatch');
    assert.ok(typeof provider.model === 'string' && provider.model.length > 0, 'Missing provider model');
    assert.equal(receipt.finishReason, provider.choices[0].finish_reason, 'Finish metadata mismatch');
    assert.equal(typeof provider.choices[0].message.content, 'string', 'Missing raw model output');
    if (phase === 'reader') equal(receipt.request, calls[index].body, 'Dispatched reader differs from frozen request');
    phases[phase].requests++;
    phases[phase].inputTokens += usage.prompt_tokens;
    phases[phase].outputTokens += usage.completion_tokens;
    phases[phase].totalTokens += usage.total_tokens;
    totalTokens += usage.total_tokens;
  }
  assert.equal(phases.reader.requests, 80);
  assert.equal(phases.judge.requests, 20);
  assert.ok(totalTokens <= 1600000);
  return { requests: 100, totalTokens, readerTokens: phases.reader.totalTokens, judgeTokens: phases.judge.totalTokens, phases };
}

async function replay(runRoot, mode, jobs) {
  const input = path.join(runRoot, `${mode}-input.json`), output = path.join(runRoot, `${mode}-output.json`);
  await writeFile(input, JSON.stringify({ mode, jobs }, null, 2), { flag: 'wx' });
  const cargo = process.platform === 'win32' ? path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo';
  await new Promise((resolve, reject) => {
    const child = spawn(cargo, ['test', '--locked', '--offline', '-p', 'project-assistant-core', '--lib',
      'memory_evaluation::evidence_reader_diagnostic_bridge', '--', '--ignored', '--exact'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MEMORY_READER_DIAGNOSTIC_INPUT: input, MEMORY_READER_DIAGNOSTIC_OUTPUT: output },
    });
    // Only emit an exit code on failure; no environment or subprocess output is persisted.
    child.stdout.resume(); child.stderr.resume();
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Offline Rust ${mode} replay failed (${code})`)));
  });
  const result = await json(output);
  assert.equal(result.providerCalls, 0, 'Replay must never call a provider');
  equal(result.rows.map(r => r.id), jobs.map(j => j.id), 'Rust replay changed job order');
  return result;
}

async function verifyFrozenFiles(registration) {
  const sourceFiles = (await readdir(path.join(root, 'crates/core/src'), { recursive: true }))
    .filter(f => f.endsWith('.rs') || f === 'evidence_reader_system.txt').map(f => `crates/core/src/${f.replaceAll('\\', '/')}`);
  const required = [...sourceFiles, 'scripts/memory-reader-diagnostic.mjs', 'scripts/evaluate-memory-reader-diagnostic.mjs',
    'scripts/memory-public-live-io.mjs', 'scripts/capture-memory-evaluation-references.mjs',
    'docs/memory-public-dataset-manifest.json', baselineFile, 'docs/memory-diagnostic-adjudication.json',
    'Cargo.lock', 'crates/core/Cargo.toml'];
  equal(Object.keys(registration.files).sort(), required.sort(), 'Frozen file inventory mismatch');
  for (const [file, expected] of Object.entries(registration.files)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected, `Frozen file changed: ${file}`);
  }
}

export async function verifyDiagnostic(workspace) {
  const registration = await json(path.join(root, registrationFile));
  const runRoot = path.resolve(root, workspace ?? registration.workspace);
  assert.match(path.relative(root, runRoot), /^\.local-data[\\/]memory-reader-diagnostic-[^\\/]+$/, 'Invalid diagnostic directory');
  assert.equal(runRoot, path.resolve(root, registration.workspace), 'Workspace mismatch');
  equal(registration, await json(path.join(runRoot, 'registration.json')), 'Registration copies differ');
  assert.equal(registration.version, 'memory-reader-diagnostic-v1');
  assert.equal(registration.model, 'deepseek-flash');
  equal(registration.limits, { requests: 100, totalTokens: 1600000, outputTokens: 4096, automaticRetries: 0 });
  equal(LIMITS, registration.limits);
  equal(registration.arms, ['retrieved_desktop', 'retrieved_connector', 'annotated_passages', 'full_document']);
  assert.equal(registration.plannedReaderRequests, 80); assert.equal(registration.plannedJudgeRequests, 20);
  assert.equal(registration.questions, 20); assert.equal(registration.answerable, 19);
  assert.equal(registration.noHumanAnswersInReader, true); assert.equal(registration.noGradeOverrides, true);
  assert.equal(registration.noSemanticRetries, true);
  // A running or interrupted workspace must not be certified as completed.
  try { await access(path.join(runRoot, 'run.lock')); throw new Error('Diagnostic runner is active or its lock is unresolved'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(await json(path.join(runRoot, 'pending.json')), null, 'Unresolved dispatched request');
  const summary = await json(path.join(runRoot, 'summary.json'));
  assert.equal(typeof summary.complete, 'boolean');
  equal(summary, await json(path.join(root, summaryFile)), 'Published and workspace summaries differ');
  await verifyFrozenFiles(registration);

  const immutablePaths = [registrationFile, summaryFile, ...['registration.json', 'cases.json', 'jobs.json', 'calls.json',
    'receipts.jsonl', 'normalize-output.json', 'summary.json', 'pending.json'].map(f => path.relative(root, path.join(runRoot, f))),
    registration.fixture, registration.historicalReceipts.file,
    ...(!summary.complete ? [auditedFile, amendmentFile] : [])];
  const immutableHashes = Object.fromEntries(await Promise.all(immutablePaths.map(async file => [file, hash(await readFile(path.join(root, file)))])));
  const manifest = await json(path.join(root, 'docs/memory-public-dataset-manifest.json'));
  assert.equal(registration.fixture, manifest.fixture); assert.equal(registration.datasetSha256, manifest.datasetSha256);
  const fixtureBytes = await readFile(path.join(root, manifest.fixture));
  assert.equal(hash(fixtureBytes), registration.datasetSha256, 'Frozen fixture changed');
  const fixture = JSON.parse(fixtureBytes);
  const historical = await readPublicLiveReport(path.join(root, baselineFile));
  assert.equal(historical.complete, true); assert.equal(historical.datasetSha256, registration.datasetSha256);
  assert.equal(registration.baselineWorkspace, historical.workspace);
  assert.equal(registration.formalMemoryCount, historical.documents.reduce((n, d) => n + d.memories.length, 0));
  assert.equal(registration.formalMemoriesSha256, digest(historical.documents.map(d => ({ id: d.id, memories: d.memories }))));
  const cases = await json(path.join(runRoot, 'cases.json')), jobs = await json(path.join(runRoot, 'jobs.json'));
  const calls = await json(path.join(runRoot, 'calls.json'));
  assert.equal(digest(cases), registration.casesSha256); assert.equal(digest(jobs), registration.jobsSha256);
  assert.equal(digest(calls), registration.callsSha256);
  equal(cases, prepareCases(fixture, historical), 'Cases do not derive from frozen source and initial packs');
  equal(jobs, buildJobs(cases), 'Reader jobs differ from frozen cases');
  assert.equal(new Set(cases.map(c => c.id)).size, 20); assert.equal(cases.filter(c => c.answerable).length, 19);
  equal(registration.requestHashes, Object.fromEntries(calls.map(c => [c.id, digest(c.body)])), 'Request inventory changed');

  const priorBytes = await readFile(path.join(root, registration.historicalReceipts.file));
  assert.equal(hash(priorBytes), registration.historicalReceipts.sha256, 'Historical receipt archive changed');
  const priorList = priorBytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const prior = new Map(priorList.map(r => [r.index, r]));
  assert.equal(prior.size, priorList.length, 'Duplicate historical receipt index');
  for (const c of cases) {
    const paper = fixture.documents.find(d => d.id === c.paperId);
    const question = paper.queries.find(q => q.id === c.id);
    equal(c.packs.full_document.map(r => r.content), paper.paragraphs.map(p => p.content), 'Full document truncated or reordered');
    const gold = new Set(question.acceptableEvidenceSets.flat(2));
    const expected = question.answerable ? paper.paragraphs.filter(p => gold.has(p.id)) : paper.paragraphs;
    equal(c.packs.annotated_passages.map(r => r.content), expected.map(p => p.content), 'Annotated arm source selection mismatch');
    for (const entry of ['desktop', 'connector']) {
      const p = c.provenance[`retrieved_${entry}`], receipt = prior.get(p.receiptId);
      assert.equal(p.generationIndex, 0, 'Normal arm must use the first generation');
      assert.ok(receipt, 'Missing actual historical request');
      assert.equal(digest(receipt.request), p.requestSha256, 'Initial pack actual request hash mismatch');
      const rawInput = JSON.parse(receipt.request.messages.at(-1).content);
      const captured = capturedEvaluationReferences(rawInput);
      assert.equal(digest(captured), p.originalReferencesSha256, 'Initial pack differs from the actual request');
      equal(c.packs[`retrieved_${entry}`].map(r => r.content), captured.map(r => r.content), 'Initial evidence content changed');
    }
  }
  const sameEvidence = cases.filter(c => digest(c.packs.retrieved_desktop) === digest(c.packs.retrieved_connector)).map(c => c.id);
  const sameContent = cases.filter(c => digest(c.packs.retrieved_desktop.map(r => r.content)) === digest(c.packs.retrieved_connector.map(r => r.content))).map(c => c.id);
  equal(registration.sameInitialEvidenceQuestions, sameEvidence); equal(registration.sameInitialContentQuestions, sameContent);
  equal(summary.sameInitialEvidenceQuestions, sameEvidence); equal(summary.sameInitialContentQuestions, sameContent);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.phase, 'reader'); assert.equal(call.id, jobs[index].id);
    const input = JSON.parse(call.body.messages[1].content);
    assertReaderHasNoLabels(input);
    assert.equal(input.question, jobs[index].question);
    equal(input.references.map(r => r.content.map(s => s.text).join('')), jobs[index].references.map(r => r.content), 'Wire evidence truncated or reordered');
  }

  const receiptBytes = await readFile(path.join(runRoot, 'receipts.jsonl'));
  const receipts = receiptBytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const usage = verifyReceiptInventory(receipts, calls, cases);
  const auditRoot = await mkdtemp(path.join(runRoot, 'verification-'));
  const rebuilt = await replay(auditRoot, 'build', jobs);
  equal(rebuilt.rows.map(r => ({ id: r.id, phase: 'reader', body: modelBody(r.request) })), calls,
    'Frozen requests differ from independent production Rust rebuild');
  const normalizeJobs = jobs.map((job, i) => ({ ...job, rawOutput: JSON.parse(receipts[i].responseText).choices[0].message.content }));
  const normalized = await replay(auditRoot, 'normalize', normalizeJobs);
  const normalizedBytes = await readFile(path.join(runRoot, 'normalize-output.json'));
  equal(normalized, JSON.parse(normalizedBytes), 'Raw responses do not reproduce the saved Rust normalization');
  const byId = new Map(normalized.rows.map(row => [row.id, row]));

  const emptyScores = () => Object.fromEntries(ALL_ARMS.map(arm => [arm, {
    answerable: 19, completeCorrect: 0, partial: 0, incorrect: 0, uncertainOrMissing: 0, unanswerableCorrect: 0,
    ...(ARMS.includes(arm) ? { requests: 0, tokens: 0, bindingFailures: 0 } : {}),
  }]));
  const scores = emptyScores(), rawScores = emptyScores();
  const judged = [], rawJudged = [], changes = [];
  for (const [index, c] of cases.entries()) {
    const receipt = receipts[80 + index], { order, body } = buildJudge(c, byId);
    equal(receipt.request, body, 'Anonymous judge input differs from normalized and historical answers');
    equal([...order].sort(), [...ALL_ARMS].sort(), 'Judge omitted or duplicated an arm');
    const provider = JSON.parse(receipt.responseText), content = provider.choices[0].message.content;
    let grades, rawGrades;
    try {
      grades = rawGrades = parseJudge(content, order);
      rawJudged.push({ id: c.id, grades: rawGrades, anonymousOrder: order });
    } catch (error) {
      // Independently permit only the observed syntactic class: one absent terminal
      // object brace. No replacement, reformatting, model retry or answer edit.
      assert.throws(() => JSON.parse(content), SyntaxError, 'Valid JSON with a schema error cannot be amended');
      assert.equal(provider.choices[0].finish_reason, 'stop');
      assert.ok(content.trimEnd().endsWith('}'), 'Amendment requires a terminal object brace');
      grades = parseJudge(content + '}', order);
      rawJudged.push({ id: c.id, error: error.message, anonymousOrder: order });
      changes.push({ questionId: c.id, receiptIndex: receipt.index, originalError: error.message,
        kind: 'append-single-final-object-brace', originalContentSha256: hash(content), amendedContentSha256: hash(content + '}'),
        appended: '}', semanticFieldsChanged: 0, modelRequests: 0 });
    }
    judged.push({ id: c.id, grades, anonymousOrder: order });
    for (const [target, values] of [[scores, grades], [rawScores, rawGrades]]) for (const arm of ALL_ARMS) {
      const grade = values?.[arm]?.answerCorrect;
      if (!c.answerable) target[arm].unanswerableCorrect += Number(grade === 'yes');
      else target[arm][{ yes: 'completeCorrect', partial: 'partial', no: 'incorrect' }[grade] ?? 'uncertainOrMissing']++;
      if (ARMS.includes(arm)) {
        const reader = receipts.find(r => r.id === `${c.id}:${arm}`);
        target[arm].requests++;
        target[arm].tokens += JSON.parse(reader.responseText).usage.total_tokens;
        target[arm].bindingFailures += Number(!byId.get(reader.id).ok);
      }
    }
  }
  assert.ok(changes.length <= 1, 'More than one protocol amendment is outside this audit scope');
  assert.equal(summary.complete, rawJudged.every(row => !row.error), 'Original completion status differs from raw judge protocol');
  equal(summary.arms, rawScores, 'Original summary scores differ from original anonymous judge outputs');
  equal(summary.cases, cases.map((c, i) => ({ id: c.id, paperId: c.paperId, question: c.question, answerable: c.answerable,
    historicalOriginalGrades: c.historicalGrades, ...rawJudged[i], answers: Object.fromEntries(ARMS.map(arm => {
      const row = byId.get(`${c.id}:${arm}`);
      return [arm, { ok: row.ok, answer: row.result?.answer, status: row.result?.status, error: row.error }];
    })) })), 'Summary per-question grades, reasons, answers or historical grades changed');
  equal(summary.usage, { requests: usage.requests, totalTokens: usage.totalTokens, readerTokens: usage.readerTokens, judgeTokens: usage.judgeTokens });
  assert.equal(summary.version, registration.version); assert.equal(summary.workspace, registration.workspace);
  assert.equal(summary.registrationSha256, digest(registration)); assert.equal(summary.methodology, registration.interpretation);
  assert.equal(summary.memoryContentUnchanged, true);
  equal(summary.integrity, { receiptsSha256: hash(receiptBytes), normalizedSha256: hash(normalizedBytes), frozenFilesUnchanged: true,
    actualModels: [...new Set(receipts.map(r => r.actualModel))], providerUsageVerified: true, uniqueRequestIds: 100, noAutomaticRetries: true });
  if (changes.length) {
    const sourceBytes = await readFile(path.join(root, summaryFile));
    const outputBytes = await readFile(path.join(root, auditedFile));
    const amendment = await json(path.join(root, amendmentFile));
    const expected = structuredClone(summary);
    expected.complete = true;
    expected.arms = scores;
    for (const change of changes) {
      const row = expected.cases.find(c => c.id === change.questionId);
      row.grades = judged.find(c => c.id === row.id).grades;
      row.originalProtocolError = row.error;
      delete row.error;
    }
    expected.technicalAmendment = { kind: 'post-run-syntax-only-derived-report',
      originalFile: path.relative(root, path.join(root, summaryFile)), originalSha256: hash(sourceBytes), modelRequests: 0, changes };
    equal(JSON.parse(outputBytes), expected, 'Derived report changed fields beyond the single brace amendment and resulting scores');
    equal(amendment, { version: 'memory-reader-diagnostic-syntax-amendment-v1', recordedAt: amendment.recordedAt,
      source: { file: path.relative(root, path.join(root, summaryFile)), sha256: hash(sourceBytes), complete: false },
      registrationSha256: digest(registration), rawReceiptsSha256: hash(receiptBytes),
      output: { file: path.relative(root, path.join(root, auditedFile)), sha256: hash(outputBytes), complete: true }, changes,
      originalArtifactsUnchanged: true, originalAnswersUnchanged: true, newApiRequests: 0, note: amendment.note },
    'Technical amendment does not match independently reconstructed change');
  }
  await verifyFrozenFiles(registration);
  for (const [file, expected] of Object.entries(immutableHashes)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected, `Evidence changed during audit: ${file}`);
  }
  const result = {
    version: 'memory-reader-diagnostic-integrity-v1', verified: true, completedAt: new Date().toISOString(),
    workspace: registration.workspace, auditReplayWorkspace: path.relative(root, auditRoot), providerCalls: 0,
    scope: 'Offline integrity and binding replay; does not independently establish semantic correctness or full production accuracy.',
    registrationSha256: digest(registration), verifierSha256: hash(await readFile(import.meta.filename)),
    immutableArtifactHashes: immutableHashes, frozenFileCount: Object.keys(registration.files).length,
    originalComplete: summary.complete, auditedComplete: true, originalProtocolErrors: rawJudged.filter(j => j.error).length,
    technicalAmendmentsVerified: changes,
    checks: { frozenInputsAndCode: true, actualInitialPacks: 40, fullDocumentPacks: 20, annotatedPacks: 20,
      noReaderEvaluationLabels: true, rustRequestRebuilds: 80, rawResponseNormalizationReplays: 80,
      uniqueOrderedReceipts: 100, anonymousJudgesReconstructed: 20, independentlyRecomputedGrades: 120,
      predispatchAndActualBudgetVerified: true, noOutstandingRequest: true, savedAndPublishedSummaryMatch: true },
    usage, sameInitialEvidenceQuestions: sameEvidence, sameInitialContentQuestions: sameContent, arms: scores, originalArms: rawScores,
    rawResponseToNormalized: normalized.rows.map((row, i) => ({ id: row.id,
      receiptIndex: receipts[i].index, requestSha256: receipts[i].requestSha256,
      responseSha256: hash(receipts[i].responseText), normalizationInputSha256: digest(normalizeJobs[i]), normalizedRowSha256: digest(row) })),
  };
  await writeFile(path.join(root, integrityFile), JSON.stringify(result, null, 2));
  return result;
}

function selfTest() {
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}` }));
  const body = { model: 'deepseek-flash', max_tokens: 4096 };
  const calls = cases.flatMap(c => ARMS.map(arm => ({ id: `${c.id}:${arm}`, phase: 'reader', body })));
  const receipts = [...calls, ...cases.map(c => ({ id: `${c.id}:judge`, phase: 'judge', body }))].map((call, i) => {
    const provider = { model: 'provider-model', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      choices: [{ finish_reason: 'stop', message: { content: '{}' } }] };
    return { id: call.id, phase: call.phase, index: i + 1, status: 200, request: call.body,
      requestSha256: digest(call.body), reservation: requestReservation(call.body), responseText: JSON.stringify(provider),
      actualModel: provider.model, finishReason: 'stop', usage: provider.usage };
  });
  assert.equal(verifyReceiptInventory(receipts, calls, cases).totalTokens, 300);
  for (const mutate of [
    rows => rows.pop(), rows => { rows[1].id = rows[0].id; }, rows => { rows[0].phase = 'judge'; },
    rows => { rows[0].requestSha256 = 'changed'; }, rows => { rows[0].reservation++; },
    rows => { rows[0].usage.total_tokens++; }, rows => { rows[0].error = 'failed'; },
  ]) { const rows = structuredClone(receipts); mutate(rows); assert.throws(() => verifyReceiptInventory(rows, calls, cases)); }
  assertReaderHasNoLabels({ question: 'The word answerable is source text.', references: [{ content: 'goldParagraphs' }] });
  assert.throws(() => assertReaderHasNoLabels({ nested: [{ answerable: true }] }));
  return { passed: true, checks: 10, providerCalls: 0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--self-test') console.log(JSON.stringify(selfTest()));
    else {
      assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--workspace'), 'Usage: [--workspace PATH] | --self-test');
      const result = await verifyDiagnostic(args[1]);
      console.log(JSON.stringify({ verified: result.verified, providerCalls: 0, usage: result.usage, report: integrityFile }));
    }
  } catch (error) { console.error(JSON.stringify({ verified: false, error: error.message, providerCalls: 0 })); process.exitCode = 1; }
}
