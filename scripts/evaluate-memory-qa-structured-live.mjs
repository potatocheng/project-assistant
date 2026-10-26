// Public-data evaluation through the unchanged production Engine. Credentials
// stay in RAM; only random loopback credentials enter isolated workspaces.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, cp, readdir, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readPublicLiveReport, savePublicLiveReport } from './memory-public-live-io.mjs';
import { publicLiveOptions, selectPublicDocuments, publicReportPath, assertNoProductionGold, failedJudgeRepairPlan, beginJudgeRepair } from './memory-public-live-options.mjs';
import { isolatedJudgeTasks, parseIsolatedJudgeResponse, combineIsolatedJudgments } from './memory-qa-structured-judges.mjs';
import { qaStructuredEvaluationFiles, fingerprintQaStructuredEvaluation } from './memory-qa-structured-evaluation-files.mjs';
import { verifyStructuredPreLive } from './memory-qa-structured-pre-live.mjs';
import { structuredLiveOptions } from './memory-qa-structured-options.mjs';
import { copyFrozenPaperWorkspace, assertFrozenHostMemory, frozenMemorySemanticHash } from './memory-qa-structured-freeze.mjs';
import { capturedEvaluationReferences, capturedEvaluationSchema, validateStructuredClaimProvenance, selectedEvaluationReferences } from './memory-qa-structured-capture.mjs';
import { buildPriorRunLedger, loadBudgetAddendum, remainingRunBudget, budgetCanonical } from './memory-public-live-budget.mjs';
import { prepareQaStructuredBudget } from './memory-qa-structured-budget.mjs';

