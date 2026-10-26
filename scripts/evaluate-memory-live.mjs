// Live DeepSeek evaluation through the production Rust Engine. The loopback
// observer forwards real API responses, preserving bodies and recording usage.
// The real API key is held only in this process, never in reports or workspaces.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = path.resolve(import.meta.dirname, '..');
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('DEEPSEEK_API_KEY is required.');
const model = process.env.MEMORY_EVAL_MODEL || 'deepseek-flash';
const nonvector = process.argv.includes('--nonvector');
const output = path.join(root, nonvector ? 'docs/memory-nonvector-live-results.json' : 'docs/memory-live-evaluation-results.json');
const datasetBytes = await readFile(path.join(root, 'crates/core/tests/fixtures/memory-evaluation-v1.json'));
const liveBytes = await readFile(path.join(root, 'crates/core/tests/fixtures/memory-live-evaluation-v1.json'));
const dataset = JSON.parse(datasetBytes), live = JSON.parse(liveBytes);
const hash = (value) => createHash('sha256').update(value).digest('hex');
let challengeBytes;
if (nonvector) {
  challengeBytes = await readFile(path.join(root, 'crates/core/tests/fixtures/memory-nonvector-challenge-v1.json'));
  const challenge = JSON.parse(challengeBytes);
  const selected = new Set(['exact_owner', 'alias_pool_missing', 'paraphrase_export', 'semantic_signature', 'semantic_export', 'semantic_incident', 'semantic_offline', 'semantic_lockout', 'multi_dependency', 'multi_cause', 'unknown_relevant', 'conflict_only']);
  dataset.memories.push(...challenge.memories);
  dataset.queries = [...dataset.queries.filter((q) => selected.has(q.id)), ...challenge.queries];
  Object.assign(live.claims, challenge.claims);
}
await mkdir(path.join(root, '.local-data'), { recursive: true });
const resumeArg = process.argv.indexOf('--resume');
const resumePath = resumeArg >= 0 ? path.resolve(process.argv[resumeArg + 1] ?? '') : null;
if (nonvector && resumePath) throw new Error('Non-vector evaluation uses a fresh isolated workspace.');
if (resumePath && !resumePath.startsWith(path.join(root, '.local-data/live-memory-'))) throw new Error('Resume path must be an isolated live-memory workspace.');
const previous = resumePath ? JSON.parse(await readFile(path.join(resumePath, 'progress.json'), 'utf8')) : null;
if (previous && (previous.requestedModel !== model || previous.liveDatasetSha256 !== hash(liveBytes))) throw new Error('Resume model/dataset mismatch.');
const runRoot = resumePath ?? await mkdtemp(path.join(root, '.local-data/live-memory-'));
const binary = path.join(root, 'target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host');
const receipts = previous?.receipts ?? [], active = new Map(), tokens = new Map(), hosts = new Set();
const initialReceiptCount = receipts.length;
let halted = false;
const normalize = (value) => String(value ?? '').replace(/\s/g, '').replaceAll('％', '%');
const matches = (value, pattern) => new RegExp(pattern, 'i').test(normalize(value));
const sanitize = (value) => String(value).replaceAll(key, '[REDACTED]');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = previous ?? {
  version: live.version, startedAt: new Date().toISOString(), usesRealModel: true,
  upstream: 'https://api.deepseek.com/chat/completions', requestedModel: model,
  datasetSha256: hash(datasetBytes), liveDatasetSha256: hash(liveBytes),
  methodology: 'Production pm-host/Engine; synthetic sources only; live upstream unchanged response bodies via authenticated loopback usage observer. thinking=disabled matches the production DeepSeek adapter. No automatic network retry; accepted extraction candidates explicitly confirmed only inside this isolated evaluation.',
  workspace: path.relative(root, runRoot), goldQa: {}, extraction: [], endToEnd: [], receipts,
};
if (nonvector) report.nonvector = { challengeDatasetSha256: hash(challengeBytes), queryCountPerEntry: dataset.queries.length,
  skipsExtraction: true, maxUpstreamRequests: 90, version: 'organized-memory-v3-lexical',
  reviewVersion: 'claim-support-v3-atomic',
  description: '12 known development queries plus 6 newly authored synthetic challenges; no embeddings or reranker; scoped compact memory catalog, one bounded rewrite and causal review through production Engine.' };
