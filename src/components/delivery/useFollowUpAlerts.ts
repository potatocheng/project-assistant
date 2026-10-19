import { useCallback, useEffect, useRef, useState } from 'react';
import { execute } from '../../api';
import { localDay } from '../work/shared';
import type { FollowUpCenterData } from './types';

// Refresh the global inbox even while another workspace page is open.
export function useFollowUpAlerts(enabled: boolean, revision: number) {
  const [snapshot, setSnapshot] = useState({ count: 0, firstTitle: '', signature: '' });
  const [dismissed, setDismissed] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const current = ++generation.current;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const date = localDay();
        const result = await execute<FollowUpCenterData>('get_follow_up_center', { date });
        if (!active || current !== generation.current) return;
        const items = result.items.filter((item) => !item.snoozed);
        const signature = `${date}:${items.map((item) => `${item.taskId}:${item.followUpVersion}:${item.reasons.map((reason) => reason.kind).join(',')}`).sort().join('|')}`;
        setSnapshot({ count: result.counts.actionable, firstTitle: items[0]?.task.title ?? '', signature });
      } catch {
        // Do not present a stale inbox as a current reminder. The next refresh retries.
        if (active && current === generation.current) setSnapshot({ count: 0, firstTitle: '', signature: '' });
      } finally { pending = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [enabled, revision]);
  const dismiss = useCallback(() => setDismissed(snapshot.signature), [snapshot.signature]);
  return { ...snapshot, showBanner: snapshot.count > 0 && snapshot.signature !== dismissed, dismiss };
}