const root = path.resolve(import.meta.dirname, '..');
const options = structuredLiveOptions(process.argv.slice(2), root);
const key = process.env.DEEPSEEK_API_KEY;
if (!key && !options.noApiDryRun) throw new Error('DEEPSEEK_API_KEY is required');
const model = process.env.MEMORY_EVAL_MODEL || 'deepseek-flash';
const paragraphControl = process.argv.includes('--paragraph-control');
const priorIndex = process.argv.indexOf('--prior-run');
const prior = priorIndex >= 0 ? await readPublicLiveReport(path.resolve(process.argv[priorIndex + 1])) : null;
if (paragraphControl && !prior) throw new Error('Paragraph control requires --prior-run report to share the announced budget');
const hash = v => createHash('sha256').update(v).digest('hex');
const clean = v => key ? String(v).replaceAll(key, '[REDACTED]') : String(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = v => process.stdout.write(`${new Date().toISOString()} ${v}\n`);
const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
const fixtureBytes = await readFile(path.resolve(root, manifest.fixture));
if (hash(fixtureBytes) !== manifest.datasetSha256) throw new Error('Frozen fixture changed');
const fixture = JSON.parse(fixtureBytes);
const selected = selectPublicDocuments(fixture, options.split);
if (options.split === 'all' && !options.requiredGate) throw new Error('Full100 requires the passing structured development gate');
const baseline = await readPublicLiveReport(options.baseline);
if (baseline.datasetSha256 !== hash(fixtureBytes)) throw new Error('Baseline fixture mismatch');
if (options.requiredGate) {
  const gate = JSON.parse(await readFile(path.resolve(root, options.requiredGate)));
  if (gate.passed !== true || !gate.checks?.length || gate.checks.some(c=>c.passed!==true) || gate.datasetSha256 !== hash(fixtureBytes)) throw new Error('Development gate did not pass');
  const approved = await readPublicLiveReport(path.resolve(root, gate.report));
  if (JSON.stringify(approved.productionSha256) !== JSON.stringify(gate.productionSha256) || approved.binarySha256 !== gate.binarySha256) throw new Error('Gate artifact mismatch');
}

const binary = options.binary;
const productionDirectory = path.join(options.productionSourceRoot, 'crates/core/src');
const frozenMemoryReport = options.frozenMemoryRun ? await readPublicLiveReport(options.frozenMemoryRun) : null;
if (frozenMemoryReport && (frozenMemoryReport.datasetSha256 !== hash(fixtureBytes) || frozenMemoryReport.complete !== true || frozenMemoryReport.model !== model)) throw new Error('Frozen memory source must be a complete same-model dataset report');
const frozenFiles = (await readdir(productionDirectory, { recursive: true })).filter(f => f.endsWith('.rs')).sort();
const fingerprints = Object.fromEntries(await Promise.all(frozenFiles.map(async f => [f, hash(await readFile(path.join(productionDirectory, f)))])));
const evidenceResumeRoot = options.resume ? path.resolve(options.resume) : null;
if (evidenceResumeRoot && !evidenceResumeRoot.startsWith(path.join(root, `.local-data/${paragraphControl ? 'public-memory-control-' : 'public-memory-live-'}`))) throw new Error('Invalid isolated resume directory');
const resumeEvidence = evidenceResumeRoot ? JSON.parse(await readFile(path.join(evidenceResumeRoot, 'progress.json'))) : null;
const currentRoundTag = options.tag ?? resumeEvidence?.outputTag;
const targetedBudgetRound = currentRoundTag?.startsWith('qa-structured-');
if (!targetedBudgetRound) throw new Error('Dedicated structured harness accepts only qa-structured tags');
const calibratedBudgetRound = currentRoundTag?.startsWith('qa-calibrated-');
const cumulativeBudgetRound = calibratedBudgetRound || targetedBudgetRound;
const cumulativePriorFile = priorIndex >= 0 ? path.resolve(process.argv[priorIndex + 1]) : resumeEvidence?.priorBudgetLedger?.entries.at(-1)?.file;
const targetedBudget = targetedBudgetRound ? await prepareQaStructuredBudget(root, { split: options.split, priorFile: cumulativePriorFile,
  model, datasetSha256: hash(fixtureBytes), before: resumeEvidence?.startedAt ?? new Date().toISOString(), currentTag: currentRoundTag,
  maxRequests: options.maxRequests, maxTokens: options.maxTokens }) : null;
const priorBudgetLedger = targetedBudget?.ledger ?? (calibratedBudgetRound && cumulativePriorFile ? await buildPriorRunLedger(root, cumulativePriorFile,
  { datasetSha256: hash(fixtureBytes), model, tagPrefix: 'qa-calibrated-dev', split: 'development' }) : null);
const addendumFile = options.budgetAddendum ?? resumeEvidence?.budgetAuthorization?.file;
if (addendumFile && targetedBudgetRound) throw new Error('Targeted is an independent registered round; no budget addendum');
if (addendumFile && !cumulativeBudgetRound) throw new Error('Budget addendum belongs only to the calibrated round');
const budgetExtension = addendumFile ? await loadBudgetAddendum(root, addendumFile,
  { ledger: options.split === 'development' ? priorBudgetLedger : null, before: resumeEvidence?.startedAt ?? new Date().toISOString() }) : null;
if (budgetExtension && options.split === 'development' && !priorBudgetLedger) throw new Error('Extended development must include the complete prior-run chain');
if (budgetExtension && (budgetExtension.base.datasetSha256 !== hash(fixtureBytes) || budgetExtension.base.model !== model)) throw new Error('Budget authorization dataset/model mismatch');
if (cumulativeBudgetRound && options.split !== 'development' && priorBudgetLedger) throw new Error('Full-run budget is separate from development; omit --prior-run');
const effectiveBudget = targetedBudget ? targetedBudget.registeredLimits : cumulativeBudgetRound ? options.split === 'development'
  ? budgetExtension?.authorization.effectiveDevelopmentLimits ?? { maxRequests: 600, maxTokens: 3000000 }
  : { maxRequests: 2000, maxTokens: 12000000 } : null;
const cumulativeLimits = targetedBudget?.limits ?? (cumulativeBudgetRound ? remainingRunBudget({ maxRequests: options.maxRequests, maxTokens: options.maxTokens,
  ledger: priorBudgetLedger, immediatePrior: prior, effectiveLimits: effectiveBudget }) : null);
const evaluationRound = { name: 'qa-structured', files: qaStructuredEvaluationFiles, fingerprint: fingerprintQaStructuredEvaluation };
const evaluationFingerprints = await evaluationRound.fingerprint(root);
await mkdir(path.join(root, '.local-data'), { recursive: true });
const resume = options.resume ? path.resolve(options.resume) : null;
const runPrefix = 'public-memory-live-';
const registeredComparison = options.diagnosticArm === 'candidate' ? null : options.split === 'all' ? targetedBudget.registration.baselineFull : targetedBudget.registration.baselineDevelopment;
if (registeredComparison && (path.resolve(root, registeredComparison.file) !== options.baseline || hash(await readFile(options.baseline)) !== registeredComparison.sha256)) throw new Error('Baseline must be the exact registered comparison before provider calls');
if (options.diagnosticArm === 'baseline' && (path.resolve(root, targetedBudget.registration.baselineBinary.file) !== binary || hash(await readFile(binary)) !== targetedBudget.registration.baselineBinary.sha256
    || path.resolve(root, targetedBudget.registration.baselineBinary.sourceRoot) !== options.productionSourceRoot)) throw new Error('Diagnostic baseline must actually execute registered old binary and source snapshot');
if (options.frozenMemoryRun && (path.resolve(root, targetedBudget.registration.diagnosticFrozenMemory.file) !== options.frozenMemoryRun
    || hash(await readFile(options.frozenMemoryRun)) !== targetedBudget.registration.diagnosticFrozenMemory.sha256)) throw new Error('Diagnostic frozen-memory anchor differs from registration');
if (options.diagnosticArm === 'candidate' && (baseline.outputTag !== 'qa-structured-diag-baseline' || baseline.diagnostic?.arm !== 'baseline' || baseline.complete !== true
    || baseline.diagnostic.frozenReportSha256 !== hash(await readFile(options.frozenMemoryRun)))) throw new Error('Candidate diagnostic must compare freshly executed baseline arm on identical confirmed memories');
if (options.noApiDryRun) {
  console.log(JSON.stringify({ dryRun: true, providerRequests: 0, tag: currentRoundTag, split: options.split, binarySha256: hash(await readFile(binary)),
    productionFiles: frozenFiles.length, evaluationFiles: evaluationRound.files.length, limits: cumulativeLimits, priorBudgetLedger,
    diagnostic: options.diagnosticArm, frozenMemoryPapers: frozenMemoryReport?.documents.length ?? 0 }));
  process.exit(0);
}
if (resume && !resume.startsWith(path.join(root, `.local-data/${runPrefix}`))) throw new Error('Invalid isolated resume directory');
const preLiveEvidence = await verifyStructuredPreLive(root, { productionSha256:fingerprints, binarySha256:hash(await readFile(binary)), evaluationSha256:evaluationFingerprints, diagnosticArm:options.diagnosticArm, registration:targetedBudget.registration, before:new Date().toISOString() });
const runRoot = resume || await mkdtemp(path.join(root, `.local-data/${runPrefix}`));
const report = resume ? JSON.parse(await readFile(path.join(runRoot, 'progress.json'))) : {
  preLiveEvidence, version: 'qasper-production-live-v2', outputTag: options.tag, split: options.split, judgeMode: options.judges, expectedQuestions: selected.questionCount, expectedPapers: selected.documents.length, paragraphControl, startedAt: new Date().toISOString(), model,
  datasetSha256: hash(fixtureBytes), provenance: fixture.provenance, productionSha256: fingerprints,
  evaluationSha256: evaluationFingerprints,
  binarySha256: hash(await readFile(binary)), workspace: path.relative(root, runRoot),
  limits: { ...(cumulativeLimits ?? { requests: options.maxRequests - (prior?.receipts.length || 0), observedTotalTokens: options.maxTokens - (prior?.usage.total_tokens || 0) }), concurrentWorkers: options.workers, automaticRetries: 0 },
  baseline: { file: path.relative(root, options.baseline), workspace: baseline.workspace, binarySha256: baseline.binarySha256 },
  gate: options.requiredGate ? path.relative(root, path.resolve(root, options.requiredGate)) : null,
  priorRun: prior ? { workspace: prior.workspace, requests: prior.receipts.length, totalTokens: prior.usage.total_tokens } : null,
  ...(cumulativeBudgetRound ? { priorBudgetLedger, budgetAuthorization: budgetExtension?.authorization ?? null } : {}),
  ...(targetedBudget ? { budgetRegistration: targetedBudget.budgetRegistration } : {}),
  methodology: paragraphControl
    ? 'DIAGNOSTIC CONTROL ONLY, not end-to-end extraction. All original paper paragraphs confirmed unchanged as facts, without using questions, answers or evidence labels to select them. No extracted facets. Actual production retrieval/generation/review for both entries. Separates downstream capability from the extraction bottleneck. Same-model post-hoc judge sees human gold, not independent human validation.'
    : 'Full papers, question-independent production extraction. Unedited memory proposals explicitly confirmed in an isolated workspace, simulating user approval. Maintenance disabled. No gold facts seeded. Two actual production QA entries per question. Gold only enters a separate post-hoc judge. Same-model judge is not independent human validation. Source paragraph evidence coverage is provenance coverage, not semantic recall.',
  ...(options.diagnosticArm ? { diagnostic: { kind: 'fixed-confirmed-memory-qa-only', arm: options.diagnosticArm, frozenReport: path.relative(root, options.frozenMemoryRun), frozenReportSha256: hash(await readFile(options.frozenMemoryRun)),
    suppliedPackFrozen: false, interpretation: 'Same confirmed content/facets/provenance. Actual production retrieval and packing may differ. Baseline arm executes old binary now, not historical answers; candidate arm uses unchanged anonymous separated judges for both fresh systems.' } } : {}),
  documents: [], judgments: [], receipts: [],
};
if (options.diagnosticArm) report.methodology = 'DIAGNOSTIC ONLY: frozen confirmed memory QA through separately executed old/current binaries. No new extraction and no historical answers borrowed. Actual supplied packs may differ; candidate arm independently grades both fresh answers anonymously. Does not qualify for development gate.';
if (options.requiredGate) {
  const gate = JSON.parse(await readFile(path.resolve(root, options.requiredGate)));
  if (JSON.stringify(fingerprints) !== JSON.stringify(gate.productionSha256) || report.binarySha256 !== gate.binarySha256) throw new Error('Production changed after development gate');
  if (gate.evaluationSha256 && JSON.stringify(evaluationFingerprints) !== JSON.stringify(gate.evaluationSha256)) throw new Error('Evaluation rules or pre-registration changed after development gate');
  if (targetedBudgetRound && (gate.version !== 'memory-qa-structured-development-gate-v1'
      || budgetCanonical(gate.budgetRegistration) !== budgetCanonical(targetedBudget.budgetRegistration))) throw new Error('Targeted full requires its passing gate and identical independent budget registration');
}
if (resume && (report.split !== options.split || report.judgeMode !== options.judges || (options.tag && report.outputTag !== options.tag))) throw new Error('Resume split/judges/tag mismatch');
if (resume && cumulativeBudgetRound && (budgetCanonical(report.priorBudgetLedger ?? null) !== budgetCanonical(priorBudgetLedger)
    || budgetCanonical(report.budgetAuthorization ?? null) !== budgetCanonical(budgetExtension?.authorization ?? null))) throw new Error('Resume cumulative ledger or budget addendum changed');
if (resume && targetedBudgetRound && budgetCanonical(report.budgetRegistration) !== budgetCanonical(targetedBudget.budgetRegistration)) throw new Error('Resume targeted registration changed');
if (!resume) {
  await writeFile(path.join(runRoot, 'receipts.jsonl'), '', { flag: 'wx' });
  try { await access(publicReportPath(root, report)); throw new Error('Output already exists; use a fresh --output-tag or explicit --resume'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const snapshot = path.join(runRoot, 'production');
  await mkdir(snapshot, { recursive: true });
  for (const name of frozenFiles) { await mkdir(path.dirname(path.join(snapshot, name)), { recursive: true }); await cp(path.join(productionDirectory, name), path.join(snapshot, name)); }
  await cp(binary, path.join(snapshot, path.basename(binary)));
  report.productionSnapshot = path.relative(root, snapshot);
  const evaluationSnapshot = path.join(runRoot, 'evaluation');
  for (const file of evaluationRound.files) {
    await mkdir(path.dirname(path.join(evaluationSnapshot, file)), { recursive: true });
    await cp(path.join(root, file), path.join(evaluationSnapshot, file));
  }
  report.evaluationSnapshot = path.relative(root, evaluationSnapshot);
}
if (report.model !== model || report.datasetSha256 !== hash(fixtureBytes) || JSON.stringify(report.productionSha256) !== JSON.stringify(fingerprints)) throw new Error('Resume model/data/production mismatch');
if (report.evaluationSha256 && JSON.stringify(report.evaluationSha256) !== JSON.stringify(evaluationFingerprints)) throw new Error('Resume evaluation rules or pre-registration mismatch');
const repairPlan = options.repairFailedJudges ? failedJudgeRepairPlan(report, selected.documents) : null;
const receipts = report.receipts, tokens = new Map(), active = new Map(), hosts = new Set(), raw = new Map();
if (resume) {
  for (const line of (await readFile(path.join(runRoot, 'receipts.jsonl'), 'utf8')).split('\n').filter(Boolean)) {
    const r = JSON.parse(line); raw.set(r.index, r);
  }
  report.resumedAt = new Date().toISOString();
}
let haltReason = null, writes = Promise.resolve();
const spent = () => receipts.reduce((n, r) => n + (r.usage?.total_tokens || 0), 0);
function serialize(value) {
  const s = JSON.stringify(value);
  if (s.includes(key)) throw new Error('Refusing to persist credentials');
  return s;
}
function checkpoint() {
  const snapshot = serialize(report);
  writes = writes.then(() => writeFile(path.join(runRoot, 'progress.json'), snapshot));
  return writes;
}
const proxy = http.createServer(async (req, res) => {
  const group = tokens.get(req.headers.authorization);
  if (!group || req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(403).end(); return; }
  if (haltReason || receipts.length >= report.limits.requests || spent() >= report.limits.observedTotalTokens) {
    haltReason ||= 'Evaluation call/token limit'; res.writeHead(503).end('{"error":{"message":"Evaluation budget exhausted"}}'); return;
  }
  const receipt = { index: receipts.length + 1, group, ...active.get(group), startedAt: new Date().toISOString() };
  receipts.push(receipt);
  const started = Date.now(); let body, responseText;
  try {
    let text = '';
    for await (const c of req) { text += c; if (text.length > 2 * 1024 * 1024) throw new Error('Request too large'); }
    body = JSON.parse(text);
    if (body.model !== model || body.stream !== false) throw new Error('Unexpected request model/stream');
    body.thinking = { type: 'disabled' }; // Same as the official DeepSeek adapter.
    const user = JSON.parse(body.messages.at(-1).content);
    const schema = capturedEvaluationSchema(body, user);
    if (receipt.phase !== 'judge') assertNoProductionGold(user);
    receipt.task = receipt.phase === 'extraction' ? 'extraction'
      : receipt.phase === 'judge' ? 'diagnostic_judge'
        : schema.required?.includes('queries') ? 'query_rewrite'
          : (schema.required?.includes('unsupportedClaims') || schema.required?.includes('claimReviews')) ? 'answer_review' : 'generation';
    receipt.requestSha256 = hash(JSON.stringify(body)); receipt.inputChars = JSON.stringify(body).length;
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000), redirect: 'error',
    });
    responseText = await response.text();
    if (Buffer.byteLength(responseText) > 2 * 1024 * 1024) throw new Error('Response too large');
    receipt.status = response.status;
    if (response.ok) {
      const value = JSON.parse(responseText);
      receipt.actualModel = value.model; receipt.usage = value.usage ?? null;
      receipt.finishReason = value.choices?.[0]?.finish_reason;
    } else { haltReason = `Upstream HTTP ${response.status}`; receipt.error = haltReason; }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(responseText);
  } catch (error) {
    haltReason = clean(error.message); receipt.error = haltReason;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Evaluation upstream failed"}}');
  } finally {
    receipt.elapsedMs = Date.now() - started;
    const record = { ...receipt, request: body, responseText };
    raw.set(receipt.index, record);
    const line = serialize(record) + '\n';
    writes = writes.then(() => appendFile(path.join(runRoot, 'receipts.jsonl'), line));
    await checkpoint();
    log(`API ${receipt.index} ${receipt.paperId || ''} ${receipt.task} ${receipt.status ?? 'ERROR'} finish=${receipt.finishReason || ''} tokens=${receipt.usage?.total_tokens || 0}`);
  }
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
function credential(group) { const token = randomUUID(); tokens.set(`Bearer ${token}`, group); return token; }
function startHost(workspace) {
  const runBinary = path.join(root, report.productionSnapshot || path.join(report.workspace, 'production'), path.basename(binary));
  const child = spawn(runBinary, [workspace], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  const reject = e => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  child.on('error', reject); child.on('exit', () => reject(new Error('Host exited')));
  child.stderr.on('data', b => process.stderr.write(clean(b.toString())));
  lines.on('line', line => {
    const reply = JSON.parse(line), p = pending.get(reply.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(reply.id);
    reply.ok ? p.resolve(reply.data) : p.reject(Object.assign(new Error(reply.error.message), reply.error));
  });
  const host = {
    call(command, payload = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 190000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
      });
    },
    async stop() { hosts.delete(host); if (child.exitCode !== null || child.signalCode !== null) return; const end = once(child, 'exit'); child.kill('SIGTERM'); await end; lines.close(); },
  };
  hosts.add(host); return host;
}
async function configure(host, group) {
  await host.call('save_ai_settings', { provider: 'openai_compatible', baseUrl, model, outputFormat: 'json_object', timeoutSeconds: 120, autoExtract: false, remoteConsent: false, apiKey: credential(group) });
  await host.call('save_memory_maintenance', { enabled: false, idleSeconds: 120, dailyCalls: 100, autoNew: false });
}
function modelOutput(r) { try { return JSON.parse(JSON.parse(r.responseText).choices[0].message.content); } catch { return null; } }
function userInput(r) { try { return JSON.parse(r.request.messages.at(-1).content); } catch { return {}; } }
function references(r) { return capturedEvaluationReferences(userInput(r)); }
const receiptIds = (group, phase, questionId, entry) => receipts.filter(r => r.group === group && r.phase === phase && (!questionId || r.questionId === questionId) && (!entry || r.entry === entry)).map(r => r.index);
async function runPaper(doc, index) {
  if (options.repairFailedJudges) throw new Error('Production execution is forbidden during judge-only repair');
  let result = report.documents.find(d => d.id === doc.id);
  // Retry only setup that failed before any project/source/model request. A
  // model job, failed or interrupted, is never resubmitted automatically.
  if (result?.harnessError && !result.projectId) {
    report.setupCorrections ||= [];
    report.setupCorrections.push({ paperId: doc.id, previousError: result.harnessError, reason: 'Clip project display name to the production 100-character limit; original full title remains the source title.' });
    report.documents.splice(report.documents.indexOf(result), 1); result = null;
  }
  if (result?.complete || haltReason) return;
  const group = doc.id, workspace = path.join(runRoot, `paper-${index}`);
  if (frozenMemoryReport && !result) {
    const frozenPaper = frozenMemoryReport.documents.find(p => p.id === doc.id);
    if (!frozenPaper || frozenPaper.confirmed !== true || frozenPaper.qaReadOnly !== true) throw new Error('Frozen paper must contain unchanged confirmed memory');
    const copied = await copyFrozenPaperWorkspace(root, frozenPaper, workspace);
    result = { ...structuredClone(frozenPaper), workspace: path.relative(root, workspace), questions: [], complete: false, qaReadOnly: undefined,
      frozenMemory: copied, extraction: { ...structuredClone(frozenPaper.extraction), skipped: true, diagnosticControl: true, receiptIds: [], historicalReceiptIds: frozenPaper.extraction.receiptIds } };
    report.documents.push(result);
    await checkpoint();
  }
  const host = startHost(workspace);
  try {
    await configure(host, group);
    if (frozenMemoryReport) await assertFrozenHostMemory(host, result);
    if (!result) {
      result = { id: doc.id, split: doc.split, title: doc.title, workspace: path.relative(root, workspace), questions: [], memories: [] };
      report.documents.push(result);
      const project = await host.call('create_project', { name: Array.from(doc.title).slice(0, 100).join('') }); result.projectId = project.id;
      // One source line per original paragraph. Markers carry no answer labels.
      const sourceText = doc.paragraphs.map(p => `[[QASPER:${p.id}]] ${p.content.replace(/[\r\n]+/g, ' ')}`).join('\n');
      result.sourceSha256 = hash(sourceText);
      const imported = await host.call('import_text', { projectId: project.id, title: doc.title, text: sourceText });
      let source;
      for (let i = 0; i < 1200; i++) {
        source = await host.call('get_source', { sourceId: imported.sourceId });
        if (source.source.status === 'ready') break;
        if (source.source.status === 'failed') throw new Error('Parsing failed');
        await sleep(50);
      }
      if (source.source.status !== 'ready') throw new Error('Parsing timed out');
      result.sourceId = source.source.id;
      result.segments = source.segments.map(s => ({ id: s.id, text: s.text, paragraphId: s.text.match(/\[\[QASPER:(.*?)\]\]/)?.[1] ?? null }));
      if (paragraphControl) {
        for (const p of doc.paragraphs) {
          const segment = result.segments.find(s => s.paragraphId === p.id);
          if (!segment) throw new Error('Paragraph provenance mapping failed');
          const proposal = await host.call('create_proposal', { projectId: project.id, sourceId: result.sourceId, segmentIds: [segment.id], kind: 'fact', content: p.content });
          const m = await host.call('confirm_proposal', { proposalId: proposal.id });
          result.memories.push({ id: m.id, content: p.content, facets: {}, quotes: [{ segmentId: segment.id, quote: segment.text }], paragraphId: p.id });
        }
        result.extraction = { skipped: true, diagnosticControl: true, job: { status: 'not_measured' }, receiptIds: [], proposals: [], taskProposals: [] };
        result.confirmed = true;
      } else {
      active.set(group, { phase: 'extraction', paperId: doc.id });
      const start = Date.now(), job = await host.call('start_extraction', { sourceId: result.sourceId });
      result.jobId = job.id; await checkpoint();
      let state, terminal;
      for (;;) {
        state = await host.call('get_state'); terminal = state.jobs.find(j => j.id === job.id);
        if (['succeeded', 'failed', 'cancelled'].includes(terminal?.status)) break;
        if (Date.now() - start > 3600000) throw new Error('Extraction evaluation timed out');
        await sleep(500);
      }
      result.extraction = { elapsedMs: Date.now() - start, job: terminal, receiptIds: receiptIds(group, 'extraction'),
        proposals: state.proposals.filter(p => p.sourceId === result.sourceId), taskProposals: state.taskProposals.filter(p => p.sourceId === result.sourceId),
        autoCreatedMemories: state.memories.filter(m => m.projectId === project.id).length };
      }
      await checkpoint();
    }
    if (!result.extraction) {
      // An interrupted job is observed, never automatically submitted again.
      const state = await host.call('get_state');
      result.extraction = { interrupted: true, job: state.jobs.find(j => j.id === result.jobId), receiptIds: receiptIds(group, 'extraction'), proposals: state.proposals.filter(p => p.sourceId === result.sourceId), taskProposals: [] };
    }
    if (!result.confirmed) {
      const state = await host.call('get_state');
      result.extractionDrafts = (state.extractionDrafts ?? []).filter(d => d.sourceId === result.sourceId);
      for (const p of result.extraction.proposals) {
        const current = state.proposals.find(c => c.id === p.id);
        const draft = result.extractionDrafts.find(d => d.proposalId === p.id);
        if (draft && !['ready', 'reviewed'].includes(draft.status)) { haltReason = 'Unreviewed extraction draft linked to a confirmable proposal'; throw new Error(haltReason); }
        if (['needs_review', 'review_required'].includes(current?.status) || current?.requiresReview || current?.reviewRequired) continue;
        if (current?.status === 'pending' || !current?.status) {
          const m = await host.call('confirm_proposal', { proposalId: p.id });
          if (!result.memories.some(x => x.id === m.id)) result.memories.push({ ...p, proposalId: p.id, id: m.id, detail: await host.call('get_memory', { memoryId: m.id }) });
        }
      }
      result.confirmed = true; await checkpoint();
      log(`PAPER ${doc.id} extraction=${result.extraction.job?.status} memories=${result.memories.length}`);
    }
    const before = await host.call('get_state');
    result.extractionDrafts = (before.extractionDrafts ?? before.drafts ?? []).filter(d => d.sourceId === result.sourceId || d.jobId === result.jobId);
    result.extractionBatches = (before.extractionBatches ?? before.batches ?? []).filter(b => b.sourceId === result.sourceId || b.jobId === result.jobId);
    result.reviewBlocked = result.extractionDrafts.filter(d => ['needs_review', 'review_required'].includes(d.status)).map(d => ({ id: d.id, issues: d.issues }));
    if (result.extractionDrafts.some(d => ['needs_review', 'review_required'].includes(d.status) && d.proposalId && result.memories.some(m => m.proposalId === d.proposalId))) { haltReason = 'Unreviewed extraction draft entered formal memory'; throw new Error(haltReason); }
    for (const q of doc.queries) {
      let qr = result.questions.find(x => x.id === q.id);
      if (!qr) { qr = { id: q.id, question: q.question, answerable: q.answerable, entries: {} }; result.questions.push(qr); }
      for (const [entry, command] of [['desktop', 'ask_assistant'], ['connector', 'ask_project']]) {
        if (qr.entries[entry] || haltReason) continue;
        active.set(group, { phase: 'qa', paperId: doc.id, questionId: q.id, entry });
        const start = Date.now(); let value;
        try { value = { result: await host.call(command, { projectId: result.projectId, question: q.question, date: '2026-10-20', asOfDate: '2026-10-20', useModel: true }) }; }
        catch (e) { value = { error: clean(e.message), errorCode: e.code ?? null }; }
        value.elapsedMs = Date.now() - start; value.receiptIds = receiptIds(group, 'qa', q.id, entry);
        value.generations = value.receiptIds.map(id => raw.get(id)).filter(r => r?.task === 'generation').map(r => ({ receiptId: r.index, references: references(r), rawReferences: userInput(r).references ?? userInput(r).context?.memories ?? [], output: modelOutput(r) }));
        if (value.result) { try { value.producerProvenance = validateStructuredClaimProvenance(value); value.evaluationProducerReferences = selectedEvaluationReferences(value); } catch(e) { value.provenanceFailure = clean(e.message); haltReason = 'Structured producer provenance failure'; } }
        value.rewrites = value.receiptIds.map(id => raw.get(id)).filter(r => r?.task === 'query_rewrite').map(r => modelOutput(r));
        const ids = new Set(result.memories.map(m => m.id));
        value.scopeViolation = (value.result?.citations ?? []).some(c => c.memoryId && !ids.has(c.memoryId));
        if (value.scopeViolation) haltReason = 'Cross-project citation detected';
        qr.entries[entry] = value; await checkpoint();
        log(`QA ${doc.id} ${q.id.slice(0, 8)} ${entry} ${value.errorCode || value.result?.status || 'ok'}`);
      }
    }
    const after = await host.call('get_state');
    result.qaReadOnly = JSON.stringify([before.memories, before.tasks, before.proposals, before.extractionDrafts]) === JSON.stringify([after.memories, after.tasks, after.proposals, after.extractionDrafts]);
    if (frozenMemoryReport) { await assertFrozenHostMemory(host, result); if (frozenMemorySemanticHash(result) !== result.frozenMemory.semanticSha256) throw new Error('Diagnostic memory report mutated'); }
    result.complete = result.questions.length === doc.queries.length && result.questions.every(q => Object.keys(q.entries).length === 2);
    await checkpoint();
  } catch (e) { result ||= { id: doc.id, split: doc.split, memories: [], questions: [] }; result.harnessError = clean(e.message); if (!report.documents.includes(result)) report.documents.push(result); await checkpoint(); }
  finally { await host.stop(); }
}
async function parallel(items, fn, count = report.limits.concurrentWorkers) {
  let cursor = 0;
  await Promise.all(Array.from({ length: count }, async () => { while (cursor < items.length && !haltReason) { const i = cursor++; await fn(items[i], i); } }));
}
async function judgeTask({ doc, paper, q }, task, repairOnly = false) {
  if (haltReason) return { value: { error: 'Evaluation halted before judge', errorKind: 'transport' }, used: [] };
  const group = `judge-${q.id}-${task.phase}${repairOnly ? '-repair-1' : ''}`, token = credential(group);
  active.set(group, { phase: 'judge', judgeStage: task.phase, paperId: doc.id, questionId: q.id, ...(repairOnly ? { evaluationRepair: true } : {}) });
  let value;
  try {
    const formatOnly = repairOnly ? ' Format-only repair: return strictly parseable JSON. Use short plain English reasons without quotation marks, backslashes or embedded newlines inside string values. The evaluation criteria are unchanged.' : '';
    const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, max_tokens: 4096, temperature: 0, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: task.system + formatOnly }, { role: 'user', content: JSON.stringify(task.input) },
      ] }), signal: AbortSignal.timeout(130000) });
    if (!response.ok) throw new Error(`Judge HTTP ${response.status}`);
    const data = await response.json();
    try {
      if (typeof data.choices?.[0]?.message?.content !== 'string') throw new Error('Judge response schema');
      const parsed = parseIsolatedJudgeResponse(data.choices[0].message.content, task, new Set(paper.memories.map(m => m.id)), data.choices[0].finish_reason);
      value = parsed.value;
      if (parsed.repair) {
        const receiptId = receipts.findLast(r => r.group === group)?.index;
        (report.evaluationSyntaxRepairs ||= []).push({ questionId: q.id, paperId: doc.id, stage: task.phase, receiptId, ...parsed.repair });
      }
      if (parsed.envelopeNormalization) {
        const receiptId = receipts.findLast(r => r.group === group)?.index;
        (report.evaluationEnvelopeNormalizations ||= []).push({ questionId: q.id, paperId: doc.id, stage: task.phase, receiptId, ...parsed.envelopeNormalization });
      }
    } catch (error) { value = { error: clean(error.message), errorKind: 'protocol' }; }
  } catch (error) { value = { error: clean(error.message), errorKind: 'transport' }; }
  return { value, used: receipts.filter(r => r.group === group).map(r => r.index) };
}
async function judgeQuestion({ doc, paper, q }) {
  if (report.judgments.some(j => j.id === q.id) || haltReason) return;
  const actual = paper.questions.find(x => x.id === q.id);
  if (!actual) return;
  const baselineActual = baseline.documents.find(d => d.id === doc.id)?.questions.find(x => x.id === q.id);
  const tasks = isolatedJudgeTasks({ doc, paper, question: q, actual, baselineActual, mode: report.judgeMode });
  const values = {}, used = [];
  for (const task of tasks) {
    const result = await judgeTask({ doc, paper, q }, task);
    values[task.phase] = result.value; used.push(...result.used);
  }
  report.judgments.push({ id: q.id, paperId: doc.id, split: doc.split, answerable: q.answerable,
    ...combineIsolatedJudgments(tasks, values), receiptIds: used });
  await checkpoint(); log(`JUDGE ${report.judgments.length}/${selected.questionCount} ${q.id.slice(0, 8)}`);
}
async function repairQuestion(item) {
  if (haltReason) return;
  const doc = selected.documents.find(d => d.id === item.paperId);
  const paper = report.documents.find(d => d.id === item.paperId), q = doc.queries.find(q => q.id === item.questionId);
  const repair = beginJudgeRepair(report, item);
  await checkpoint(); // A crash still counts as this question's one explicit attempt.
  const actual = paper.questions.find(x => x.id === q.id);
  const baselineActual = baseline.documents.find(d => d.id === doc.id)?.questions.find(x => x.id === q.id);
  const tasks = isolatedJudgeTasks({ doc, paper, question: q, actual, baselineActual, mode: report.judgeMode });
  if (item.phases.some(p => !tasks.some(t => t.phase === p))) throw new Error('Repair phase not present in frozen judge tasks');
  const values = structuredClone(repair.previousJudgment.stages);
  for (const task of tasks.filter(t => item.phases.includes(t.phase))) {
    const result = await judgeTask({ doc, paper, q }, task, true);
    values[task.phase] = result.value; repair.newReceiptIds.push(...result.used);
    await checkpoint();
  }
  const replacement = { id: q.id, paperId: doc.id, split: doc.split, answerable: q.answerable,
    ...combineIsolatedJudgments(tasks, values), receiptIds: [...repair.previousJudgment.receiptIds, ...repair.newReceiptIds] };
  report.judgments[report.judgments.findIndex(j => j.id === q.id)] = replacement;
  repair.completedAt = new Date().toISOString();
  await checkpoint(); log(`JUDGE_REPAIR ${q.id.slice(0, 8)} phases=${item.phases.join(',')} status=${replacement.error ? 'failed' : 'complete'}`);
}

