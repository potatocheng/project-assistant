// Real pm-host process proof with a deterministic local provider. No real LLM
// or private project documents are involved in this regression.
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.local-data'), { recursive: true });
const workspace = await mkdtemp(path.join(root, '.local-data/extraction-recovery-proof-'));
const binary = path.join(root, 'target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host');
const alpha = 'Project Alpha retains logs for 30 days.';
const beta = 'Project Beta retains logs for 60 days.';
const gamma = 'Project Gamma retains logs for 90 days.';
const requests = [];
let failSecond = true;
const provider = http.createServer(async (req, res) => {
  let bytes = ''; for await (const chunk of req) bytes += chunk;
  const body = JSON.parse(bytes), user = JSON.parse(body.messages.at(-1).content);
  assert.equal(body.max_tokens, 6144);
  const segments = user.segments; assert.ok(segments);
  assert.ok(user.projectContext && typeof user.projectContext.name === 'string');
  requests.push({ projectContext: user.projectContext, segmentIds: segments.map(s => s.id), text: segments.map(s => s.text).join('\n') });
  if (requests.length === 2 && failSecond) { failSecond = false; res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":{"message":"deterministic second-batch outage"}}'); return; }
  const text = requests.at(-1).text;
  const statement = text.includes(gamma) ? gamma : text.includes(beta) ? beta : alpha;
  const segment = segments.find(s => s.text.includes(statement)); assert.ok(segment);
  const wrongScope = statement === gamma;
  const candidate = { retention: { layer: 'durable', reason: '回归夹具的稳定事实' }, kind: 'fact', content: statement, evidence: [{ segmentId: segment.id, quote: statement }],
    facets: { entity: wrongScope ? 'Project Wrong' : statement.split(' retains')[0], topic: 'invented navigation summary', role: '', conditions: [], validFrom: null, validUntil: null } };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: 'recovery-fixture',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ candidates: [candidate], taskCandidates: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
function start() {
  const child = spawn(binary, [workspace], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0;
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', b => process.stderr.write(b));
  const reject = e => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  child.once('error', reject); child.once('exit', () => reject(new Error('Host exited')));
  lines.on('line', line => { const r = JSON.parse(line), p = pending.get(r.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(r.id); r.ok ? p.resolve(r.data) : p.reject(Object.assign(new Error(r.error.message), r.error)); });
  return {
    call(command, payload = {}) { const id = ++seq; return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${command}`)); }, 30000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
    }); },
    async stop() { if (child.exitCode !== null || child.signalCode !== null) return; const end = once(child, 'exit'); child.kill('SIGTERM'); await end; lines.close(); },
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function source(host, projectId, text) {
  const imported = await host.call('import_text', { projectId, title: 'Synthetic recovery evidence', text });
  for (let i = 0; i < 600; i++) {
    const value = await host.call('get_source', { sourceId: imported.sourceId });
    if (value.source.status === 'ready') return value;
    assert.notEqual(value.source.status, 'failed'); await sleep(10);
  }
  throw new Error('Source did not become ready');
}
async function terminal(host, id) {
  for (let i = 0; i < 1200; i++) {
    const state = await host.call('get_state'), job = state.jobs.find(j => j.id === id);
    if (['succeeded', 'failed', 'cancelled'].includes(job?.status)) return { state, job };
    await sleep(20);
  }
  throw new Error('Extraction did not finish');
}
let host = start();
try {
  await host.call('save_ai_settings', { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${provider.address().port}`, model: 'recovery-fixture',
    outputFormat: 'json_object', timeoutSeconds: 10, autoExtract: false, remoteConsent: false, apiKey: 'synthetic-recovery-credential' });
  await host.call('save_memory_maintenance', { enabled: false, idleSeconds: 120, dailyCalls: 100, autoNew: false });
  const p = await host.call('create_project', { name: 'Recovery fixture' });
  const s = await source(host, p.id, `${alpha} ${'x'.repeat(1300)}\n${beta} ${'y'.repeat(1300)}`);
  const job = await host.call('start_extraction', { sourceId: s.source.id });
  let value = await terminal(host, job.id);
  assert.equal(value.job.status, 'failed'); assert.equal(requests.length, 2);
  assert.equal(value.state.proposals.filter(p => p.extractionJobId === job.id).length, 1, 'a later failure must retain the earlier pending proposal');
  assert.equal(value.state.memories.length, 0, 'pending extraction must never create formal memory');
  const draft = value.state.extractionDrafts.find(d => d.jobId === job.id);
  assert.ok(draft?.issues.some(i => i.field === 'topic'), 'raw invalid topic must remain auditable');
  assert.equal(draft.candidate.facets.topic, 'invented navigation summary');
  const noMemory = await host.call('ask_project', { projectId: p.id, question: 'How long does Project Alpha retain logs?' });
  assert.equal(noMemory.grounded, false); assert.equal(requests.length, 2, 'pending candidates must not enter connector model context');
  await host.stop(); host = start();
  assert.equal((await host.call('get_state')).memories.length, 0);
  await host.call('retry_extraction', { jobId: job.id });
  value = await terminal(host, job.id);
  assert.equal(value.job.status, 'succeeded'); assert.equal(requests.length, 3, 'restart/retry must not repeat the first successful batch');
  assert.ok(requests[2].text.includes(beta)); assert.ok(!requests[2].text.includes(alpha));
  const candidates = value.state.proposals.filter(p => p.extractionJobId === job.id);
  assert.equal(candidates.length, 2); assert.equal(new Set(candidates.map(p => p.id)).size, 2);
  assert.equal(value.job.candidateCount, 2);
  const accepted = await host.call('confirm_proposal', { proposalId: candidates.find(p => p.content === alpha).id });
  const detail = await host.call('get_memory', { memoryId: accepted.id });
  assert.equal(detail.memory.content, alpha);
  assert.equal(detail.revisions[0].facets.entity, 'Project Alpha');
  assert.equal(detail.revisions[0].retention.layer, 'durable');
  assert.deepEqual(requests[0].projectContext, requests[2].projectContext);
  assert.equal(detail.revisions[0].facets.topic, '');

  const foreign = await host.call('create_project', { name: 'Scope review fixture' });
  const g = await source(host, foreign.id, gamma);
  const gj = await host.call('start_extraction', { sourceId: g.source.id });
  const reviewed = await terminal(host, gj.id);
  const blocked = reviewed.state.extractionDrafts.find(d => d.jobId === gj.id && d.status === 'needs_review');
  assert.ok(blocked); assert.equal(blocked.proposalId, null);
  assert.equal(reviewed.state.proposals.filter(p => p.extractionJobId === gj.id).length, 0);
  await assert.rejects(host.call('review_extraction_draft', { draftId: blocked.id, action: 'approve', reason: 'test must not broaden scope', content: gamma,
    facets: { entity: '', topic: '', role: '', conditions: [], validFrom: null, validUntil: null } }));
  await host.call('review_extraction_draft', { draftId: blocked.id, action: 'approve', reason: 'Correct entity from the unchanged exact source sentence', content: gamma,
    facets: { entity: 'Project Gamma', topic: '', role: '', conditions: [], validFrom: null, validUntil: null } });
  const afterReview = await host.call('get_state');
  assert.equal(afterReview.memories.length, 1, 'review creates a pending proposal, not formal memory');
  assert.ok(afterReview.proposals.some(p => p.extractionJobId === gj.id && p.facets.entity === 'Project Gamma'));
  const backup = await host.call('create_backup');
  const bytes = await readFile(path.join(workspace, 'backups', backup.filename));
  const restoration = await host.call('restore_backup', { filename: backup.filename, contentBase64: bytes.toString('base64'), confirmation: 'RESTORE' });
  assert.ok(restoration.safetyBackupId);
  await host.stop(); host = start();
  const final = await host.call('get_state');
  assert.equal(final.memories.length, 1); assert.ok(final.extractionDrafts.length >= 3);
  assert.equal(final.memories[0].retention.layer, 'durable');
  assert.equal(requests.length, 4, 'finished or failed jobs must not silently replay after restore/restart');
  const result = { passed: true, workspace, providerRequests: requests.length, sourceJob: job.id, reviewedJob: gj.id,
    checks: ['completed batch persists after later HTTP failure', 'pending facts excluded from retrieval', 'topic raw value and issue retained', 'real process restart', 'explicit retry reuses successful batch', 'pending proposal insertion idempotent', 'scope-error draft blocks empty-field approval', 'evidence-based review remains pending', 'backup and restore of extraction drafts', 'no unexpected replays after restore'] };
  await writeFile(path.join(workspace, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await host.stop(); await new Promise(r => provider.close(r)); }
