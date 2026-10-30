// One technical continuation of the existing v2 attempt, never a fresh run.
// Default: read-only preflight. Only --execute permits the four first requests.
import { readFile, writeFile, appendFile, mkdir, readdir, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicLiveReport, savePublicLiveReport } from './memory-public-live-io.mjs';
import { selectPublicDocuments, publicReportPath } from './memory-public-live-options.mjs';
import { isolatedJudgeTasks, parseIsolatedJudgeResponse, combineIsolatedJudgments, validateIsolatedJudgment } from './memory-qa-structured-judges.mjs';
import { budgetCanonical } from './memory-public-live-budget.mjs';
import { fingerprintArchitectureEvaluation, prepareArchitectureBudget, verifyArchitecturePreLive,
  validateArchitectureReferences, architectureRequestReservation } from './memory-architecture-evaluation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workspace = path.join(root, '.local-data/memory-architecture-live-t4w3So');
const scriptFile = path.join(root, 'scripts/continue-memory-architecture-missing-judges.mjs');
const archiveDirectory = path.join(workspace, 'technical-continuation-1');
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => budgetCanonical(a) === budgetCanonical(b);
const usageFields = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'];
const sumUsage = receipts => receipts.reduce((sum, receipt) => {
  for (const field of usageFields) sum[field] += receipt.usage?.[field] || 0;
  return sum;
}, Object.fromEntries(usageFields.map(field => [field, 0])));

export function originalJudgeBody(model, task) {
  return { model, stream: false, max_tokens: 4096, temperature: 0, response_format: { type: 'json_object' }, messages: [
    { role: 'system', content: task.system }, { role: 'user', content: JSON.stringify(task.input) },
  ], thinking: { type: 'disabled' } };
}

export function planMissingJudges(report, rawReceipts, documents, baseline) {
  if (report.outputTag !== 'qa-architecture-dev-v2' || report.split !== 'development' || report.judgeMode !== 'separated'
      || report.complete !== false || report.technicalContinuation || report.fatalError
      || report.haltReason !== 'Architecture request/token reservation limit'
      || report.limits?.requests !== 300 || report.limits?.observedTotalTokens !== 1600000
      || report.limits?.automaticRetries !== 0) throw new Error('Only the original budget-blocked v2 attempt may continue');
  if (documents.reduce((n, d) => n + d.queries.length, 0) !== 20 || report.judgments.length !== 20
      || report.documents.length !== documents.length || report.documents.some(d => d.complete !== true)) throw new Error('All 40 QA entries and 20 judgments must already exist');
  if (rawReceipts.length !== report.receipts.length) throw new Error('Raw/report receipt lengths differ');
  if (new Set(rawReceipts.map(r => r.index)).size !== rawReceipts.length) throw new Error('Duplicate raw receipt index');
  rawReceipts.forEach(raw => {
    const { request, responseText, ...receipt } = raw;
    if (!Number.isSafeInteger(raw.index) || raw.index < 1 || raw.index > report.receipts.length
        || !equal(receipt, report.receipts[raw.index - 1]) || hash(JSON.stringify(request)) !== raw.requestSha256
        || !Number.isSafeInteger(raw.usage?.total_tokens) || raw.usage.total_tokens < 0 || raw.error)
      throw new Error('Existing raw/report receipt evidence or usage is incomplete');
  });
  if (!equal(sumUsage(report.receipts), report.usage)) throw new Error('Existing aggregate usage differs');
  const items = [];
  for (const doc of documents) {
    const paper = report.documents.find(d => d.id === doc.id);
    if (!paper || paper.questions.length !== doc.queries.length) throw new Error('Production question coverage differs');
    for (const q of doc.queries) {
      const actual = paper.questions.find(a => a.id === q.id);
      if (!actual || !actual.entries?.desktop?.result || !actual.entries?.connector?.result) throw new Error('All 40 QA results must be complete');
      const judgment = report.judgments.find(j => j.id === q.id && j.paperId === doc.id);
      if (!judgment) throw new Error('Missing existing judgment');
      const tasks = isolatedJudgeTasks({ doc, paper, question: q, actual,
        baselineActual: baseline.documents.find(d => d.id === doc.id)?.questions.find(a => a.id === q.id), mode: report.judgeMode });
      for (const task of tasks) {
        const value = judgment.stages?.[task.phase];
        if (!value?.error) {
          validateIsolatedJudgment(task, value, new Set(paper.memories.map(m => m.id)));
          continue;
        }
        if (task.phase === 'answer' || value.errorKind !== 'transport') throw new Error('Only unsent memory/retrieval transport stages may continue');
        const group = `judge-${q.id}-${task.phase}`;
        if ([...rawReceipts, ...report.receipts].some(r => r.group === group || (r.questionId === q.id && r.judgeStage === task.phase)))
          throw new Error('Missing stage already has a provider receipt; refusing a repeated call');
        const body = originalJudgeBody(report.model, task);
        items.push({ doc, paper, q, tasks, task, body, plan: { questionId: q.id, paperId: doc.id, stage: task.phase,
          existingReceiptCount: 0, requestSha256: hash(JSON.stringify(body)), tokenReservation: architectureRequestReservation(body) } });
      }
    }
  }
  if (items.length !== 4 || items.filter(i => i.task.phase === 'memory').length !== 1) throw new Error('Expected exactly the four unsent v2 stages');
  // Largest reservation first; later checks use actual usage, never estimates.
  return items.sort((a, b) => b.plan.tokenReservation - a.plan.tokenReservation);
}

