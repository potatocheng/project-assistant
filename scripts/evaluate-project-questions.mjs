// Production Engine, isolated synthetic project, optional unchanged live model
// responses. Keyword checks aid review; they do not measure semantic accuracy.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const live = process.argv.includes('--live');
const apiKey = live ? process.env.DEEPSEEK_API_KEY : null;
if (live && !apiKey) throw new Error('Live evaluation requires DEEPSEEK_API_KEY.');
const model = process.env.PROJECT_QUESTION_MODEL || 'deepseek-flash';
const maxRequests = 40;
const datasetBytes = await readFile(path.join(root, 'crates/core/tests/fixtures/project-manager-questions-v1.json'));
const dataset = JSON.parse(datasetBytes);
const binary = path.resolve(process.env.PM_HOST_BINARY || path.join(root, 'target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binarySha256 = hash(await readFile(binary));
await mkdir(path.join(root, '.local-data'), { recursive: true });
const runRoot = await mkdtemp(path.join(root, '.local-data', 'project-questions-'));
const receipts = [];
const proxyToken = randomUUID();
let activeCase = null;
const proxy = http.createServer(async (req, res) => {
  if (!live || req.headers.authorization !== `Bearer ${proxyToken}` || req.method !== 'POST' || req.url !== '/chat/completions') {
    res.writeHead(403).end(); return;
  }
  if (receipts.length >= maxRequests) { res.writeHead(429).end(); return; }
  const receipt = { index: receipts.length + 1, ...activeCase, startedAt: new Date().toISOString() };
  receipts.push(receipt);
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== model || body.stream !== false) throw new Error('Unexpected model request');
    body.thinking = { type: 'disabled' };
    receipt.request = body;
    receipt.requestSha256 = hash(JSON.stringify(body));
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(95_000),
    });
    const raw = await response.text();
    receipt.httpStatus = response.status;
    receipt.responseSha256 = hash(raw);
    try { receipt.response = JSON.parse(raw); } catch { receipt.response = raw; }
    receipt.finishedAt = new Date().toISOString();
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(raw);
  } catch (error) {
    receipt.error = String(error.message).replaceAll(apiKey || proxyToken, '[REDACTED]');
    res.writeHead(502).end(JSON.stringify({ error: 'Live evaluation upstream failed' }));
  }
});
const child = spawn(binary, [path.join(runRoot, 'workspace')], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const reply = JSON.parse(line);
  const request = pending.get(reply.id);
  if (!request) return;
  clearTimeout(request.timeout); pending.delete(reply.id);
  if (reply.ok) request.resolve(reply.data);
  else request.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
});
function failPending(error) {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(error); }
  pending.clear();
}
child.on('error', failPending);
child.on('exit', code => failPending(new Error(`pm-host exited (${code})`)));
child.stderr.on('data', bytes => process.stderr.write(bytes));
function call(command, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 130_000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
  });
}
const report = { version: dataset.version, startedAt: new Date().toISOString(), usesRealModel: live,
  datasetSha256: hash(datasetBytes), binarySha256, model: live ? model : null,
  maxRequests, workspace: path.relative(root, runRoot), cases: [], receipts,
  methodology: 'Production Engine; realistic synthetic project only; desktop and group-preview entry points; no real Feishu messages. Automatic checks are evidence/status/keyword regressions, not human gold labels or semantic accuracy. Review raw answers against each case.review.',
};
const output = path.join(runRoot, 'results.json');
async function checkpoint() { await writeFile(output, JSON.stringify(report, null, 2)); }
try {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const project = await call('create_project', { name: dataset.projectName });
  const other = await call('create_project', { name: 'SECRET-OTHER-PROJECT' });
  await call('create_task', { projectId: other.id, title: 'SECRET-OTHER-TASK', category: 'action', status: 'blocked', progress: 0, priority: 'high', workDate: dataset.date, clientRequestId: randomUUID() });
  const tasks = new Map();
  for (const record of dataset.tasks) {
    let task = await call('create_task', { ...record, projectId: project.id, category: 'action', priority: 'high', clientRequestId: randomUUID() });
    if (record.update) task = await call('update_task', { ...task, ...record.update, taskId: task.id, baseVersion: task.version, clientRequestId: randomUUID() });
    tasks.set(record.key, task);
  }
  for (const record of dataset.milestones) await call('save_milestone', { ...record, projectId: project.id, baseVersion: 0, taskIds: record.taskKeys.map(key => tasks.get(key).id) });
  for (const record of dataset.governance) await call('save_governance_item', { ...record, projectId: project.id, severity: 'high', impact: '影响发布安排', responsePlan: '按确认结论跟进', escalationTo: '', links: [], evidenceIds: [], workDate: dataset.date, note: '登记决策' });
  if (live) await call('save_ai_settings', { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${proxy.address().port}`, model, outputFormat: 'json_object', timeoutSeconds: 90, autoExtract: false, remoteConsent: false, apiKey: proxyToken });
  for (const test of dataset.questions) {
    for (const command of ['ask_assistant', 'ask_project_question']) {
      activeCase = { caseId: test.id, command };
      const result = { ...activeCase, question: test.question, review: test.review, startedAt: new Date().toISOString() };
      try {
        const answer = await call(command, { projectId: project.id, question: test.question, date: dataset.date, useModel: live });
        result.answer = answer;
        const citations = answer.citations || [];
        result.checks = {
          scoped: citations.every(c => c.projectId === project.id) && !JSON.stringify(answer).includes('SECRET-OTHER'),
          expectedStatus: !test.status || answer.status === test.status,
          expectedTerms: (test.contains || []).every(term => answer.answer.includes(term)),
          forbiddenTermsAbsent: (test.notContains || []).every(term => !answer.answer.includes(term)),
          expectedCitationKinds: test.citationKinds.every(kind => citations.some(c => c.kind === kind)),
          missingFieldsExplicit: !['partial', 'unknown'].includes(test.status) || !test.contains || (answer.unknowns || []).length > 0,
        };
      } catch (error) { result.error = { code: error.code || 'EVALUATION_ERROR', message: error.message }; }
      report.cases.push(result);
      await checkpoint();
      process.stdout.write(`${test.id} ${command}: ${result.error?.code || answerStatus(result)}\n`);
    }
  }
  report.summary = { cases: report.cases.length, errors: report.cases.filter(c => c.error).length,
    automaticChecksPassed: report.cases.filter(c => c.checks && Object.values(c.checks).every(Boolean)).length,
    requiresSemanticReview: live, realModelRequests: receipts.length,
    reportedTokens: receipts.reduce((sum, receipt) => sum + (receipt.response?.usage?.total_tokens || 0), 0),
    usageComplete: receipts.every(receipt => Number.isFinite(receipt.response?.usage?.total_tokens)),
  };
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  process.stdout.write(`${JSON.stringify(report.summary)}\nReport: ${output}\n`);
  if (report.summary.errors || !live && report.summary.automaticChecksPassed !== report.cases.length) process.exitCode = 1;
} finally {
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  lines.close();
  await new Promise(resolve => proxy.close(resolve));
}
function answerStatus(result) { return `${result.answer.status} · checks ${Object.values(result.checks).filter(Boolean).length}/${Object.keys(result.checks).length}`; }
