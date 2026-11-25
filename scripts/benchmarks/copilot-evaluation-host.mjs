import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';

// A separate, empty workspace for each run. Calls are sequential, as in pm-host.
export async function openEvaluationHost(endpoint, model, embeddingUrl, embeddingModel) {
  const url = new URL(endpoint);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const workspace = await mkdtemp(path.join(tmpdir(), 'cadence-preferences-'));
  const binary = path.resolve(import.meta.dirname, '../../target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host');
  const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  await once(child, 'spawn');
  const ended = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let seq = 0;
  async function call(command, payload) {
    const id = ++seq;
    child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
    const line = await lines.next();
    assert.ok(!line.done, 'pm-host exited before answering');
    const reply = JSON.parse(line.value);
    assert.equal(reply.id, id);
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.data;
  }
  const close = async () => { child.stdin.end(); await ended; };
  try {
    await call('save_ai_settings', { provider: 'openai_compatible', baseUrl: new URL('/v1', url).href, model,
      outputFormat: 'json_schema', timeoutSeconds: 60, remoteConsent: false, autoExtract: false, apiKey: 'local-benchmark' });
    if (embeddingUrl) {
      const vectors = new URL(embeddingUrl);
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(vectors.hostname) && embeddingModel);
      await call('save_semantic_search_settings', { enabled:true, provider:'ollama', baseUrl:vectors.origin,
        model:embeddingModel, timeoutSeconds:15, remoteConsent:false });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { call, close };
}
