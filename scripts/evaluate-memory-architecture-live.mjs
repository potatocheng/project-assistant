// QA-only on frozen reliability memory/sources. This is a new registered round.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, cp, readdir, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readPublicLiveReport, savePublicLiveReport } from './memory-public-live-io.mjs';
import { selectPublicDocuments, publicReportPath, assertNoProductionGold, failedJudgeRepairPlan, beginJudgeRepair } from './memory-public-live-options.mjs';
import { isolatedJudgeTasks, parseIsolatedJudgeResponse, combineIsolatedJudgments } from './memory-qa-structured-judges.mjs';
import { copyFrozenPaperWorkspace, assertFrozenHostMemory, frozenMemorySemanticHash } from './memory-qa-structured-freeze.mjs';
import { capturedEvaluationReferences, capturedEvaluationSchema, validateStructuredClaimProvenance, selectedEvaluationReferences } from './memory-qa-structured-capture.mjs';
import { budgetCanonical } from './memory-public-live-budget.mjs';
import { architectureOptions, architectureEvaluationFiles, fingerprintArchitectureEvaluation,
  prepareArchitectureBudget, verifyArchitecturePreLive, validateArchitectureReferences, architectureRequestReservation } from './memory-architecture-evaluation.mjs';

const root=path.resolve(import.meta.dirname,'..'),options=architectureOptions(process.argv.slice(2),root);
const key=process.env.DEEPSEEK_API_KEY;
if(!key&&!options.noApiDryRun)throw new Error('DEEPSEEK_API_KEY is required');
const model=process.env.MEMORY_EVAL_MODEL||'deepseek-flash';
const hash=v=>createHash('sha256').update(v).digest('hex');
const clean=v=>key?String(v).replaceAll(key,'[REDACTED]'):String(v);
const log=v=>process.stdout.write(`${new Date().toISOString()} ${v}\n`);
const manifest=JSON.parse(await readFile(path.join(root,'docs/memory-public-dataset-manifest.json')));
const fixtureBytes=await readFile(path.resolve(root,manifest.fixture));
if(hash(fixtureBytes)!==manifest.datasetSha256)throw new Error('Frozen fixture changed');
const fixture=JSON.parse(fixtureBytes),selected=selectPublicDocuments(fixture,'development');
if(selected.questionCount!==20)throw new Error('Architecture round must contain the fixed 20 development questions');
const baseline=await readPublicLiveReport(options.baseline),frozenMemoryReport=baseline;
const binary=options.binary,productionDirectory=path.join(options.productionSourceRoot,'crates/core/src');
const frozenFiles=(await readdir(productionDirectory,{recursive:true})).filter(f=>f.endsWith('.rs')).sort();
const fingerprints=Object.fromEntries(await Promise.all(frozenFiles.map(async f=>[f,hash(await readFile(path.join(productionDirectory,f)))])));
const resume=options.resume?path.resolve(options.resume):null;
if(resume&&(!resume.startsWith(path.join(root,'.local-data')+path.sep)||!path.basename(resume).startsWith('memory-architecture-live-')))throw new Error('Invalid architecture resume directory');
const resumeEvidence=resume?JSON.parse(await readFile(path.join(resume,'progress.json'))):null;
const currentRoundTag=options.tag??resumeEvidence?.outputTag;
const priorFile=options.priorFile??(resumeEvidence?.architecture?.priorReport?path.resolve(root,resumeEvidence.architecture.priorReport):null);
const targetedBudget=await prepareArchitectureBudget(root,{split:options.split,currentTag:currentRoundTag,priorFile,
  model,datasetSha256:hash(fixtureBytes),before:resumeEvidence?.startedAt??new Date().toISOString(),resumeRoot:resume,
  maxRequests:options.maxRequests,maxTokens:options.maxTokens});
const evaluationRound={files:architectureEvaluationFiles,fingerprint:fingerprintArchitectureEvaluation};
const evaluationFingerprints=await evaluationRound.fingerprint(root);
const preLiveEvidence=await verifyArchitecturePreLive(root,{currentTag:currentRoundTag,productionSha256:fingerprints,
  binarySha256:hash(await readFile(binary)),evaluationSha256:evaluationFingerprints,registration:targetedBudget.registration,before:new Date().toISOString()});
