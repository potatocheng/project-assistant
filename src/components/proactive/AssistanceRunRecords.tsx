import { useEffect, useState } from 'react';
import { ChevronDown, History, RefreshCw } from 'lucide-react';
import { execute } from '../../api';
import { Spinner } from '../ui';
import { AssistanceRunRecordsContent } from './AssistanceRunRecordsContent';
import type { AssistanceRunRecordsData } from './AssistanceRunRecordsContent';

export function AssistanceRunRecords({ projectId, revision }: { projectId: string; revision: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ scope: string; data: AssistanceRunRecordsData } | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setFailed(false);
    void execute<AssistanceRunRecordsData>('get_assistance_runs', projectId ? { projectId } : {})
      .then(data => { if (active) setResult({ scope: projectId, data }); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectId, revision, reload]);
  const data = result?.scope === projectId ? result.data : null;
  return <details className="proactive-history assistant-run-records" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><History size={14} />模型分析记录<ChevronDown size={14} /></summary>
    {open && <div>
      <div className="assistant-run-toolbar"><p className="field-hint">查看模型建议的状态与请求额度。</p><button type="button" className="text-button" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} />刷新记录</button></div>
      {loading ? <p className="ai-assistance-status" role="status"><Spinner />正在读取模型分析记录…</p> : failed ? <p className="form-error" role="alert">暂时无法读取模型分析记录，请稍后重试。持续推进仍可使用。</p> : data && <AssistanceRunRecordsContent data={data} projectScoped={!!projectId} />}
    </div>}
  </details>;
}
