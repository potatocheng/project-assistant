// Development-only adapter: the browser exercises the same Rust commands as Tauri.
// It is not imported by the application and is not bundled into the desktop app.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const workspace = arg('--workspace', null);
if (!workspace || !path.isAbsolute(workspace)) {
  throw new Error('An absolute, isolated --workspace directory is required.');
}
const port = Number(arg('--port', '4174'));
const binary = path.resolve(arg('--binary', 'target/debug/pm-host'));
const allowedOrigins = new Set(['http://127.0.0.1:1420', 'http://localhost:1420']);
const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
let sequence = 0;
let childExited = false;
const pending = new Map();

const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    const reply = JSON.parse(line);
    const request = pending.get(reply.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.data);
    else request.reject(reply.error || { code: 'CORE_ERROR', message: '本地操作失败。' });
  } catch (error) {
    process.stderr.write(`Invalid host reply: ${error.message}\n`);
  }
});
function hostUnavailable(error) {
  childExited = true;
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject({ code: 'HOST_UNAVAILABLE', message: error?.message || 'Rust host exited.' });
  }
  pending.clear();
}
child.on('error', hostUnavailable);
child.on('exit', () => hostUnavailable());
function execute(command, payload = {}) {
  if (childExited) return Promise.reject({ code: 'HOST_UNAVAILABLE', message: 'Rust host exited.' });
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject({ code: 'TIMEOUT', message: '本地操作超时。' });
    }, 120_000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
  });
}
function send(res, status, data, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 360 * 1024 * 1024) throw { code: 'TOO_LARGE', message: '请求过大。' };
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
    return send(res, 403, { code: 'INVALID_HOST', message: 'Loopback only.' });
  }
  if (origin && !allowedOrigins.has(origin)) {
    return send(res, 403, { code: 'INVALID_ORIGIN', message: 'Origin not permitted.' });
  }
  if (req.method === 'OPTIONS' && origin) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && req.url === '/health') {
      await execute('get_state');
      return send(res, 200, { healthy: true, workspace }, origin);
    }
    if (req.method === 'POST' && req.url === '/execute' && origin) {
      const input = await body(req);
      if (typeof input.command !== 'string') throw { code: 'INVALID_REQUEST', message: '缺少操作名称。' };
      return send(res, 200, await execute(input.command, input.payload || {}), origin);
    }
    const reportDownload = req.url?.match(/^\/reports\/([^/]+)\/download$/);
    if (req.method === 'GET' && reportDownload) {
      const report = await execute('get_daily_report', { reportId: decodeURIComponent(reportDownload[1]) });
      const content = Buffer.from(report.content, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`日报-${report.date}-v${report.version}.md`)}`,
        'Cache-Control': 'no-store',
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      });
      return res.end(content);
    }
    const download = req.url?.match(/^\/backups\/([^/]+)\/download$/);
    if (req.method === 'GET' && download) {
      const id = decodeURIComponent(download[1]);
      const state = await execute('get_state');
      const record = state.backups.find((item) => item.id === id);
      if (!record || path.basename(record.filename) !== record.filename) {
        return send(res, 404, { code: 'NOT_FOUND', message: '找不到备份。' }, origin);
      }
      const directory = await realpath(path.join(workspace, 'backups'));
      const file = await realpath(path.join(directory, record.filename));
      if (path.dirname(file) !== directory || !(await stat(file)).isFile()) {
        return send(res, 400, { code: 'INVALID_BACKUP', message: '备份位置无效。' }, origin);
      }
      const bytes = await readFile(file);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        'Cache-Control': 'no-store',
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      });
      return res.end(bytes);
    }
    return send(res, 404, { code: 'NOT_FOUND', message: 'Unknown development route.' }, origin);
  } catch (error) {
    return send(res, 400, { code: error.code || 'INVALID_REQUEST', message: error.message || String(error) }, origin);
  }
});
server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`Development QA bridge: http://127.0.0.1:${port}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 300).unref();
  });
}
