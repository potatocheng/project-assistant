import { readFile, writeFile, appendFile, mkdir, mkdtemp, readdir, access, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readPublicLiveReport } from './memory-public-live-io.mjs';
import { capturedEvaluationReferences } from './capture-memory-evaluation-references.mjs';
import { hash, ARMS, ALL_ARMS, LIMITS, prepareCases, buildJobs, modelBody, buildJudge, parseJudge, requestReservation, validateUsage } from './memory-reader-diagnostic.mjs';

const root = path.resolve(import.meta.dirname, '..');
const baselineFile = 'docs/memory-architecture-dev-v2-audited-results.json';
const registrationFile = 'docs/memory-reader-diagnostic-preregistration.json';
const summaryFile = 'docs/memory-reader-diagnostic-results.json';
const sourceFiles = (await readdir(path.join(root, 'crates/core/src'), { recursive: true }))
  .filter(f => f.endsWith('.rs') || f === 'evidence_reader_system.txt').sort().map(f => `crates/core/src/${f.replaceAll('\\', '/')}`);
const frozenFiles = [...sourceFiles, 'scripts/memory-reader-diagnostic.mjs', 'scripts/evaluate-memory-reader-diagnostic.mjs',
  'scripts/memory-public-live-io.mjs', 'scripts/capture-memory-evaluation-references.mjs', 'docs/memory-public-dataset-manifest.json', baselineFile,
  'docs/memory-diagnostic-adjudication.json', 'Cargo.lock', 'crates/core/Cargo.toml'];
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const fingerprints = async () => Object.fromEntries(await Promise.all(frozenFiles.map(async f => [f, hash(await readFile(path.join(root, f)))])));
const save = async (file, value, options = {}) => writeFile(file, JSON.stringify(value, null, 2), options);
const log = value => process.stdout.write(`${new Date().toISOString()} ${value}\n`);
async function bridge(runRoot, mode, jobs) {
  const input = path.join(runRoot, `${mode}-input.json`), output = path.join(runRoot, `${mode}-output.json`);
  await save(input, { mode, jobs }, { flag: 'wx' });
  const cargo = process.platform === 'win32' ? path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo';
  await new Promise((resolve, reject) => {
    const child = spawn(cargo, ['test', '--locked', '-p', 'project-assistant-core', '--lib', 'memory_evaluation::evidence_reader_diagnostic_bridge', '--', '--ignored', '--exact'],
      { cwd: root, windowsHide: true, env: { ...process.env, MEMORY_READER_DIAGNOSTIC_INPUT: input, MEMORY_READER_DIAGNOSTIC_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Rust diagnostic bridge failed (${code}): ${text.slice(-4000)}`)));
  });
  const result = await json(output);
  if (result.rows.length !== jobs.length || result.rows.some((r, i) => r.id !== jobs[i].id)) throw new Error('Bridge output job mapping');
  return result;
}

async function prepare() {
  // Refuse accidental replacement of a registered experiment.
  try { await access(path.join(root, registrationFile)); throw new Error('Diagnostic already registered; run its existing workspace'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = await json(path.join(root, 'docs/memory-public-dataset-manifest.json'));
  const fixtureBytes = await readFile(path.resolve(root, manifest.fixture));
  if (hash(fixtureBytes) !== manifest.datasetSha256) throw new Error('Fixture hash changed');
  const historical = await readPublicLiveReport(path.join(root, baselineFile));
  if (!historical.complete || historical.datasetSha256 !== manifest.datasetSha256) throw new Error('Incomplete or mismatched baseline');
  const cases = prepareCases(JSON.parse(fixtureBytes), historical), jobs = buildJobs(cases);
  const historicalReceiptsFile = path.join(historical.workspace, 'receipts.jsonl');
  const historicalReceiptBytes = await readFile(path.join(root, historicalReceiptsFile));
  const historicalReceipts = new Map(historicalReceiptBytes.toString('utf8').split('\n').filter(Boolean).map(line => { const r = JSON.parse(line); return [r.index, r]; }));
  for (const c of cases) for (const entry of ['desktop', 'connector']) {
    const provenance = c.provenance[`retrieved_${entry}`], receipt = historicalReceipts.get(provenance.receiptId);
    if (!receipt || hash(JSON.stringify(receipt.request)) !== provenance.requestSha256) throw new Error('Historical generation receipt hash mismatch');
    const input = JSON.parse(receipt.request.messages.at(-1).content);
    if (hash(JSON.stringify(capturedEvaluationReferences(input))) !== provenance.originalReferencesSha256) throw new Error('Frozen initial pack differs from actual historical request');
  }
  await mkdir(path.join(root, '.local-data'), { recursive: true });
  const runRoot = await mkdtemp(path.join(root, '.local-data/memory-reader-diagnostic-'));
  const prepared = await bridge(runRoot, 'build', jobs);
  if (prepared.rows.some(r => !r.ok || !r.request)) throw new Error('Failed to construct production reader requests');
  const calls = prepared.rows.map(r => ({ id: r.id, phase: 'reader', body: modelBody(r.request) }));
  for (const [index, call] of calls.entries()) {
    const shown = JSON.parse(call.body.messages[1].content).references;
    if (shown.length !== jobs[index].references.length || shown.some((ref, i) => ref.content.map(s => s.text).join('') !== jobs[index].references[i].content)) throw new Error('Reader dropped or changed evidence content');
  }
  const sameEvidence = cases.filter(c => JSON.stringify(c.packs.retrieved_desktop) === JSON.stringify(c.packs.retrieved_connector)).map(c => c.id);
  const sameContent = cases.filter(c => JSON.stringify(c.packs.retrieved_desktop.map(r => r.content)) === JSON.stringify(c.packs.retrieved_connector.map(r => r.content))).map(c => c.id);
  const registration = { version: 'memory-reader-diagnostic-v1', registeredAt: new Date().toISOString(),
    authorization: 'User requested the next diagnostic step after proposal to adjudicate ambiguous cases, unify readers and compare supplied original evidence against retrieved evidence.',
    workspace: path.relative(root, runRoot), model: 'deepseek-flash', limits: LIMITS, questions: 20, answerable: 19,
    arms: ARMS, plannedReaderRequests: 80, plannedJudgeRequests: 20, historicalComparison: '40 saved final production answers, freshly anonymously graded alongside four diagnostic answers per question',
    evidencePolicy: 'First generation pack for each entry, never final answer-dependent producer selection. Original annotated paragraph union is diagnostic privileged selection; unanswerable question receives full paper. Full-document arm includes every paragraph without truncation.',
    interpretation: 'One shared production request builder and binding normalizer. No production retrieval execution, semantic review, repair or fallback. This is a controlled reader diagnostic, not updated end-to-end product accuracy or a held-out evaluation. Agent evidence audit is not human adjudication and never changes historical grades.',
    noHumanAnswersInReader: true, noGradeOverrides: true, noSemanticRetries: true,
    fixture: manifest.fixture, datasetSha256: manifest.datasetSha256, formalMemoryCount: historical.documents.reduce((n, d) => n + d.memories.length, 0),
    formalMemoriesSha256: hash(JSON.stringify(historical.documents.map(d => ({ id: d.id, memories: d.memories })))),
    files: await fingerprints(), baselineWorkspace: historical.workspace,
    historicalReceipts: { file: historicalReceiptsFile, sha256: hash(historicalReceiptBytes) },
    sameInitialEvidenceQuestions: sameEvidence,
    sameInitialContentQuestions: sameContent,
    requestHashes: Object.fromEntries(calls.map(c => [c.id, hash(JSON.stringify(c.body))])),
    casesSha256: hash(JSON.stringify(cases)), jobsSha256: hash(JSON.stringify(jobs)), callsSha256: hash(JSON.stringify(calls)) };
  await save(path.join(runRoot, 'cases.json'), cases);
  await save(path.join(runRoot, 'jobs.json'), jobs);
  await save(path.join(runRoot, 'calls.json'), calls);
  await save(path.join(runRoot, 'registration.json'), registration, { flag: 'wx' });
  await save(path.join(root, registrationFile), registration, { flag: 'wx' });
  log(JSON.stringify({ workspace: registration.workspace, plannedRequests: 100, sameInitialEvidence: sameEvidence.length,
    readerInputBytes: calls.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c.body)), 0), providerCalls: 0 }));
}

async function run(workspace) {
  const runRoot = path.resolve(root, workspace);
  if (!runRoot.startsWith(path.join(root, '.local-data/memory-reader-diagnostic-'))) throw new Error('Invalid diagnostic workspace');
  const registration = await json(path.join(runRoot, 'registration.json'));
  if (JSON.stringify(registration) !== JSON.stringify(await json(path.join(root, registrationFile)))) throw new Error('Registration mismatch');
  if (registration.version !== 'memory-reader-diagnostic-v1' || registration.model !== 'deepseek-flash'
      || JSON.stringify(registration.limits) !== JSON.stringify(LIMITS) || JSON.stringify(registration.arms) !== JSON.stringify(ARMS)
      || registration.plannedReaderRequests !== 80 || registration.plannedJudgeRequests !== 20
      || registration.questions !== 20 || registration.answerable !== 19) throw new Error('Registered diagnostic constraints changed');
  if (JSON.stringify(registration.files) !== JSON.stringify(await fingerprints())) throw new Error('Frozen code, review or source changed');
  const cases = await json(path.join(runRoot, 'cases.json')), jobs = await json(path.join(runRoot, 'jobs.json')), calls = await json(path.join(runRoot, 'calls.json'));
  if (hash(JSON.stringify(cases)) !== registration.casesSha256 || hash(JSON.stringify(jobs)) !== registration.jobsSha256 || hash(JSON.stringify(calls)) !== registration.callsSha256) throw new Error('Frozen inputs changed');
  if (calls.length !== 80 || jobs.length !== 80 || cases.length !== 20 || new Set(calls.map(c => c.id)).size !== 80
      || calls.some(c => c.phase !== 'reader' || hash(JSON.stringify(c.body)) !== registration.requestHashes[c.id])) throw new Error('Registered request inventory changed');
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY is required');
  const lockFile = path.join(runRoot, 'run.lock');
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  try {
  const safe = value => {
    const text = JSON.stringify(value);
    if (text.includes(key)) throw new Error('Credential persistence refused');
    return text;
  };
  const receiptFile = path.join(runRoot, 'receipts.jsonl');
  let receipts = [];
  try { receipts = (await readFile(receiptFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (receipts.length > LIMITS.requests || new Set(receipts.map(r => r.id)).size !== receipts.length) throw new Error('Duplicate or excessive receipts');
  for (const [index, receipt] of receipts.entries()) {
    const expectedId = index < 80 ? calls[index].id : `${cases[index - 80]?.id}:judge`;
    if (receipt.index !== index + 1 || receipt.id !== expectedId || receipt.requestSha256 !== hash(JSON.stringify(receipt.request))
        || receipt.reservation !== requestReservation(receipt.request) || receipt.error) throw new Error('Invalid or failed receipt; never automatically replay');
    const provider = JSON.parse(receipt.responseText);
    validateUsage(provider, receipt.reservation);
    if (JSON.stringify(provider.usage) !== JSON.stringify(receipt.usage)) throw new Error('Receipt usage differs from provider response');
  }
  const spent = () => receipts.reduce((n, r) => n + (r.usage?.total_tokens ?? 0), 0);
  const pendingFile = path.join(runRoot, 'pending.json');
  try { const pending = await json(pendingFile); if (pending && !receipts.some(r => r.id === pending.id)) throw new Error(`Uncertain dispatched request ${pending.id}; refusing duplicate`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function call(task) {
    const previous = receipts.find(r => r.id === task.id);
    if (previous) {
      if (previous.requestSha256 !== hash(JSON.stringify(task.body)) || previous.error) throw new Error(`Previous failed or changed request: ${task.id}`);
      return previous;
    }
    const reservation = requestReservation(task.body);
    if (receipts.length >= registration.limits.requests || spent() + reservation > registration.limits.totalTokens) throw new Error('Registered diagnostic budget exhausted before dispatch');
    const receipt = { id: task.id, phase: task.phase, index: receipts.length + 1, startedAt: new Date().toISOString(),
      requestSha256: hash(JSON.stringify(task.body)), reservation, request: task.body };
    await writeFile(pendingFile, safe({ id: task.id, requestSha256: receipt.requestSha256, startedAt: receipt.startedAt }));
    const started = Date.now();
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(task.body), signal: AbortSignal.timeout(120000) });
      receipt.status = response.status; receipt.responseText = await response.text();
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      const provider = JSON.parse(receipt.responseText);
      receipt.actualModel = provider.model; receipt.usage = provider.usage;
      receipt.finishReason = provider.choices?.[0]?.finish_reason;
      validateUsage(provider, reservation);
    } catch (error) { receipt.error = String(error.message).replaceAll(key, '[REDACTED]'); }
    receipt.elapsedMs = Date.now() - started;
    await appendFile(receiptFile, safe(receipt) + '\n'); receipts.push(receipt);
    await writeFile(pendingFile, 'null');
    log(`API ${receipt.index}/100 ${task.phase} ${task.id.slice(0, 8)} tokens=${receipt.usage?.total_tokens ?? 0} ${receipt.error || 'ok'}`);
    if (receipt.error) throw new Error(receipt.error);
    return receipt;
  }
  for (const task of calls) await call(task);
  const normalFile = path.join(runRoot, 'normalize-output.json');
  const normalizeJobs = jobs.map(job => {
    const raw = receipts.find(r => r.id === job.id);
    return { ...job, rawOutput: JSON.parse(raw.responseText).choices[0].message.content };
  });
  // Recompute locally even on resume; a saved normalized answer is never a trusted input.
  const verificationRoot = await mkdtemp(path.join(runRoot, 'normalization-'));
  const normalized = await bridge(verificationRoot, 'normalize', normalizeJobs);
  try { if (JSON.stringify(normalized) !== JSON.stringify(await json(normalFile))) throw new Error('Saved normalization differs from current frozen Rust replay'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await save(normalFile, normalized, { flag: 'wx' }); }
  const normalizedById = new Map(normalized.rows.map(row => [row.id, row]));
  const judged = [];
  for (const c of cases) {
    const { body, order } = buildJudge(c, normalizedById);
    const receipt = await call({ id: `${c.id}:judge`, phase: 'judge', body });
    const content = JSON.parse(receipt.responseText).choices[0].message.content;
    try { judged.push({ id: c.id, grades: parseJudge(content, order), anonymousOrder: order }); }
    catch (error) { judged.push({ id: c.id, error: error.message, anonymousOrder: order }); }
  }
  const summary = { version: registration.version, complete: receipts.length === 100 && judged.every(j => !j.error), finishedAt: new Date().toISOString(),
    workspace: registration.workspace, registrationSha256: hash(JSON.stringify(registration)),
    methodology: registration.interpretation, memoryContentUnchanged: true, sameInitialEvidenceQuestions: registration.sameInitialEvidenceQuestions,
    sameInitialContentQuestions: registration.sameInitialContentQuestions,
    usage: { requests: receipts.length, totalTokens: spent(),
      readerTokens: receipts.filter(r => r.phase === 'reader').reduce((n, r) => n + r.usage.total_tokens, 0),
      judgeTokens: receipts.filter(r => r.phase === 'judge').reduce((n, r) => n + r.usage.total_tokens, 0) },
    arms: Object.fromEntries(ALL_ARMS.map(arm => {
      const answered = cases.filter(c => c.answerable).map(c => judged.find(j => j.id === c.id)?.grades?.[arm]?.answerCorrect);
      const unanswerable = cases.filter(c => !c.answerable).map(c => judged.find(j => j.id === c.id)?.grades?.[arm]?.answerCorrect);
      const current = ARMS.includes(arm), relevant = receipts.filter(r => r.phase === 'reader' && r.id.endsWith(`:${arm}`));
      return [arm, { answerable: 19, completeCorrect: answered.filter(g => g === 'yes').length,
        partial: answered.filter(g => g === 'partial').length, incorrect: answered.filter(g => g === 'no').length,
        uncertainOrMissing: answered.filter(g => !g || g === 'uncertain').length,
        unanswerableCorrect: unanswerable.filter(g => g === 'yes').length,
        ...(current ? { requests: relevant.length, tokens: relevant.reduce((n, r) => n + r.usage.total_tokens, 0),
          bindingFailures: normalized.rows.filter(row => row.id.endsWith(`:${arm}`) && !row.ok).length } : {}) }];
    })),
    cases: cases.map(c => ({ id: c.id, paperId: c.paperId, question: c.question, answerable: c.answerable,
      historicalOriginalGrades: c.historicalGrades, ...judged.find(j => j.id === c.id),
      answers: Object.fromEntries(ARMS.map(arm => { const row = normalizedById.get(`${c.id}:${arm}`); return [arm, { ok: row?.ok, answer: row?.result?.answer, status: row?.result?.status, error: row?.error }]; })) })),
    integrity: { receiptsSha256: hash(await readFile(receiptFile)), normalizedSha256: hash(await readFile(normalFile)),
      frozenFilesUnchanged: JSON.stringify(registration.files) === JSON.stringify(await fingerprints()),
      actualModels: [...new Set(receipts.map(r => r.actualModel))], providerUsageVerified: receipts.every(r => validateUsage(JSON.parse(r.responseText), r.reservation)),
      uniqueRequestIds: new Set(receipts.map(r => r.id)).size, noAutomaticRetries: true } };
  summary.complete &&= summary.integrity.frozenFilesUnchanged;
  await save(path.join(runRoot, 'summary.json'), summary);
  await save(path.join(root, summaryFile), summary);
  log(JSON.stringify({ complete: summary.complete, usage: summary.usage, arms: summary.arms }));
  } finally { await unlink(lockFile); }
}

const [command, workspace] = process.argv.slice(2);
if (command === '--prepare' && !workspace) await prepare();
else if (command === '--run' && workspace) await run(workspace);
else throw new Error('Usage: --prepare | --run .local-data/memory-reader-diagnostic-...');
