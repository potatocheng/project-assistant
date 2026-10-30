import { useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import type { AppState, Task } from '../../types';
import { useDraftState } from '../../drafts';
import { Spinner } from '../ui';
import { assistanceRevision, useAssistance } from './assistance';
import { AssistanceContent, AssistanceMeta } from './AssistanceContent';
import './assistance.css';

export function AiTaskCoach({ task, date, state, reason, onModelSettings }: { task: Task; date: string; state: AppState; reason: string; onModelSettings?: () => void }) {
  const draft = useDraftState(`task:ai-coach:${task.id}`, { situation: '', communication: null as string | null });
  const [situation, setSituation] = useState<string | null>(null);
  useEffect(() => { if (draft.ready && situation === null) setSituation(draft.value.situation.trim()); }, [draft.ready, draft.value.situation, situation]);
  const [copied, setCopied] = useState('');
  const query = useAssistance('generate_task_coaching', { date, projectId: task.projectId, taskId: task.id, reason, situation },
    state.aiSettings.configured && draft.ready && situation !== null, JSON.stringify([state.workspace.dataDir, state.aiSettings]), assistanceRevision(state));
  const communication = draft.value.communication ?? query.data?.communicationDraft ?? '';
  return <div className="ai-task-coach" aria-busy={query.loading}>
    <div className="ai-coach-actions"><strong>结合项目资料，帮你推进</strong>{state.aiSettings.configured && <button className="text-button tiny" disabled={query.loading} onClick={query.refresh}><RefreshCw size={13} />重新分析</button>}</div>
    {!state.aiSettings.configured ? <p className="ai-assistance-status">配置 AI 模型后，可结合这个任务的资料、依赖和跟进记录给出具体建议。{onModelSettings && <button className="text-button" onClick={onModelSettings}>配置模型</button>}也可以先使用下方通用引导。</p> : <>
      <label className="field-label" htmlFor={`ai-situation-${task.id}`}>补充当前情况 <span>可选</span></label>
      <textarea id={`ai-situation-${task.id}`} value={draft.value.situation} disabled={!draft.ready} maxLength={1500} rows={2} placeholder="例如：对方说接口还没准备好，我该先协调什么？" onChange={e => draft.setValue({ ...draft.value, situation: e.target.value })} />
      <button className="text-button" disabled={query.loading || !draft.ready} onClick={() => { const next = draft.value.situation.trim(); if (next === situation) query.refresh(); else setSituation(next); }}>结合补充情况分析</button>
      {query.loading && <p className="ai-assistance-status" role="status"><Spinner />正在核对这个任务的资料、依赖和跟进记录…</p>}
      {query.error && <div className="ai-assistance-status form-error" role="alert"><span>推进分析未完成：{query.error}</span><button className="text-button" disabled={query.loading} onClick={query.refresh}>重试分析</button></div>}
      {query.stale && <p className="ai-assistance-status">项目资料已变化，以下为上次建议，需重新核对。</p>}
      {query.data && <><AssistanceContent data={query.data} coach />
        {(query.data.communicationDraft || draft.value.communication !== null) && <><label className="field-label" htmlFor={`ai-communication-${task.id}`}>沟通草稿 <span>可修改，核对后发送</span></label>
          <textarea id={`ai-communication-${task.id}`} value={communication} disabled={!draft.ready} rows={5} maxLength={5000} onChange={e => { draft.setValue({ ...draft.value, communication: e.target.value }); setCopied(''); }} />
          <div className="ai-coach-actions"><button className="button secondary compact" disabled={!draft.ready || query.stale || !communication.trim()} onClick={async () => { try { await navigator.clipboard.writeText(communication); setCopied('已复制，请核对联系人与时间后自行发送。'); } catch { setCopied('复制失败，请选中草稿后按 Ctrl+C 复制。'); } }}><Copy size={13} />复制沟通草稿</button>
            {draft.value.communication !== null && <button className="text-button tiny" disabled={query.stale} onClick={() => { draft.setValue({ ...draft.value, communication: query.data!.communicationDraft }); setCopied(''); }}>采用本次 AI 草稿</button>}</div>
          <p className="field-hint" role="status">{copied || (draft.value.communication !== null ? '已保留你编辑的草稿，可采用本次 AI 草稿替换。' : '草稿由 AI 建议生成，发送前请确认事实和表达。')}</p></>}
        <AssistanceMeta data={query.data} /></>}
      {draft.status.includes('失败') && <p className="form-error" role="alert">{draft.status}</p>}
    </>}
  </div>;
}
