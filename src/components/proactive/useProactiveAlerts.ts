import { useCallback, useEffect, useRef, useState } from 'react';
import { execute } from '../../api';
import type { ProactiveCenterData } from './types';

const EMPTY = { count: 0, firstTitle: '', signature: '', automaticEnabled: false };

// Reading the persisted inbox never starts a scan or records user activity.
export function useProactiveAlerts(enabled: boolean, refreshRevision: number) {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) { setSnapshot(EMPTY); return; }
    const current = ++generation.current;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await execute<ProactiveCenterData>('get_proactive_center');
        if (!active || generation.current !== current) return;
        const ready = result.actions.filter((action) => action.status === 'ready');
        const signature = ready.map((action) => `${action.id}:${action.version}`).sort().join('|');
        setSnapshot({ count: result.counts.ready, firstTitle: ready[0]?.title ?? '', signature, automaticEnabled: result.settings.enabled });
      } catch {
        if (active && generation.current === current) {
          // A failed read clears actionable data, while retaining the last known
          // policy so a temporary failure cannot reintroduce duplicate banners.
          setSnapshot((current) => ({ ...EMPTY, automaticEnabled: current.automaticEnabled }));
        }
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [enabled, refreshRevision]);
  const dismiss = useCallback(() => {
    if (snapshot.signature) setDismissed((current) => new Set(current).add(snapshot.signature));
  }, [snapshot.signature]);
  return { ...snapshot, showBanner: enabled && snapshot.automaticEnabled && snapshot.count > 0 && !dismissed.has(snapshot.signature), dismiss };
}