try {
  log(`START model=${model} papers=${selected.documents.length} questions=${selected.questionCount} workspace=${runRoot}`);
  await checkpoint();
  if (options.repairFailedJudges) {
    log(`REPAIR_ONLY questions=${repairPlan.length} phases=${repairPlan.reduce((n, p) => n + p.phases.length, 0)} remainingRequests=${report.limits.requests - receipts.length}`);
    await parallel(repairPlan, repairQuestion);
  } else {
    await parallel(selected.documents, runPaper);
    if (options.diagnosticArm !== 'baseline') await parallel(selected.documents.flatMap(doc => { const paper = report.documents.find(p => p.id === doc.id); return paper ? doc.queries.map(q => ({ doc, paper, q })) : []; }), judgeQuestion);
  }
} catch (e) { report.fatalError = clean(e.message); process.exitCode = 1; }
finally {
  await Promise.allSettled([...hosts].map(h => h.stop()));
  await new Promise(resolve => proxy.close(resolve)); await writes;
  report.haltReason = haltReason; report.finishedAt = new Date().toISOString();
  report.usage = receipts.reduce((sum, r) => { for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) sum[field] = (sum[field] || 0) + (r.usage?.[field] || 0); return sum; }, { prompt_tokens:0, completion_tokens:0, total_tokens:0, prompt_cache_hit_tokens:0, prompt_cache_miss_tokens:0 });
  report.actualModels = [...new Set(receipts.map(r => r.actualModel).filter(Boolean))];
  report.productionUnchanged = (await Promise.all(frozenFiles.map(async f => hash(await readFile(path.join(productionDirectory, f))) === fingerprints[f]))).every(Boolean);
  report.binaryUnchanged = hash(await readFile(binary)) === report.binarySha256;
  report.evaluationUnchanged = JSON.stringify(await evaluationRound.fingerprint(root)) === JSON.stringify(evaluationFingerprints);
  report.complete = report.documents.length === selected.documents.length && report.documents.every(d => d.complete) && (options.diagnosticArm === 'baseline' ? report.judgments.length === 0 : report.judgments.length === selected.questionCount && report.judgments.every(j => !j.error));
  await checkpoint();
  serialize(report); // Credential guard also covers the detailed artifact.
  await savePublicLiveReport(report);
  log(`DONE complete=${report.complete} requests=${receipts.length} tokens=${spent()} halted=${haltReason || 'no'}`);
  if (haltReason || report.fatalError || !report.complete) process.exitCode = 1;
}