if(options.noApiDryRun){console.log(JSON.stringify({dryRun:true,questions:20,formalMemories:929,tag:currentRoundTag,
  limits:targetedBudget.limits,priorLedger:targetedBudget.ledger,preLiveEvidence,providerCalls:0}));process.exit(0);}
await mkdir(path.join(root,'.local-data'),{recursive:true});
const runRoot=resume||await mkdtemp(path.join(root,'.local-data/memory-architecture-live-'));
const report=resumeEvidence??{
  version:'qasper-production-live-v2',outputTag:currentRoundTag,split:'development',judgeMode:'separated',
  expectedQuestions:20,expectedPapers:selected.documents.length,paragraphControl:false,startedAt:new Date().toISOString(),model,
  preLiveEvidence,datasetSha256:hash(fixtureBytes),provenance:fixture.provenance,productionSha256:fingerprints,
  evaluationSha256:evaluationFingerprints,binarySha256:hash(await readFile(binary)),workspace:path.relative(root,runRoot),
  limits:{...targetedBudget.limits,concurrentWorkers:options.workers,automaticRetries:0},
  baseline:{file:path.relative(root,options.baseline),workspace:baseline.workspace,binarySha256:baseline.binarySha256},
  budgetRegistration:targetedBudget.budgetRegistration,priorBudgetLedger:targetedBudget.ledger,
  architecture:{kind:'frozen-confirmed-memory-qa-only',attempt:targetedBudget.attempt,
    frozenReport:path.relative(root,options.frozenMemoryRun),frozenReportSha256:hash(await readFile(options.frozenMemoryRun)),
    formalMemoryCount:929,priorReport:priorFile?path.relative(root,priorFile):null,suppliedPackFrozen:false,historicalBaselineAnswers:true},
  methodology:'QA-only architecture comparison on the exact reliability run confirmed memories, facets, revisions and original sources. No new extraction or formal-memory writes. Actual production retrieval may include typed full source passages; retention judges still see formal memory content only. Both QA entries run now, and their answers are anonymously regraded against historical reliability answers. Human gold enters only the unchanged isolated post-hoc judges. Same-model judging is not independent human validation.',
  documents:[],judgments:[],receipts:[],
};
if(report.outputTag!==currentRoundTag||report.model!==model||report.datasetSha256!==hash(fixtureBytes)
    ||budgetCanonical(report.productionSha256)!==budgetCanonical(fingerprints)||report.binarySha256!==hash(await readFile(binary))
    ||budgetCanonical(report.evaluationSha256)!==budgetCanonical(evaluationFingerprints)
    ||budgetCanonical(report.budgetRegistration)!==budgetCanonical(targetedBudget.budgetRegistration)
    ||budgetCanonical(report.priorBudgetLedger)!==budgetCanonical(targetedBudget.ledger)
    ||budgetCanonical(report.preLiveEvidence)!==budgetCanonical(preLiveEvidence))throw new Error('Architecture resume cannot change frozen execution evidence');
