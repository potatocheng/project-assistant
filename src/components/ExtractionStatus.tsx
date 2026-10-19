import { Check, CircleAlert, Globe2, Pause, Play, RefreshCw, Settings2, Square } from 'lucide-react';
import type { AiSettings, Job, Source } from '../types';
import { endpointInfo } from './ModelSettings';
import { Spinner } from './ui';

export function ExtractionStatus({ source, job, settings, busy, onStart, onRetry, onCancel, onSettings }: {
  source?: Source; job?: Job; settings?: AiSettings; busy: string;
  onStart: () => void; onRetry: () => void; onCancel: () => void; onSettings: () => void;
}) {
  if (!source) return <div className="extraction-empty"><p>导入资料后，可自动生成带原文依据的候选。</p><button className="text-button" onClick={onSettings}><Settings2 size={13} />模型设置</button></div>;
  const target = endpointInfo(settings?.baseUrl ?? '');
  const canRun = !!settings?.configured && (target.local || !!settings.remoteConsent);
  const active = job?.status === 'queued' || job?.status === 'running';
  const failed = job?.status === 'failed';
  const cancelled = job?.status === 'cancelled';
  const complete = job?.status === 'succeeded';
  let title = '尚未提取候选';
  let note = settings?.autoExtract ? '自动提取仅影响后续导入。这份资料可单独启动。' : '可手动启动提取，也可以从原文整理候选。';
  if (source.status === 'processing') { title = '正在解析原文'; note = settings?.autoExtract && canRun ? '解析完成后将自动提取候选。' : '解析完成后可选择原文或启动提取。'; }
  else if (source.status === 'failed') { title = '原文尚未完成解析'; note = '请先处理资料解析错误，再启动提取。'; }
  else if (active) { title = job?.status === 'queued' ? '等待提取候选' : '正在提取候选'; note = job?.totalBatches ? `已处理 ${job.completedBatches} / ${job.totalBatches} 批原文` : '正在准备资料与模型请求…'; }
  else if (failed) { title = '候选提取失败'; note = job?.error || '本次处理未完成，可检查设置后重试。'; }
  else if (cancelled) { title = '提取已取消'; note = '后续处理已停止，取消前的请求可能已经发送。'; }
  else if (complete) { const count = job.candidateCount + (job.taskCandidateCount ?? 0); title = count ? `本次生成 ${count} 条候选` : '本次没有新增候选'; note = count ? `${job.candidateCount} 条记忆候选 · ${job.taskCandidateCount ?? 0} 条任务候选。请核对原文后分别确认。` : '可以手动整理原文。已处理过的相同候选不会重复生成。'; }
  else if (!canRun) { title = settings?.configured && !settings.remoteConsent ? '请确认资料发送范围' : '尚未配置模型'; note = '完成模型设置后可提取候选，手动整理仍可使用。'; }

  return <section className={`extraction-status ${failed ? 'extraction-failed' : ''}`} aria-label="资料提取状态">
    <div className="extraction-steps"><span className={source.status === 'processing' ? 'step-active' : source.status === 'ready' ? 'step-done' : ''}>1 解析原文</span><i /><span className={active ? 'step-active' : complete ? 'step-done' : ''}>2 提取候选</span><i /><span>3 人工确认</span></div>
    <div className="extraction-status-title">{active || source.status === 'processing' ? <Spinner /> : failed || source.status === 'failed' ? <CircleAlert size={16} /> : complete ? <Check size={16} /> : cancelled ? <Pause size={16} /> : <Globe2 size={16} />}<h3>{title}</h3></div>
    <p className="extraction-status-note" role={failed ? 'alert' : 'status'}>{note}</p>
    {active && !!job.totalBatches && <progress className="extraction-progress" value={job.completedBatches} max={job.totalBatches} aria-label="提取批次进度" />}
    {(active || complete || failed || cancelled) && job?.model && <div className="extraction-meta"><span>{job.model}</span>{job.attempts > 1 && <span>第 {job.attempts} 次尝试</span>}</div>}
    {!!job?.discardedCount && <p className="discarded-note">{job.discardedCount} 项未通过原文校验，未加入候选。</p>}
    {failed && job?.errorCode && <details className="extraction-error-details"><summary>错误信息</summary><code>{job.errorCode}</code></details>}
    {source.status === 'ready' && <div className="extraction-actions">{active ? <button className="button secondary compact" disabled={!!busy} onClick={onCancel}>{busy === 'cancel-extraction' ? <Spinner /> : <Square size={11} />}取消提取</button> : !canRun ? <button className="button secondary compact" disabled={!!busy} onClick={onSettings}><Settings2 size={13} />配置模型</button> : failed || cancelled ? <button className="button secondary compact" disabled={!!busy} onClick={onRetry}>{busy === 'retry-extraction' ? <Spinner /> : <RefreshCw size={13} />}重新提取</button> : <button className="button secondary compact" disabled={!!busy} onClick={onStart}>{busy === 'start-extraction' ? <Spinner /> : complete ? <RefreshCw size={13} /> : <Play size={12} />}{complete ? '再次提取' : '提取候选'}</button>}{!active && (failed || canRun) && <button className="text-button tiny" disabled={!!busy} onClick={onSettings}>模型设置</button>}</div>}
    {source.status === 'ready' && !active && canRun && <p className="extraction-destination">发送至 {target.host} · 仅生成待确认候选</p>}
  </section>;
}
