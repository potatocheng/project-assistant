import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { asError, execute } from './api';

export const WorkspaceDraftContext = createContext('');
type Draft = { body: unknown; version: number };
const queues = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
const failures=new Map<string,unknown>();
let pending = 0;
export async function settleDrafts() { await Promise.all([...queues.values()]); if(failures.size)throw [...failures.values()][0]; }
export function resetDraftVersions() { versions.clear(); failures.clear(); }
export const hasPendingDrafts = () => pending > 0 || failures.size > 0;
export async function readDraft<T>(key: string): Promise<T | null> {
  await queues.get(key)?.catch(() => undefined);
  const result = await execute<Draft>('get_draft', { key });
  versions.set(key, result.version);
  return result.body as T | null;
}
function enqueue(key: string, body: unknown, remove: boolean) {
  pending++;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    if (!versions.has(key)) {
      const result = await execute<Draft>('get_draft', { key }); versions.set(key, result.version);
    }
    const result = await execute<Draft>(remove ? 'delete_draft' : 'save_draft', { key, body, baseVersion: versions.get(key) });
    versions.set(key, result.version); failures.delete(key);
  }).catch(error=>{failures.set(key,error);throw error;}).finally(() => { pending--; if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
  return next;
}
export const writeDraft = (key: string, body: unknown) => enqueue(key, body, false);
export const clearDraft = (key: string) => enqueue(key, null, true);

// Every edit is queued immediately; navigation does not cancel the durable write.
export function useDraftState<T>(key: string, initial: T) {
  const workspace = useContext(WorkspaceDraftContext);
  const [value, set] = useState(initial);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('正在读取草稿…');
  const valueRef = useRef(value); valueRef.current = value;
  const alive = useRef(true);
  const sequence = useRef(0);
  useEffect(() => {
    alive.current = true; let active = true; setReady(false);
    readDraft<T>(key).then(saved => {
      if (!active) return;
      if (saved !== null) { valueRef.current = saved; set(saved); setStatus('已恢复本机草稿，请核对后保存'); }
      else {valueRef.current=initial;set(initial);setStatus('编辑内容自动暂存到本机');}
      setReady(true);
    }).catch(error => { if (active) setStatus(`草稿读取失败：${asError(error).message}`); });
    return () => { active = false; alive.current = false; };
  }, [key, workspace]);
  const setValue: Dispatch<SetStateAction<T>> = next => {
    if (!ready) return;
    const resolved = typeof next === 'function' ? (next as (v: T) => T)(valueRef.current) : next;
    valueRef.current = resolved; set(resolved); setStatus('正在暂存…');
    const version = ++sequence.current;
    void writeDraft(key, resolved).then(() => { if (alive.current && sequence.current === version) setStatus('草稿已暂存到本机'); })
      .catch(error => { if (alive.current) setStatus(`暂存失败，请保留窗口：${asError(error).message}`); });
  };
  const clear = () => clearDraft(key);
  const discard = async () => { await clear(); valueRef.current = initial; set(initial); setStatus('已丢弃草稿'); };
  return { value, setValue, ready, status, clear, discard };
}

export function DraftStatus({ status, discard }: { status: string; discard?: () => Promise<void> }) {
  const [error, setError] = useState('');
  return <div className="draft-status" role="status"><span>{error || status}</span>{discard && <button type="button" className="text-button tiny" onClick={() => void discard().catch(e => setError(asError(e).message))}>丢弃草稿</button>}</div>;
}
