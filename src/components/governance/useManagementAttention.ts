import { useCallback, useEffect, useState } from 'react';
import { execute } from '../../api';
import { localDay } from '../work/shared';

const DISMISSED_KEY = 'pa:dismissed:management-attention';

function readDismissed(): string {
  try { return localStorage.getItem(DISMISSED_KEY) ?? ''; } catch { return ''; }
}

function writeDismissed(value: string) {
  try { localStorage.setItem(DISMISSED_KEY, value); } catch { /* ignore */ }
}

interface Attention { kind: 'governance' | 'change' | 'deliverable'; id: string; title: string; version: number; reasons: Array<{ kind: string; label: string }> }
export function useManagementAttention(enabled: boolean, revision: string | undefined, refreshRevision: number, projectId = '') {
  const [data, setData] = useState({ count: 0, items: [] as Attention[], signature: '', projectId });
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const date = localDay();
        const result = await execute<{ count: number; items: Attention[] }>('get_management_attention', { date, projectId });
        const signature = `${projectId}:${date}:${result.items.map((item) => `${item.kind}:${item.id}:${item.version}:${[...item.reasons].map((reason) => reason.kind).sort().join(',')}`).sort().join('|')}`;
        if (!cancelled) setData({ ...result, projectId, signature });
      } catch {
        // Keep last valid state across transient failures.
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const focus = () => void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, revision, refreshRevision, projectId]);
  const dismiss = useCallback(() => {
    setDismissed(data.signature);
    writeDismissed(data.signature);
  }, [data.signature]);
  return { ...data, count: data.projectId === projectId ? data.count : 0, items: data.projectId === projectId ? data.items : [], showBanner: data.projectId === projectId && data.count > 0 && data.signature !== dismissed, dismiss };
}