if(!resume){
  await writeFile(path.join(runRoot,'receipts.jsonl'),'',{flag:'wx'});
  try{await access(publicReportPath(root,report));throw new Error('Architecture output already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  const snapshot=path.join(runRoot,'production');await mkdir(snapshot,{recursive:true});
  for(const file of frozenFiles){await mkdir(path.dirname(path.join(snapshot,file)),{recursive:true});await cp(path.join(productionDirectory,file),path.join(snapshot,file));}
  await cp(binary,path.join(snapshot,path.basename(binary)));report.productionSnapshot=path.relative(root,snapshot);
  const evaluationSnapshot=path.join(runRoot,'evaluation');
  for(const file of evaluationRound.files){await mkdir(path.dirname(path.join(evaluationSnapshot,file)),{recursive:true});await cp(path.join(root,file),path.join(evaluationSnapshot,file));}
  report.evaluationSnapshot=path.relative(root,evaluationSnapshot);
}
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
const reservedTokens = new Map();
const proxy = http.createServer(async (req, res) => {
  const group = tokens.get(req.headers.authorization);
  if (!group || req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(403).end(); return; }
  if (haltReason || receipts.length >= report.limits.requests || spent() >= report.limits.observedTotalTokens) {
    haltReason ||= 'Evaluation call/token limit'; res.writeHead(503).end('{"error":{"message":"Evaluation budget exhausted"}}'); return;
  }
  const started = Date.now(); let body, responseText, receipt;
  try {
    let text = '';
    for await (const c of req) { text += c; if (text.length > 2 * 1024 * 1024) throw new Error('Request too large'); }
    body = JSON.parse(text);
    if (body.model !== model || body.stream !== false) throw new Error('Unexpected request model/stream');
    body.thinking = { type: 'disabled' }; // Same as the official DeepSeek adapter.
    const reservation = architectureRequestReservation(body);
    const pending = [...reservedTokens.values()].reduce((sum,value)=>sum+value,0);
    if (haltReason || receipts.length >= report.limits.requests || spent() + pending + reservation > report.limits.observedTotalTokens) {
      haltReason ||= 'Architecture request/token reservation limit';
      res.writeHead(503).end('{"error":{"message":"Evaluation budget exhausted"}}'); return;
    }
    receipt = { index: receipts.length + 1, group, ...active.get(group), startedAt: new Date().toISOString(), tokenReservation: reservation };
    receipts.push(receipt); reservedTokens.set(receipt.index,reservation);
    const user = JSON.parse(body.messages.at(-1).content);
    const schema = capturedEvaluationSchema(body, user);
    if (!['qa','judge'].includes(receipt.phase)) throw new Error('Architecture round forbids extraction/provider calls outside QA and isolated judging');
    if (receipt.phase !== 'judge') assertNoProductionGold(user);
    receipt.task = receipt.phase === 'judge' ? 'diagnostic_judge'
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
      if (!Number.isSafeInteger(receipt.usage?.total_tokens) || receipt.usage.total_tokens < 0
          || receipt.usage.total_tokens > reservation || receipt.usage.prompt_tokens + receipt.usage.completion_tokens !== receipt.usage.total_tokens) {
        haltReason = 'Provider usage missing, inconsistent or outside request reservation'; receipt.error = haltReason;
      }
    } else { haltReason = `Upstream HTTP ${response.status}`; receipt.error = haltReason; }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(responseText);
  } catch (error) {
    haltReason = clean(error.message); if(receipt) receipt.error = haltReason;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Evaluation upstream failed"}}');
  } finally {
    if (!receipt) { await checkpoint(); return; }
    reservedTokens.delete(receipt.index);
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
  const child = spawn(runBinary, [workspace], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
  // Existing entries, including failed calls, remain in this attempt.
  if (result?.complete || haltReason) return;
  const group = doc.id, workspace = path.join(runRoot, `paper-${index}`);
  if (frozenMemoryReport && !result) {
    const frozenPaper = frozenMemoryReport.documents.find(p => p.id === doc.id);
    if (!frozenPaper || frozenPaper.confirmed !== true || frozenPaper.qaReadOnly !== true) throw new Error('Frozen paper must contain unchanged confirmed memory');
    const copied = await copyFrozenPaperWorkspace(root, frozenPaper, workspace);
    result = { ...structuredClone(frozenPaper), workspace: path.relative(root, workspace), questions: [], complete: false, qaReadOnly: undefined,
      frozenMemory: copied, extraction: { ...structuredClone(frozenPaper.extraction), skipped: true, frozenQaOnly: true, receiptIds: [], historicalReceiptIds: frozenPaper.extraction.receiptIds } };
    report.documents.push(result);
    await checkpoint();
  }
  const host = startHost(workspace);
  try {
    await configure(host, group);
    if (frozenMemoryReport) await assertFrozenHostMemory(host, result);
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
        value.scopeViolation = false;
        try { value.referenceIntegrity = validateArchitectureReferences(value, result); }
        catch (error) { value.scopeViolation = true; value.referenceIntegrityFailure = clean(error.message); haltReason = 'Architecture reference integrity failure'; }
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
    await parallel(selected.documents.flatMap(doc => { const paper = report.documents.find(p => p.id === doc.id); return paper ? doc.queries.map(q => ({ doc, paper, q })) : []; }), judgeQuestion);
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
  report.complete = report.documents.length === selected.documents.length && report.documents.every(d => d.complete) && report.judgments.length === selected.questionCount && report.judgments.every(j => !j.error);
  await checkpoint();
  serialize(report); // Credential guard also covers the detailed artifact.
  await savePublicLiveReport(report);
  log(`DONE complete=${report.complete} requests=${receipts.length} tokens=${spent()} halted=${haltReason || 'no'}`);
  if (haltReason || report.fatalError || !report.complete) process.exitCode = 1;
}
