import { useCallback, useEffect, useState } from 'react';
import { execute } from '../../api';
import { localDay } from '../work/shared';

interface Attention { kind: 'governance' | 'change' | 'deliverable'; id: string; title: string; version: number; reasons: Array<{ kind: string; label: string }> }
export function useManagementAttention(enabled: boolean, revision: string | undefined, refreshRevision: number, projectId = '') {
  const [data, setData] = useState({ count: 0, items: [] as Attention[], signature: '', projectId });
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const date = localDay();
        const result = await execute<{ count: number; items: Attention[] }>('get_management_attention', { date, projectId });
        if (!cancelled) setData({ ...result, projectId, signature: `${projectId}:${date}:${result.items.map((item) => `${item.kind}:${item.id}:${item.version}:${item.reasons.map((reason) => reason.kind).join(',')}`).join('|')}` });
      } catch { if (!cancelled) setData({ count: 0, items: [], signature: '', projectId }); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [enabled, revision, refreshRevision, projectId]);
  const dismiss = useCallback(() => setDismissed(data.signature), [data.signature]);
  return { ...data, count: data.projectId === projectId ? data.count : 0, items: data.projectId === projectId ? data.items : [], showBanner: data.projectId === projectId && data.count > 0 && data.signature !== dismissed, dismiss };
}
