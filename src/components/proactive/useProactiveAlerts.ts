import { useCallback, useEffect, useRef, useState } from 'react';
import { execute } from '../../api';
import type { ProactiveCenterData } from './types';

const EMPTY = { count: 0, firstTitle: '', signature: '', automaticEnabled: false, projectId: '' };
const DISMISSED_KEY = 'pa:dismissed:proactive-alerts';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((s): s is string => typeof s === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissed(values: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(values).slice(-32)));
  } catch {
    // ignore storage errors
  }
}

// Reading the persisted inbox never starts a scan or records user activity.
export function useProactiveAlerts(enabled: boolean, refreshRevision: number, projectId = '') {
  const [snapshot, setSnapshot] = useState(() => ({ ...EMPTY, projectId }));
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) { setSnapshot({ ...EMPTY, projectId }); return; }
    const current = ++generation.current;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const result = await execute<ProactiveCenterData>('get_proactive_center', projectId ? { projectId } : {});
        if (!active || generation.current !== current) return;
        const ready = result.actions.filter((action) => action.status === 'ready');
        const signature = `${projectId}:${ready.map((action) => `${action.id}:${action.version}`).sort().join('|')}`;
        setSnapshot({ count: result.counts.ready, firstTitle: ready[0]?.title ?? '', signature, automaticEnabled: result.settings.enabled, projectId });
      } catch {
        // Keep the last known snapshot across transient failures.
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refreshRevision, projectId]);
  const dismiss = useCallback(() => {
    if (!snapshot.signature) return;
    setDismissed((current) => {
      const next = new Set(current).add(snapshot.signature);
      writeDismissed(next);
      return next;
    });
  }, [snapshot.signature]);
  const matchesScope = snapshot.projectId === projectId;
  return {
    ...snapshot,
    count: matchesScope ? snapshot.count : 0,
    firstTitle: matchesScope ? snapshot.firstTitle : '',
    showBanner: enabled && matchesScope && snapshot.automaticEnabled && snapshot.count > 0 && !dismissed.has(snapshot.signature),
    dismiss,
  };
}