async function fingerprints() {
  const directory = path.join(root, 'crates/core/src');
  const files = (await readdir(directory, { recursive: true })).filter(f => f.endsWith('.rs')).sort();
  return { productionSha256: Object.fromEntries(await Promise.all(files.map(async f => [f, hash(await readFile(path.join(directory, f)))]))),
    binarySha256: hash(await readFile(path.join(root, 'target/debug/pm-host.exe'))),
    evaluationSha256: await fingerprintArchitectureEvaluation(root) };
}

export async function preflight() {
  const files = { progress: path.join(workspace, 'progress.json'), detail: path.join(workspace, 'results.json'), receipts: path.join(workspace, 'receipts.jsonl') };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(file)])));
  const report = JSON.parse(bytes.progress);
  if (path.resolve(root, report.workspace) !== workspace || report.model !== 'deepseek-flash') throw new Error('Wrong continuation workspace/model');
  files.public = publicReportPath(root, report); bytes.public = await readFile(files.public);
  if (!equal(report, JSON.parse(bytes.detail)) || !equal(report, await readPublicLiveReport(files.public))) throw new Error('Progress/full/public reports differ');
  try { await access(archiveDirectory); throw new Error('Technical continuation already attempted; automatic resume is forbidden'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/memory-public-dataset-manifest.json')));
  const fixtureBytes = await readFile(path.resolve(root, manifest.fixture));
  if (hash(fixtureBytes) !== manifest.datasetSha256 || report.datasetSha256 !== manifest.datasetSha256) throw new Error('Frozen fixture changed');
  const selected = selectPublicDocuments(JSON.parse(fixtureBytes), 'development');
  const baseline = await readPublicLiveReport(path.resolve(root, report.baseline.file));
  const budget = await prepareArchitectureBudget(root, { split: 'development', currentTag: report.outputTag,
    priorFile: path.resolve(root, report.architecture.priorReport), model: report.model, datasetSha256: report.datasetSha256,
    before: report.startedAt, resumeRoot: workspace, maxRequests: report.limits.requests, maxTokens: report.limits.observedTotalTokens });
  const frozen = await fingerprints();
  const preLiveEvidence = await verifyArchitecturePreLive(root, { currentTag: report.outputTag, ...frozen,
    registration: budget.registration, before: new Date().toISOString() });
  for (const field of ['productionSha256', 'binarySha256', 'evaluationSha256']) if (!equal(report[field], frozen[field])) throw new Error(`Frozen ${field} changed`);
  if (!equal(report.budgetRegistration, budget.budgetRegistration) || !equal(report.priorBudgetLedger, budget.ledger)
      || !equal(report.preLiveEvidence, preLiveEvidence)) throw new Error('Frozen budget/pre-live evidence changed');
  for (const paper of report.documents) for (const actual of paper.questions) validateArchitectureReferences(actual, paper);
  const raw = bytes.receipts.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const items = planMissingJudges(report, raw, selected.documents, baseline);
  if (report.receipts.length + items.length > report.limits.requests
      || report.usage.total_tokens + items[0].plan.tokenReservation > report.limits.observedTotalTokens) throw new Error('First request cannot fit existing budget');
  const scriptBytes = await readFile(scriptFile);
  const plan = { version: 'memory-architecture-technical-continuation-v1', workspace: report.workspace, outputTag: report.outputTag,
    script: path.relative(root, scriptFile), scriptSha256: hash(scriptBytes), limits: report.limits,
    initialRequests: report.receipts.length, initialTokens: report.usage.total_tokens,
    remainingTokens: report.limits.observedTotalTokens - report.usage.total_tokens, allowedStages: items.map(item => item.plan),
    automaticRetries: 0, sequential: true, freshAttempt: false, regradeCompletedStages: false,
    budgetRegistration: budget.budgetRegistration, preLiveEvidence, ...frozen };
  return { report, items, files, bytes, scriptBytes, plan };
}

async function execute(prepared, key) {
  const { report, items, files, bytes, scriptBytes, plan } = prepared;
  const clean = text => String(text).replaceAll(key, '[REDACTED]');
  const serialize = value => { const text = JSON.stringify(value); if (text.includes(key)) throw new Error('Refusing to persist credentials'); return text; };
  // Exclusive directory is also the no-retry lock, including after a crash.
  await mkdir(archiveDirectory);
  const archives = {};
  for (const [name, data] of Object.entries({ ...bytes, script: scriptBytes, plan: Buffer.from(JSON.stringify(plan, null, 2)) })) {
    const file = path.join(archiveDirectory, `${name}.${name === 'receipts' ? 'jsonl' : name === 'script' ? 'mjs' : 'json'}`);
    await writeFile(file, data, { flag: 'wx' }); await chmod(file, 0o444);
    archives[name] = { file: path.relative(root, file), sha256: hash(data), bytes: data.length };
  }
  const manifestBytes = Buffer.from(JSON.stringify({ archivedAt: new Date().toISOString(), files: archives }, null, 2));
  const archiveManifest = path.join(archiveDirectory, 'manifest.json');
  await writeFile(archiveManifest, manifestBytes, { flag: 'wx' }); await chmod(archiveManifest, 0o444);
  // Reject an original runner still writing while the archive was prepared.
  for (const [name, file] of Object.entries(files)) if (hash(await readFile(file)) !== hash(bytes[name])) throw new Error('Run changed while archiving; no requests sent');
  const protectedDocuments = hash(serialize(report.documents)), originalReceipts = structuredClone(report.receipts);
  const completedStages = report.judgments.flatMap(j => Object.entries(j.stages).filter(([, v]) => !v.error).map(([stage, value]) => ({ id: j.id, stage, value: structuredClone(value) })));
  report.technicalContinuation = { ...plan, archive: { file: path.relative(root, archiveManifest), sha256: hash(manifestBytes) },
    startedAt: new Date().toISOString(), status: 'running', addedReceiptIds: [], stages: [] };
  report.haltReason = null;
  async function checkpoint() {
    if (hash(serialize(report.documents)) !== protectedDocuments || !equal(report.receipts.slice(0, originalReceipts.length), originalReceipts)
        || completedStages.some(s => !equal(report.judgments.find(j => j.id === s.id).stages[s.stage], s.value))) throw new Error('Protected existing results changed');
    report.usage = sumUsage(report.receipts);
    report.actualModels = [...new Set(report.receipts.map(r => r.actualModel).filter(Boolean))];
    const current = await fingerprints();
    report.productionUnchanged = equal(current.productionSha256, report.productionSha256);
    report.binaryUnchanged = current.binarySha256 === report.binarySha256;
    report.evaluationUnchanged = equal(current.evaluationSha256, report.evaluationSha256);
    report.complete = !report.haltReason && report.productionUnchanged && report.binaryUnchanged && report.evaluationUnchanged
      && report.documents.every(d => d.complete) && report.judgments.length === 20 && report.judgments.every(j => !j.error);
    report.finishedAt = new Date().toISOString();
    await writeFile(files.progress, serialize(report)); await savePublicLiveReport(report);
    if (!report.productionUnchanged || !report.binaryUnchanged || !report.evaluationUnchanged) throw new Error('Frozen execution files changed');
  }
  await checkpoint();
  try {
    for (const item of items) {
      if (report.receipts.length >= report.limits.requests || report.usage.total_tokens + item.plan.tokenReservation > report.limits.observedTotalTokens)
        throw new Error('Architecture request/token reservation limit');
      const started = Date.now(), stage = { ...item.plan, startedAt: new Date().toISOString(), status: 'started' };
      report.technicalContinuation.stages.push(stage);
      await checkpoint(); // An interrupted call cannot be silently attempted again.
      const receipt = { index: report.receipts.length + 1, group: `judge-${item.q.id}-${item.task.phase}`, phase: 'judge',
        judgeStage: item.task.phase, paperId: item.doc.id, questionId: item.q.id, startedAt: stage.startedAt,
        tokenReservation: item.plan.tokenReservation, task: 'diagnostic_judge', requestSha256: item.plan.requestSha256,
        inputChars: JSON.stringify(item.body).length };
      let responseText, value;
      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(item.body),
          signal: AbortSignal.timeout(120000), redirect: 'error' });
        receipt.status = response.status; responseText = await response.text();
        if (Buffer.byteLength(responseText) > 2 * 1024 * 1024) throw new Error('Response too large');
        if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
        const data = JSON.parse(responseText);
        receipt.actualModel = data.model; receipt.usage = data.usage ?? null; receipt.finishReason = data.choices?.[0]?.finish_reason;
        if (!Number.isSafeInteger(receipt.usage?.total_tokens) || receipt.usage.total_tokens < 0
            || receipt.usage.total_tokens > receipt.tokenReservation || receipt.usage.prompt_tokens + receipt.usage.completion_tokens !== receipt.usage.total_tokens)
          throw new Error('Provider usage missing, inconsistent or outside request reservation');
        try {
          if (typeof data.choices?.[0]?.message?.content !== 'string') throw new Error('Judge response schema');
          const parsed = parseIsolatedJudgeResponse(data.choices[0].message.content, item.task, new Set(item.paper.memories.map(m => m.id)), receipt.finishReason);
          value = parsed.value;
          const provenance = { questionId: item.q.id, paperId: item.doc.id, stage: item.task.phase, receiptId: receipt.index };
          if (parsed.repair) (report.evaluationSyntaxRepairs ||= []).push({ ...provenance, ...parsed.repair });
          if (parsed.envelopeNormalization) (report.evaluationEnvelopeNormalizations ||= []).push({ ...provenance, ...parsed.envelopeNormalization });
        } catch (error) { value = { error: clean(error.message), errorKind: 'protocol' }; }
      } catch (error) { receipt.error = clean(error.message); value = { error: receipt.error, errorKind: 'transport' }; }
      receipt.elapsedMs = Date.now() - started;
      await appendFile(files.receipts, serialize({ ...receipt, request: item.body, responseText }) + '\n');
      report.receipts.push(receipt); report.technicalContinuation.addedReceiptIds.push(receipt.index);
      const index = report.judgments.findIndex(j => j.id === item.q.id), previous = report.judgments[index];
      const values = { ...previous.stages, [item.task.phase]: value };
      report.judgments[index] = { id: previous.id, paperId: previous.paperId, split: previous.split, answerable: previous.answerable,
        ...combineIsolatedJudgments(item.tasks, values), receiptIds: [...previous.receiptIds, receipt.index] };
      stage.receiptId = receipt.index; stage.finishedAt = new Date().toISOString(); stage.status = value.error ? 'failed' : 'complete';
      if (value.error) report.haltReason = value.error;
      await checkpoint();
      console.log(JSON.stringify({ stage: item.task.phase, questionId: item.q.id, receiptId: receipt.index,
        status: stage.status, totalTokens: report.usage.total_tokens, remainingTokens: report.limits.observedTotalTokens - report.usage.total_tokens }));
      if (value.error) break;
    }
  } catch (error) { report.haltReason = clean(error.message); }
  report.technicalContinuation.status = report.haltReason ? 'failed' : 'complete';
  report.technicalContinuation.finishedAt = new Date().toISOString();
  await checkpoint();
  if (!report.complete) throw new Error(report.haltReason || 'Continuation incomplete; no retry is permitted');
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--execute') || args.length > 1) throw new Error('Usage: node scripts/continue-memory-architecture-missing-judges.mjs [--execute]');
  const prepared = await preflight();
  if (!args.includes('--execute')) {
    const { workspace, outputTag, scriptSha256, initialRequests, initialTokens, remainingTokens, allowedStages, preLiveEvidence } = prepared.plan;
    console.log(JSON.stringify({ dryRun: true, providerCalls: 0, workspace, outputTag, scriptSha256, initialRequests, initialTokens,
      remainingTokens, allowedStages, preLiveEvidence, frozenFingerprintsVerified: true, sequential: true, automaticRetries: 0 }, null, 2));
    return;
  }
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY is required for --execute');
  await execute(prepared, key);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
