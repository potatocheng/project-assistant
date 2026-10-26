import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, MessageCircle, RefreshCw, Send, Sparkles } from 'lucide-react';
import { asError, execute } from '../../api';
import type { Evidence } from '../../types';
import { Spinner } from '../ui';
import { formatMoment, WorkEmpty } from '../work/shared';
import { DeliveryError, taskVersion, useAlive } from './shared';
import type { AssistantAnswer, AssistantCitation, DeliveryProps } from './types';
import './delivery.css';
import { PreferencesPanel } from '../MemoryWorkbench';

const QUESTIONS = ['今天先跟进谁？', '本周卡在哪里？', '哪些交付可能延期？', '有哪些待决策事项？', '需求变更审批情况？', '交付验收情况？', '最近有哪些周报？', '有哪些会议准备？'];
const CITATION_KIND: Record<AssistantCitation['kind'], string> = { governance: '风险与决策', change: '需求变更', deliverable: '交付验收', meeting: '会议记录', meeting_action: '会议行动项', weekly_report: '周报', task: '任务', memory: '项目记忆', source_passage: '原文段落', milestone: '里程碑', project: '项目目标', report: '日报', relation: '依赖关系', plan: '每日排期', follow_up: '跟进记录' };

export function AssistantWorkspace({ state, projectId, date, onTaskOpen, onEvidence, onManagementOpen, onMemoryOpen, onChanged }: DeliveryProps & { onEvidence?: (evidence: Evidence) => void }) {
  const [question, setQuestion] = useState('');
  const [useModel, setUseModel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ question: string; answer: AssistantAnswer; version: string } | null>(null);
  const request = useRef(0);
  const alive = useAlive();
  const version = `${taskVersion(state.tasks)}|${state.memories.map((memory) => `${memory.id}:${memory.revision}:${memory.updatedAt}`).join(',')}|preferences:${state.assistantPreferenceVersion ?? 0}|management:${state.managementRevision ?? ''}|reviews:${state.memoryReviewCount}|${state.proposals.map((proposal) => `${proposal.id}:${proposal.status}:${proposal.memoryId ?? ''}`).join(',')}|${state.reports.map((report) => `${report.id}:${report.version}`).join(',')}`;
  const latestVersion = useRef(version); latestVersion.current = version;
  const modelAvailable = state.aiSettings.configured && (state.aiSettings.provider === 'ollama' || state.aiSettings.remoteConsent);
  useEffect(() => { request.current += 1; setResult(null); setLoading(false); setError(''); }, [projectId, date]);
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => { if (!modelAvailable) setUseModel(false); }, [modelAvailable]);
  const ask = async (text: string) => {
    const value = text.trim();
    if (!value || loading) return;
    const id = ++request.current;
    const askedVersion = latestVersion.current;
    setQuestion(value); setLoading(true); setError(''); setResult(null);
    try {
      const answer = await execute<AssistantAnswer>('ask_assistant', { question: value, date, ...(projectId ? { projectId } : {}), useModel });
      if (alive.current && request.current === id) setResult({ question: value, answer, version: askedVersion });
    } catch (caught) { if (alive.current && request.current === id) setError(asError(caught).message); }
    finally { if (alive.current && request.current === id) setLoading(false); }
  };
  const scope = projectId ? state.projects.find((project) => project.id === projectId)?.name ?? '所选项目' : '全部项目';
  const answer = result?.answer;
  return <div className="work-page delivery-page assistant-page">
    <div className="work-page-heading"><div><div className="eyebrow">项目助理</div><h2>项目问答</h2><p>把项目记忆、任务、依赖、排期与交付情况放在一起，回答当前最需要了解的问题。</p></div></div>
    <div className="delivery-scroll assistant-scroll">
      <div className="assistant-scope"><MessageCircle size={15} /><span>{scope}</span><span>以 {date} 评估当前记录</span></div>
      <PreferencesPanel onChanged={onChanged} />
      <form className="assistant-compose" onSubmit={(event) => { event.preventDefault(); void ask(question); }}><label className="field-label" htmlFor="assistant-question">你想了解什么？</label><textarea id="assistant-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={2000} required disabled={loading || !state.projects.length} placeholder="例如：这周上线卡在哪里，今天应该先跟进谁？" /><div className="assistant-compose-footer"><label className="assistant-model-toggle"><input type="checkbox" checked={useModel} onChange={(event) => setUseModel(event.target.checked)} disabled={loading || !modelAvailable} /><span><Sparkles size={13} />使用已配置模型</span></label><button className="button primary" disabled={loading || !question.trim() || !state.projects.length}>{loading ? <Spinner /> : <Send size={14} />}{loading ? '正在整理…' : '提问'}</button></div>{!modelAvailable && <p className="delivery-inline-hint">当前使用本地汇总；在模型设置中完成配置后，可启用模型整理回答。</p>}<DeliveryError message={error} /></form>
      <div className="assistant-suggestions"><span>常用问题</span>{QUESTIONS.map((text) => <button className="button secondary compact" key={text} onClick={() => void ask(text)} disabled={loading || !state.projects.length}>{text}</button>)}</div>
      {loading ? <div className="assistant-answer-loading" role="status"><Spinner /><span>正在检查任务、交付节点与项目记录…</span></div> : answer && result ? <section className="assistant-answer" aria-label="项目问答回答"><div className="assistant-answer-heading"><div><span className={`delivery-status ${answer.mode === 'model' ? 'delivery-status-in_progress' : ''}`}>{answer.mode === 'model' ? '模型整理' : '本地汇总'}</span><span>检查于 {formatMoment(answer.updatedAt)}</span>{answer.dataUpdatedAt && <span>资料最近记录 {formatMoment(answer.dataUpdatedAt)}</span>}</div><button className="text-button" onClick={() => void ask(result.question)}><RefreshCw size={13} />重新检查</button></div><h3>{result.question}</h3>{answer.status === 'partial' && <p className="delivery-inline-hint">部分回答：已列出可核实事实，缺失信息单独说明。</p>}{answer.status === 'conflicted' && <p className="delivery-inline-hint">相关记录存在冲突，请先核对。</p>}{result.version !== version && <p className="assistant-stale-notice">项目记录已有更新，重新检查可获取最新结果。</p>}<div className="assistant-answer-content">{answer.answer}</div>{answer.limitations.length > 0 && <div className="assistant-limitations"><strong>回答范围</strong>{answer.limitations.map((value, index) => <p key={index}>{value}</p>)}</div>}{!answer.grounded && <p className="delivery-inline-hint">当前记录不足以支持完整结论，可补充任务进展或项目资料后重新提问。</p>}
        <div className="assistant-citations"><div className="delivery-section-heading"><h4><FileText size={14} />回答依据</h4><span>{answer.citations.length} 条当前记录</span></div>{answer.citations.length ? answer.citations.map((citation, citationIndex) => <details className="assistant-citation" key={citation.id}><summary><span className="assistant-citation-number">[{citationIndex + 1}]</span><span className="assistant-citation-kind">{CITATION_KIND[citation.kind] ?? '项目记录'}</span><strong>{citation.title || citation.id}</strong><span>{formatMoment(citation.updatedAt)}</span></summary><div><p>{citation.content}</p><div className="assistant-citation-actions">{citation.managementId && onManagementOpen && <button className="text-button" onClick={() => onManagementOpen(citation.kind as import('../../types').ManagementKind, citation.managementId!, citation.projectId || '')}>打开管理记录 <ArrowRight size={12} /></button>}{citation.memoryId && onMemoryOpen && <button className="text-button" onClick={() => onMemoryOpen(citation.memoryId!, citation.projectId)}>打开记忆及版本</button>}{citation.taskId && <button className="text-button" onClick={() => onTaskOpen(citation.taskId!, citation.projectId)}>打开任务 <ArrowRight size={12} /></button>}{citation.evidence?.map((evidence) => onEvidence && <button key={evidence.segmentId} className="text-button" onClick={() => onEvidence(evidence)}><FileText size={12} />{evidence.sourceTitle} · {evidence.locator}</button>)}</div>{!projectId && <small>{state.projects.find((project) => project.id === citation.projectId)?.name ?? '项目记录'}</small>}</div></details>) : <p className="delivery-inline-hint">当前范围暂无可引用的项目记录。</p>}</div>
      </section> : !error && <WorkEmpty title={state.projects.length ? '从一个具体问题开始' : '先创建一个项目'}>{state.projects.length ? '选择常用问题，或询问项目进度、阻塞、交付风险与今天的跟进重点。回答会附上依据，便于回到任务核实。' : '创建项目并记录任务或项目资料后，即可使用统一问答。'}</WorkEmpty>}
    </div>
  </div>;
}
