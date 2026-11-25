import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { asError, execute } from './api';

export const WorkspaceDraftContext = createContext('');
type Draft = { body: unknown; version: number };
const queues = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
const failures=new Map<string,unknown>();
const pendingFlushes = new Map<string, () => Promise<void>>();
let pending = 0;
export async function settleDrafts() {
  await Promise.all([...pendingFlushes.values()].map(flush => flush().catch(() => undefined)));
  await Promise.all([...queues.values()]);
  if(failures.size)throw [...failures.values()][0];
}
export function resetDraftVersions() { versions.clear(); failures.clear(); }
export const hasPendingDrafts = () => pending > 0 || pendingFlushes.size > 0 || failures.size > 0;
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
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  const [status, setStatus] = useState('正在读取草稿…');
  const valueRef = useRef(value); valueRef.current = value;
  const alive = useRef(true);
  const sequence = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);
  const loadDraft = () => {
    let active = true;
    setReady(false);
    readDraft<T>(key).then(saved => {
      if (!active) return;
      if (saved !== null) {
        valueRef.current = saved;
        set(saved);
        setHasSavedDraft(true);
        setStatus('已恢复上次未保存的内容，请核对后保存');
      } else {
        valueRef.current = initial;
        set(initial);
        setHasSavedDraft(false);
        setStatus('输入内容会自动暂存到本机');
      }
      setReady(true);
    }).catch(error => {
      if (!active) return;
      valueRef.current = initial;
      set(initial);
      setHasSavedDraft(false);
      setReady(true);
      setStatus(`暂未读取到旧草稿（${asError(error).message}），当前可正常编辑`);
    });
    return () => { active = false; };
  };
  useEffect(() => {
    alive.current = true;
    const cancelLoad = loadDraft();
    return () => {
      cancelLoad();
      alive.current = false;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
      const flush = pendingFlushes.get(key);
      if (flush) void flush().catch(() => undefined);
    };
  }, [key, workspace]);
  const flushWrite = (resolved: T, version: number) => {
    pendingFlushes.delete(key);
    return writeDraft(key, resolved).then(() => {
      if (alive.current && sequence.current === version) {
        setHasSavedDraft(true);
        setStatus('草稿已暂存到本机');
      }
    }).catch(error => {
      if (alive.current) setStatus(`暂存未能写入，请保留窗口或稍后重试：${asError(error).message}`);
    });
  };
  const setValue: Dispatch<SetStateAction<T>> = next => {
    if (!ready) return;
    const resolved = typeof next === 'function' ? (next as (v: T) => T)(valueRef.current) : next;
    valueRef.current = resolved; set(resolved); setStatus('正在暂存…');
    const version = ++sequence.current;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    pendingFlushes.set(key, () => flushWrite(resolved, version));
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = undefined;
      void flushWrite(resolved, version);
    }, 450);
  };
  const clear = async () => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    pendingFlushes.delete(key);
    await clearDraft(key);
    if (alive.current) setHasSavedDraft(false);
  };
  const discard = async () => { await clear(); valueRef.current = initial; set(initial); setStatus('已恢复初始内容'); };
  return { value, setValue, ready, status, hasSavedDraft, clear, discard };
}

export function DraftStatus({ status, discard, showDiscard = true }: { status: string; discard?: () => Promise<void>; showDiscard?: boolean }) {
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setConfirming(false); }, [status]);
  return <div className="draft-status" role="status"><span>{error || status}</span>{discard && showDiscard && (confirming ? <span className="draft-discard-confirm"><button type="button" className="text-button tiny danger" onClick={() => { setConfirming(false); void discard().catch(e => setError(asError(e).message)); }}>确认丢弃</button><button type="button" className="text-button tiny" onClick={() => setConfirming(false)}>保留</button></span> : <button type="button" className="text-button tiny" onClick={() => setConfirming(true)}>丢弃草稿</button>)}</div>;
}