if (previous) {
  report.resumedAt = new Date().toISOString();
  report.beforeFix = { file: 'memory-live-evaluation-before-fix.json', desktopErrors: previous.goldQa.desktop.filter((c) => c.error).length,
    desktopCases: previous.goldQa.desktop.length, endToEndErrors: previous.endToEnd.filter((c) => c.error).length,
    fix: 'JSON-object personal assistant now receives the full output schema and explicit field/type constraints; strict response validation retained.' };
  report.endToEnd = [];
}
async function checkpoint() {
  await writeFile(path.join(runRoot, 'progress.json'), JSON.stringify(report, null, 2));
}
function progress(text) { process.stdout.write(`${new Date().toISOString()} ${text}\n`); }

const proxy = http.createServer(async (req, res) => {
  const group = tokens.get(req.headers.authorization);
  if (!group || req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(403).end(); return; }
  if (halted || receipts.length - initialReceiptCount >= 90) { res.writeHead(503).end(); return; }
  const receipt = { index: receipts.length + 1, group, ...active.get(group), startedAt: new Date().toISOString() };
  receipts.push(receipt);
  const start = performance.now();
  try {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw new Error('Request too large'); }
    const body = JSON.parse(raw);
    if (body.model !== model || body.stream !== false) throw new Error('Unexpected request');
    body.thinking = { type: 'disabled' };
    receipt.requestSha256 = hash(JSON.stringify(body));
    const user = JSON.parse(body.messages.at(-1).content);
    receipt.referenceIds = (user.references ?? user.memories ?? user.context?.memories ?? []).map((r) => r.id ?? r.memoryId);
    receipt.stage = nonvector ? 'nonvector' : previous ? 'after_prompt_fix' : 'baseline';
    receipt.task = user.schema?.required?.includes('queries') ? 'query_rewrite'
      : user.schema?.required?.includes('unsupportedClaims') ? 'answer_review' : 'generation';
    receipt.inputChars = JSON.stringify(body).length;
    const response = await fetch(report.upstream, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Response too large');
    receipt.status = response.status;
    if (response.ok) {
      const responseData = JSON.parse(Buffer.from(bytes).toString('utf8'));
      receipt.actualModel = responseData.model;
      receipt.responseId = responseData.id;
      receipt.usage = responseData.usage ?? null;
      receipt.finishReason = responseData.choices?.[0]?.finish_reason;
      const content = responseData.choices?.[0]?.message?.content;
      try { receipt.modelOutput = JSON.parse(content); } catch { receipt.modelOutputText = content; }
    } else { halted = true; receipt.error = `Upstream HTTP ${response.status}`;
      receipt.errorDetail = sanitize(Buffer.from(bytes).toString('utf8')).slice(0, 2000); }
    receipt.elapsedMs = performance.now() - start;
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(Buffer.from(bytes));
  } catch (error) {
    halted = true; receipt.error = sanitize(error.message); receipt.elapsedMs = performance.now() - start;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Live evaluation upstream failed"}}');
  }
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;

function startHost(workspace) {
  const child = spawn(binary, [workspace], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', (data) => { const text = sanitize(data.toString()); if (!text.includes('API Key')) process.stderr.write(text); });
  const rejectAll = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', rejectAll); child.on('exit', () => rejectAll(new Error('Host exited')));
  lines.on('line', (line) => {
    const reply = JSON.parse(line), p = pending.get(reply.id); if (!p) return;
    pending.delete(reply.id); clearTimeout(p.timer);
    reply.ok ? p.resolve(reply.data) : p.reject(Object.assign(new Error(reply.error.message), reply.error));
  });
  const host = {
    call(command, payload = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 190000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      });
    },
    async stop() {
      hosts.delete(host);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const end = once(child, 'exit'); child.kill('SIGTERM'); await end; lines.close();
    },
  };
  hosts.add(host); return host;
}
async function configure(host, group) {
  const token = randomUUID(); tokens.set(`Bearer ${token}`, group);
  await host.call('save_ai_settings', { provider: 'openai_compatible', baseUrl, model,
    outputFormat: 'json_object', timeoutSeconds: 120, autoExtract: false, remoteConsent: false, apiKey: token });
  await host.call('save_memory_maintenance', { enabled: false, idleSeconds: 120, dailyCalls: 100, autoNew: false });
}
async function source(host, projectId, title, text) {
  const imported = await host.call('import_text', { projectId, title, text });
  for (let i = 0; i < 600; i++) {
    const value = await host.call('get_source', { sourceId: imported.sourceId });
    if (value.source.status === 'ready') return value;
    if (value.source.status === 'failed') throw new Error('Source parsing failed');
    await pause(10);
  }
  throw new Error('Source parsing timeout');
}
async function formal(host, projectId, title, content, kind = 'fact') {
  const s = await source(host, projectId, title, content);
  const p = await host.call('create_proposal', { projectId, sourceId: s.source.id, segmentIds: s.segments.slice(0, 100).map((g) => g.id), kind, content });
  return host.call('confirm_proposal', { proposalId: p.id });
}
async function seedGold(workspace) {
  const host = startHost(workspace);
  await host.call('save_memory_maintenance', { enabled: false, idleSeconds: 120, dailyCalls: 100, autoNew: false });
  const project = await host.call('create_project', { name: '合成标准记忆' });
  const foreign = await host.call('create_project', { name: '合成隔离项目' });
  const memoryMap = {};
  for (const m of dataset.memories) {
    const body = '会议背景与例行事项说明。'.repeat(m.prefixRepeat ?? 0) + m.content;
    let record = await formal(host, project.id, m.title ?? '项目确认纪要', m.previous ?? body, m.kind);
    if (m.previous) {
      const current = await source(host, project.id, '项目确认纪要', body);
      record = await host.call('revise_memory', { memoryId: record.id, baseRevision: 1, content: body,
        reason: '合成资料中的最新确认', question: '支付接口验收由谁负责？', segmentIds: current.segments.map((g) => g.id) });
    }
    memoryMap[m.id] = record.id;
  }
  await formal(host, foreign.id, '隔离项目', '支付接口验收由OTHER_PROJECT_SECRET负责；登录审计留存7天。');
  const pending = await source(host, project.id, '未确认资料', '星舰负责人为林楚。');
  await host.call('create_proposal', { projectId: project.id, sourceId: pending.source.id, segmentIds: [pending.segments[0].id], kind: 'fact', content: '星舰负责人为林楚。' });
  for (let i = 0; i < 120; i++) await formal(host, project.id, '日常记录', `例行同步记录${i}：资料已整理，沟通安排另行确认。`);
  const conflict = await source(host, project.id, '待核定变更', '迁移窗口待重新核定。');
  const proposal = await host.call('create_proposal', { projectId: project.id, sourceId: conflict.source.id, segmentIds: [conflict.segments[0].id], kind: 'decision', content: '迁移窗口待重新核定。' });
  await host.stop();
  // Only the synthetic review fixture uses SQL, while no Engine is open.
  // This fixes its disposition independently of model comparison randomness.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(workspace, 'workspace.sqlite'));
  db.exec('PRAGMA foreign_keys=ON;');
  db.prepare('INSERT INTO memory_reviews VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), proposal.id, 'conflict', memoryMap.conflicted, 1, dataset.memories.find((m) => m.id === 'conflicted').content, '合成题集的已知冲突', 'pending', new Date().toISOString(), new Date().toISOString());
  db.close(); return { projectId: project.id, memoryMap };
}
function scoreAnswer(query, result, memoryMap) {
  const inverse = Object.fromEntries(Object.entries(memoryMap).map(([k, v]) => [v, k]));
  const cited = (result.citations ?? []).map((c) => inverse[c.memoryId] ?? c.id ?? c.memoryId);
  const expected = live.claims[query.id] ?? query.claims ?? [];
  const checks = expected.map((pattern) => ({ pattern, passed: matches(result.answer, pattern) }));
  const scopeViolation = JSON.stringify(result).includes('OTHER_PROJECT_SECRET');
  return { status: result.status, claims: result.claims, unknowns: result.unknowns, claimValidation: result.claimValidation, grounded: result.grounded, mode: result.mode, answer: result.answer, citations: result.citations,
    retrievedGoldenIds: result.context?.memories?.map((m) => inverse[m.memoryId ?? m.id] ?? m.memoryId ?? m.id) ?? [],
    citedGoldenIds: cited, goldEvidence: query.gold ?? null, claimChecks: checks, queryTrace: result.queryTrace, qualityReview: result.qualityReview,
    expectedClaimsPresent: checks.every((c) => c.passed),
    allGoldEvidenceCited: query.gold?.length ? query.gold.every((id) => cited.includes(id)) : null,
    correctAbstention: query.gold?.length === 0 ? result.grounded === false : null, scopeViolation };
}
async function askCases(workspace, group, command, mapping) {
  const host = startHost(workspace); await configure(host, group); const results = []; report.goldQa[group] = results;
  const before = await host.call('get_state');
  for (const query of dataset.queries) {
    if (halted) break;
    active.set(group, { phase: 'gold_qa', caseId: query.id });
    const start = performance.now(), count = receipts.filter((r) => r.group === group).length;
    try {
      const value = await host.call(command, { projectId: mapping.projectId, date: '2026-10-20', question: query.question, useModel: true });
      results.push({ id: query.id, category: query.category, question: query.question,
        elapsedMs: performance.now() - start, modelCalls: receipts.filter((r) => r.group === group).length - count,
        ...scoreAnswer(query, value, mapping.memoryMap) });
      progress(`${group} ${results.length}/${dataset.queries.length} ${query.id} grounded=${value.grounded}`);
    } catch (error) { results.push({ id: query.id, category: query.category, goldEvidence: query.gold, question: query.question, error: sanitize(error.message), errorCode: error.code }); progress(`${group} ${query.id} ERROR ${error.code ?? 'unknown'}`); }
    await checkpoint();
  }
  const after = await host.call('get_state');
  report[`${group}ReadOnly`] = JSON.stringify([before.memories, before.tasks, before.proposals]) === JSON.stringify([after.memories, after.tasks, after.proposals]);
  await host.stop();
}
async function extractionCases(workspace, resume = false) {
  const group = 'extraction'; const host = startHost(workspace); await configure(host, group); const projects = {};
  if (resume) {
    const state = await host.call('get_state');
    for (const doc of live.documents) projects[doc.id] = state.sources.find((s) => s.title === doc.id)?.projectId;
  }
  for (const doc of resume ? [] : live.documents) {
    if (halted) break;
    const p = await host.call('create_project', { name: `合成提取-${doc.id}` }); projects[doc.id] = p.id;
    const s = await source(host, p.id, doc.id, doc.text);
    active.set(group, { phase: 'extraction', caseId: doc.id }); const start = performance.now();
    const job = await host.call('start_extraction', { sourceId: s.source.id }); let state, terminal;
    for (let i = 0; i < 1600; i++) {
      state = await host.call('get_state'); terminal = state.jobs.find((j) => j.id === job.id);
      if (['succeeded', 'failed', 'cancelled'].includes(terminal?.status)) break;
      await pause(100);
    }
    const candidates = state.proposals.filter((p) => p.sourceId === s.source.id);
    const tasks = state.taskProposals.filter((p) => p.sourceId === s.source.id);
    const facts = doc.facts.map((f) => ({ id: f.id, patterns: f.all,
      matches: candidates.filter((c) => f.all.every((pattern) => matches(c.content, pattern))).map((c) => c.id) }));
    const fields = doc.tasks.map((t) => {
      const matched = tasks.filter((c) => matches(c.title, t.titlePattern));
      return { id: t.id, titlePattern: t.titlePattern, expected: t.fields, matched: matched.map((c) => ({ id: c.id,
        actual: Object.fromEntries(Object.keys(t.fields).map((k) => [k, c[k]])),
        checks: Object.entries(t.fields).map(([field, expected]) => ({ field, expected, actual: c[field], passed: c[field] === expected })) })) };
    });
    const quotesValid = [...candidates, ...tasks].every((c) => c.quotes.length > 0 && c.quotes.every((q) => s.segments.some((g) => g.id === q.segmentId && g.text.includes(q.quote))));
    report.extraction.push({ id: doc.id, sourceText: doc.text, elapsedMs: performance.now() - start, job: terminal, candidates, tasks, factChecks: facts, taskFieldChecks: fields, quotesValid,
      autoCreatedMemories: state.memories.filter((m) => m.projectId === p.id).length });
    progress(`extraction ${report.extraction.length}/${live.documents.length} ${doc.id} ${terminal.status} memories=${candidates.length} tasks=${tasks.length} facts=${facts.filter((f) => f.matches.length).length}/${facts.length}`);
    // Explicitly accept generated memory only in this synthetic evaluation.
    // This measures downstream behavior; it is not a semantic approval of output.
    if (doc.id !== 'historical_change') for (const c of candidates) await host.call('confirm_proposal', { proposalId: c.id });
    await checkpoint();
  }
  for (const query of live.endToEndQueries) {
    if (halted || !projects[query.project]) break;
    active.set(group, { phase: 'end_to_end', caseId: query.id }); const start = performance.now();
    try {
      const result = await host.call('ask_assistant', { projectId: projects[query.project], date: '2026-10-20', question: query.question, useModel: true });
      report.endToEnd.push({ id: query.id, question: query.question, elapsedMs: performance.now() - start, ...scoreAnswer(query, result, {}) });
      progress(`end_to_end ${report.endToEnd.length}/${live.endToEndQueries.length} ${query.id} grounded=${result.grounded}`);
    } catch (error) { report.endToEnd.push({ id: query.id, error: sanitize(error.message), errorCode: error.code }); }
    await checkpoint();
  }
  await host.stop();
}
function summarize(cases) {
  const positives = cases.filter((c) => c.goldEvidence?.length), negatives = cases.filter((c) => c.goldEvidence?.length === 0);
  const latencies = cases.filter((c) => c.elapsedMs != null).map((c) => c.elapsedMs).sort((a, b) => a - b);
  return { cases: cases.length, errors: cases.filter((c) => c.error).length, answerable: positives.length,
    groundedAnswerable: positives.filter((c) => c.grounded).length,
    expectedClaimsPresent: positives.filter((c) => c.grounded && c.expectedClaimsPresent).length,
    allGoldEvidenceCited: positives.filter((c) => c.allGoldEvidenceCited).length,
    unanswerable: negatives.length, correctAbstentions: negatives.filter((c) => c.correctAbstention).length,
    scopeViolations: cases.filter((c) => c.scopeViolation).length,
    p50Ms: latencies[Math.floor((latencies.length - 1) / 2)] ?? null,
    p95Ms: latencies[Math.max(0, Math.ceil(latencies.length * .95) - 1)] ?? null };
}

try {
  progress(`Live model=${model}; synthetic-only workspace=${path.relative(root, runRoot)}`);
  const goldPath = path.join(runRoot, 'gold-connector');
  if (previous) {
    await Promise.all([askCases(path.join(runRoot, 'gold-desktop'), 'desktop', 'ask_assistant', report.goldMapping), extractionCases(path.join(runRoot, 'extraction'), true)]);
  } else {
    const mapping = await seedGold(goldPath);
    const desktopPath = path.join(runRoot, 'gold-desktop'); await cp(goldPath, desktopPath, { recursive: true });
    report.goldMapping = mapping;
    await Promise.all([askCases(goldPath, 'connector', 'ask_project', mapping), askCases(desktopPath, 'desktop', 'ask_assistant', mapping),
      ...(nonvector ? [] : [extractionCases(path.join(runRoot, 'extraction'))])]);
  }
} catch (error) { report.fatalError = sanitize(error.message); process.exitCode = 1; }
finally {
  await Promise.allSettled([...hosts].map((h) => h.stop()));
  await new Promise((resolve) => proxy.close(resolve));
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(Object.entries(report.goldQa).map(([k, cases]) => [k, summarize(cases)]));
  report.actualModels = [...new Set(receipts.map((r) => r.actualModel).filter(Boolean))];
  report.usage = receipts.reduce((sum, r) => { for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) sum[field] = (sum[field] ?? 0) + (r.usage?.[field] ?? 0); return sum; }, {});
  report.requestCount = receipts.length; report.halted = halted;
  const serialized = JSON.stringify(report, null, 2);
  if (serialized.includes(key)) throw new Error('Refusing to write report containing credential');
  await writeFile(output, serialized); await checkpoint();
  progress(`DONE requests=${receipts.length} summaries=${JSON.stringify(report.summary)} usage=${JSON.stringify(report.usage)}`);
  progress(`Results=${output}`);
  if (halted || report.fatalError) process.exitCode = 1;
  if (Object.values(report.summary).some((s) => s.errors > 0) || report.endToEnd.some((c) => c.error)) process.exitCode = 1;
  if (!nonvector) await import('./report-memory-live.mjs');
}
