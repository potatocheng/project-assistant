import { useCallback, useEffect, useRef, useState } from 'react';
import { asError, execute } from '../../api';
import type { AppState } from '../../types';
import type { AssistantCitation } from '../delivery/types';

export interface AssistanceItem {
  title: string; analysis: string; action: string; taskId: string | null;
  evidence: Array<{ referenceId: string; quote: string }>;
}
export interface Assistance {
  focus: AssistanceItem[]; risks: AssistanceItem[]; actions: AssistanceItem[];
  questions: string[]; communicationDraft: string; citations: AssistantCitation[];
  generatedAt: string; model: string; mode: 'model'; cached: boolean; fingerprint: string;
  date: string; projectId: string | null; referenceCount: number; limited: boolean; limitations: string[];
}

// Ignore polling object identities and draft saves; regenerate when project evidence changes.
export function assistanceRevision(state: AppState) {
  return JSON.stringify([state.tasks.map(t => [t.id, t.version]), state.memories.map(m => [m.id, m.revision]),
    state.sources.map(s => [s.id, s.sha256, s.status]), state.projects, state.managementRevision,
    state.assistantPreferenceVersion, state.lifecycle, state.assistanceRevision]);
}
const pending = new Map<string, Promise<Assistance>>();
function request(command: string, payload: Record<string, unknown>, key: string) {
  let promise = pending.get(key);
  if (!promise) {
    promise = execute<Assistance>(command, payload);
    pending.set(key, promise);
    void promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); }).catch(() => {});
  }
  return promise;
}

export function useAssistance(command: string, payload: Record<string, unknown>, enabled: boolean, modelKey: string, revision: string) {
  const scope = JSON.stringify([command, payload, modelKey]);
  const [value, setValue] = useState<{ scope: string; revision: string; data: Assistance } | null>(null);
  const [failure, setFailure] = useState({ scope: '', message: '' });
  const [busyScope, setBusyScope] = useState('');
  const [tick, setTick] = useState(0);
  const force = useRef(false);
  const refresh = useCallback(() => { force.current = true; setTick(t => t + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refreshModel = force.current;
    force.current = false;
    setBusyScope(scope); setFailure({ scope, message: '' });
    const timer = window.setTimeout(() => {
      const [, body] = JSON.parse(scope) as [string, Record<string, unknown>];
      const key = JSON.stringify([scope, revision, refreshModel]);
      void request(command, { ...body, refresh: refreshModel }, key)
        .then(data => { if (!cancelled) setValue({ scope, revision, data }); })
        .catch(error => { if (!cancelled) setFailure({ scope, message: asError(error).message }); })
        .finally(() => { if (!cancelled) setBusyScope(''); });
    }, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [command, scope, enabled, revision, tick]);
  const data = enabled && value?.scope === scope ? value.data : null;
  return { data, loading: enabled && busyScope === scope, error: failure.scope === scope ? failure.message : '',
    stale: !!data && value?.revision !== revision, refresh };
}
