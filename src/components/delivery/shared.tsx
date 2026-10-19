import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { asError, execute } from '../../api';
import { Spinner } from '../ui';
import { WorkEmpty } from '../work/shared';

export function useAlive() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

export function useDeliveryQuery<T>(command: string, date: string, projectId: string, version: unknown, poll = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadedScope = useRef('');
  const requestedScope = useRef('');
  const scope = `${command}:${date}:${projectId}`;
  const refresh = useCallback(() => { setTick((value) => value + 1); }, []);
  useEffect(() => {
    let cancelled = false;
    if (requestedScope.current !== scope) { setData(null); loadedScope.current = ''; requestedScope.current = scope; }
    setLoading(loadedScope.current !== scope); setError('');
    execute<T>(command, { date, ...(projectId ? { projectId } : {}) })
      .then((result) => { if (!cancelled) { loadedScope.current = scope; setData(result); } })
      .catch((caught) => { if (!cancelled) setError(asError(caught).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [command, date, projectId, version, tick]);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [poll, refresh]);
  const currentScope = requestedScope.current === scope;
  return { data: currentScope ? data : null, error: currentScope ? error : '', loading: !currentScope || loading, refresh };
}

export function DeliveryLoad({ loading, error, retry, title }: { loading: boolean; error: string; retry: () => void; title: string }) {
  if (loading) return <div className="loading-view"><Spinner />正在加载{title}…</div>;
  if (error) return <WorkEmpty title={`${title}暂时无法读取`} action={<button className="button secondary" onClick={retry}><RefreshCw size={14} />重试</button>}>{error}</WorkEmpty>;
  return null;
}

export function DeliveryError({ message }: { message: string }) {
  return message ? <div className="form-error" role="alert"><CircleAlert size={15} /><span>{message}</span></div> : null;
}

export function taskVersion(tasks: Array<{ id: string; version: number }>) {
  return tasks.map((task) => `${task.id}:${task.version}`).join(',');
}
