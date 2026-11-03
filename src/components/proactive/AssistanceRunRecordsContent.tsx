import type { AssistanceQueryTrace } from '../assistance/assistance';
import { formatMoment } from '../work/shared';

export interface AssistanceRunRecordsData {
  runs: Array<{
    runId: string; status: 'running' | 'succeeded' | 'failed' | 'interrupted';
    request: { kind: 'brief' | 'coach' }; createdAt: string; updatedAt: string;
    unresolvedRequest: boolean; errorCode: string | null;
    queryTrace: Pick<AssistanceQueryTrace, 'modelCalls' | 'reportedTokens' | 'usageComplete' | 'stages'>;
  }>;
  total: number; offset: number;
  budget: { date: string; reservedRequests: number; reportedTokens: number; unknownUsageRequests: number; globalRequestLimit: number; projectRequestLimit: number };
}

const STATUS = { running: '分析中', succeeded: '已完成核验', failed: '分析未完成', interrupted: '已中断' };

function ReportedUsage({ tokens, unknown, requests }: { tokens: number; unknown: number; requests: number }) {
  if (!requests) return <span>尚无模型请求，未产生已报告用量。</span>;
  if (unknown > 0 && tokens === 0) return <span>{unknown} 次请求尚未报告 tokens，实际用量未知，不能按零消耗计算。</span>;
  return <span>已报告 {tokens.toLocaleString('zh-CN')} tokens。{unknown > 0 && `另有 ${unknown} 次请求未报告用量，实际总量未知。`}</span>;
}

export function AssistanceRunRecordsContent({ data, projectScoped }: { data: AssistanceRunRecordsData; projectScoped: boolean }) {
  const { budget } = data;
  return <>
    <div className="assistant-run-budget">
      <p><strong>{budget.date} · {projectScoped ? '本项目' : '全部项目'}模型建议额度</strong></p>
      <p>已占用 {budget.reservedRequests} / {projectScoped ? budget.projectRequestLimit : budget.globalRequestLimit} 次请求额度（含已预留、失败和中断的请求）。</p>
      <p><ReportedUsage tokens={budget.reportedTokens} unknown={budget.unknownUsageRequests} requests={budget.reservedRequests} /></p>
      <p>{projectScoped ? `本项目还受全部项目每日 ${budget.globalRequestLimit} 次请求上限约束；此处未读取全局余量。` : `单个项目每日最多 ${budget.projectRequestLimit} 次请求。`}一次完整建议包含生成与核验，共 2 次请求；复用已有分析不新增请求。</p>
      <p>持续推进的本地规则整理与到期复查不调用模型，不占此额度。</p>
    </div>
    <p className="field-hint">{data.total ? `当前范围最近 ${Math.min(data.runs.length, 10)} 条分析记录（共 ${data.total} 条，可能包含往日记录）。以下用量属于各次原分析，不是本次查看新增的消耗。` : '当前范围暂无模型分析记录。生成今日建议或任务建议后，可在这里查看处理状态。'}</p>
    {data.runs.slice(0, 10).map(run => {
      const requests = run.queryTrace.modelCalls + (run.unresolvedRequest ? 1 : 0);
      const unknown = run.queryTrace.stages.filter(stage => !stage.usage).length + (run.unresolvedRequest ? 1 : 0);
      return <article key={run.runId}>
        <div><strong>{run.request.kind === 'coach' ? '任务建议' : '今日建议'} · {STATUS[run.status] || '状态待确认'}</strong><time dateTime={run.createdAt}>{formatMoment(run.createdAt)}</time></div>
        <p>原分析请求数：{requests} 次{run.unresolvedRequest && '（含 1 次结果未确认的预留请求）'}。<ReportedUsage tokens={run.queryTrace.reportedTokens} unknown={unknown} requests={requests} /></p>
        {run.status === 'interrupted' && <p>{run.errorCode === 'RESTORE_PAUSED' ? '恢复备份时中断了这次分析。' : run.errorCode === 'RESTART_INTERRUPTED' ? '应用重启时中断了这次分析。' : '这次分析已中断。'}已发出的请求可能产生用量，不会按零消耗处理。</p>}
        {run.status === 'failed' && <p>这次分析未完成，未生成可用建议；已发生的请求仍计入额度。</p>}
        {run.status === 'running' && <p>分析正在进行，已报告用量可能继续变化。可刷新记录查看结果。</p>}
      </article>;
    })}
  </>;
}
