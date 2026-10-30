// Deterministic HTTP fixture for acceptance tests. This is NOT an AI model.
// Nothing in the production app imports this file or falls back to this fixture.
import http from 'node:http';
import process from 'node:process';

export async function startFixture({ port = 0, expectedApiKey = null } = {}) {
  const state = { mode: 'normal', requests: 0, extractionRequests: 0, lastRequest: null };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ fixture: true, requests: state.requests })); return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    state.requests++;
    if (expectedApiKey && req.headers.authorization !== `Bearer ${expectedApiKey}`) { res.writeHead(401).end('{"error":{"message":"fixture auth header missing"}}'); return; }
    const input = JSON.parse(body);
    state.lastRequest = input;
    if (state.mode === 'unauthorized') { res.writeHead(401).end('{"error":{"message":"fixture unauthorized"}}'); return; }
    if (state.mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"choices":'); return; }
    const all = input.messages.map((m) => m.content).join('\n');
    let segments = [];
    // The production adapter embeds a JSON data envelope in its user message.
    // Accept the adapter's actual envelope shapes without inventing a UI backdoor.
    for (const message of input.messages) {
      try {
        const parsed = JSON.parse(message.content);
        if (Array.isArray(parsed.segments)) segments = parsed.segments;
        else if (Array.isArray(parsed)) segments = parsed;
      } catch { /* Human instructions are not a JSON envelope. */ }
    }
    if (!segments.length) {
      // Kept explicit: a changed extraction prompt must update this test fixture.
      res.writeHead(422).end('{"error":{"message":"fixture could not locate segments JSON"}}'); return;
    }
    state.extractionRequests++;
    const first = segments.find((s) => /一期|必须|会议|验收|project|测试/i.test(s.text)) ?? segments[0];
    const quote = first.text.trim().slice(0, 180);
    const id = first.id ?? first.segmentId;
    const candidates = state.mode === 'empty' ? [] : [{
      kind: 'decision', content: quote,
      retention: { layer: 'durable', reason: '合成固定事实，验收人工确认与保存协议' },
      evidence: [{ segmentId: state.mode === 'bad-evidence' ? 'not-a-real-segment' : id, quote }],
    }];
    if (state.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 900));
    const taskMode = state.mode === 'tasks' || state.mode === 'progress';
    const taskCandidates = taskMode ? [{
      title: state.mode === 'progress' ? '接口联调进展反馈' : '跟进接口联调与验收',
      description: quote,
      assignee: quote.includes('李工') ? '李工' : null,
      dueDate: null, dueText: null,
      status: state.mode === 'progress' ? 'in_progress' : 'todo',
      progress: state.mode === 'progress' ? 60 : null,
      evidence: [{ segmentId: id, quote }],
    }] : [];
    const content = JSON.stringify(taskMode ? { candidates: [], taskCandidates } : { candidates });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'qa-fixture', model: 'qa-fixture-not-a-model', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, state, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const index = process.argv.indexOf('--port');
  const fixture = await startFixture({ port: index >= 0 ? Number(process.argv[index + 1]) : 4175 });
  process.stderr.write(`Deterministic acceptance fixture (NOT a model): ${fixture.baseUrl}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { fixture.server.close(); process.exit(0); });
}
