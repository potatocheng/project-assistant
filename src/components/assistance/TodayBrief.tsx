import { RefreshCw } from 'lucide-react';
import type { AppState } from '../../types';
import { Spinner } from '../ui';
import { assistanceRevision, useAssistance } from './assistance';
import { AssistanceContent, AssistanceMeta } from './AssistanceContent';
import './assistance.css';

export function TodayBrief({ state, date, projectId, onTaskOpen, onModelSettings }: { state: AppState; date: string; projectId: string; onTaskOpen: (id: string, projectId: string) => void; onModelSettings: () => void }) {
  const enabled = state.aiSettings.configured;
  const hasRecords = state.projects.some(project => !projectId || project.id === projectId);
  const query = useAssistance('generate_today_brief', { date, projectId }, enabled && hasRecords, JSON.stringify([state.workspace.dataDir, state.aiSettings]), assistanceRevision(state));
  return <section className="ai-today-brief" aria-labelledby="ai-today-heading" aria-busy={query.loading}>
    <div className="ah-section-heading"><h2 id="ai-today-heading">今天先做这些 <small>AI 建议</small></h2>{enabled && hasRecords && <button className="ah-link" onClick={query.refresh} disabled={query.loading}><RefreshCw size={13} />{query.loading ? '正在分析…' : '重新分析'}</button>}</div>
    {!enabled ? <p className="ai-assistance-status">配置 AI 模型后，助理会结合项目资料整理今日重点、风险和下一步行动。<button className="text-button" onClick={onModelSettings}>配置模型</button></p>
      : !hasRecords ? <p className="ai-assistance-status">先创建任务或导入项目资料，助理就能开始分析今天该关注什么。</p>
      : <>{query.loading && <p className="ai-assistance-status" role="status"><Spinner />{query.data ? '正在结合最新项目资料重新分析…' : '正在阅读项目资料，整理今日重点与行动…'}</p>}
        {query.error && <div className="ai-assistance-status form-error" role="alert"><span>今日分析未完成：{query.error}</span><button className="text-button" onClick={query.refresh} disabled={query.loading}>重试分析</button></div>}
        {query.stale && <p className="ai-assistance-status">项目资料已变化，以下为上次分析，需重新核对。</p>}
        {query.data && <><AssistanceContent data={query.data} onTaskOpen={onTaskOpen} /><AssistanceMeta data={query.data} /></>}
      </>}
  </section>;
}
