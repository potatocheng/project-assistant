import { useCallback, useEffect, useRef, useState } from 'react';
import { execute } from '../../api';
import { localDay } from '../work/shared';
import type { FollowUpCenterData } from './types';

const DISMISSED_KEY = 'pa:dismissed:followup-alert';

function readDismissed(): string {
  try { return localStorage.getItem(DISMISSED_KEY) ?? ''; } catch { return ''; }
}

function writeDismissed(value: string) {
  try { localStorage.setItem(DISMISSED_KEY, value); } catch { /* ignore */ }
}

// Refresh the global inbox even while another workspace page is open.
export function useFollowUpAlerts(enabled: boolean, revision: number, projectId = '') {
  const [snapshot, setSnapshot] = useState({ count: 0, firstTitle: '', signature: '', projectId });
  const [dismissed, setDismissed] = useState(readDismissed);
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const current = ++generation.current;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const date = localDay();
        const result = await execute<FollowUpCenterData>('get_follow_up_center', { date, projectId });
        if (!active || current !== generation.current) return;
        const items = result.items.filter((item) => !item.snoozed);
        const signature = `${projectId}:${date}:${items.map((item) => `${item.taskId}:${item.followUpVersion}:${[...item.reasons].map((reason) => reason.kind).sort().join(',')}`).sort().join('|')}`;
        setSnapshot({ count: result.counts.actionable, firstTitle: items[0]?.task.title ?? '', signature, projectId });
      } catch {
        // Keep previous snapshot on transient errors; the next refresh retries.
      } finally { pending = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, revision, projectId]);
  const dismiss = useCallback(() => {
    setDismissed(snapshot.signature);
    writeDismissed(snapshot.signature);
  }, [snapshot.signature]);
  return { ...snapshot, count: snapshot.projectId === projectId ? snapshot.count : 0, showBanner: snapshot.projectId === projectId && snapshot.count > 0 && snapshot.signature !== dismissed, dismiss };
}
