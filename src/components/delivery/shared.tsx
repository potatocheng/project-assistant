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
  const [refreshError, setRefreshError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const loadedScope = useRef('');
  const requestedScope = useRef('');
  const requestSequence = useRef(0);
  const inFlight = useRef<{ scope: string; id: number } | null>(null);
  const refreshPending = useRef(false);
  const scope = `${command}:${date}:${projectId}`;
  const refresh = useCallback(() => {
    if (inFlight.current?.scope === scope || refreshPending.current) return;
    refreshPending.current = true;
    if (loadedScope.current === scope) setRefreshing(true);
    else setLoading(true);
    setError(''); setRefreshError('');
    setTick((value) => value + 1);
  }, [scope]);
  useEffect(() => {
    let cancelled = false;
    const id = ++requestSequence.current;
    inFlight.current = { scope, id };
    refreshPending.current = false;
    if (requestedScope.current !== scope) { setData(null); loadedScope.current = ''; requestedScope.current = scope; }
    const hasData = loadedScope.current === scope;
    setLoading(!hasData); setRefreshing(hasData); setError(''); setRefreshError('');
    execute<T>(command, { date, ...(projectId ? { projectId } : {}) })
      .then((result) => { if (!cancelled) { loadedScope.current = scope; setData(result); } })
      .catch((caught) => { if (!cancelled) (hasData ? setRefreshError : setError)(asError(caught).message); })
      .finally(() => {
        if (inFlight.current?.id === id) inFlight.current = null;
        if (!cancelled) { setLoading(false); setRefreshing(false); }
      });
    return () => { cancelled = true; if (inFlight.current?.id === id) inFlight.current = null; };
  }, [command, date, projectId, version, tick]);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [poll, refresh]);
  const currentScope = requestedScope.current === scope;
  return { data: currentScope ? data : null, error: currentScope ? error : '', refreshError: currentScope ? refreshError : '', loading: !currentScope || loading, refreshing: currentScope && refreshing, refresh };
}

export function DeliveryLoad({ loading, error, refreshError, refreshing, retry, title }: { loading: boolean; error: string; refreshError?: string; refreshing?: boolean; retry: () => void; title: string }) {
  if (loading) return <div className="loading-view"><Spinner />正在加载{title}…</div>;
  if (error) return <WorkEmpty title={`${title}暂时无法读取`} action={<button className="button secondary" onClick={retry}><RefreshCw size={14} />重试</button>}>{error}</WorkEmpty>;
  if (refreshError) return <div className="form-error" role="alert"><CircleAlert size={15} /><span>更新失败，仍显示上次读取的{title}。{refreshError}</span><button className="text-button tiny" onClick={retry} disabled={refreshing}>重新更新</button></div>;
  return null;
}

export function DeliveryError({ message }: { message: string }) {
  return message ? <div className="form-error" role="alert"><CircleAlert size={15} /><span>{message}</span></div> : null;
}

export function taskVersion(tasks: Array<{ id: string; version: number }>) {
  return tasks.map((task) => `${task.id}:${task.version}`).join(',');
}
