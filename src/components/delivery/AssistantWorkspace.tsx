import { useEffect, useRef, useState } from 'react';
import { FileText, MessageCircle, RefreshCw, Send, Sparkles } from 'lucide-react';
import { asError, execute } from '../../api';
import { CITATION_KIND, PROJECT_QUESTIONS } from '../../assistant-labels';
import type { Evidence } from '../../types';
import { Spinner } from '../ui';
import { formatMoment } from '../work/shared';
import { DeliveryError, useAlive } from './shared';
import type { AssistantAnswer, DeliveryProps } from './types';
import './delivery.css';
import { PreferencesPanel } from '../MemoryWorkbench';


type Session = { id: string; projectId: string | null; title: string; updatedAt: string };
type Turn = { id: string; question: string; resolvedQuestion: string; answer: AssistantAnswer; favorite: boolean; createdAt: string };
export function AssistantWorkspace({ state, projectId, date, onTaskOpen, onEvidence, onManagementOpen, onMemoryOpen, onChanged, onModelSettings, initialQuestion, onInitialQuestionConsumed }: DeliveryProps & { onModelSettings: () => void; onEvidence?: (evidence: Evidence) => void; initialQuestion?: { id: number; text: string } | null; onInitialQuestionConsumed?: () => void }) {
  const storageKey = `assistant-session:${state.workspace.dataDir}:${projectId}`;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const initialHandled = useRef<number | null>(null);
  const [session, setSession] = useState(''); const [turns, setTurns] = useState<Turn[]>([]);
  const [selected, setSelected] = useState(''); const [question, setQuestion] = useState('');
  const [subject, setSubject] = useState(''); const [followUp, setFollowUp] = useState(true);
  const [useModel, setUseModel] = useState(false); const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false); const [error, setError] = useState('');
  const [historyOffset,setHistoryOffset]=useState(0); const [historyTotal,setHistoryTotal]=useState(0);
  const [favorites, setFavorites] = useState(false); const [tick, setTick] = useState(0);
  const request = useRef(0); const alive = useAlive();
  const modelAvailable = state.aiSettings.configured && (state.aiSettings.provider === 'ollama' || state.aiSettings.remoteConsent);
  useEffect(() => { let active = true; request.current++; setLoading(false); setTurns([]); setHistoryOffset(0);setSubject(''); setSession(''); setError(''); setSessionsReady(false);
    void execute<Session[]>('list_conversations', {projectId}).then(list => { if (!active) return; setSessions(list); const stored = localStorage.getItem(storageKey); setSession(list.find(s => s.id === stored)?.id ?? list[0]?.id ?? ''); setSessionsReady(true); }).catch(e => {if(active)setError(asError(e).message);});
    return () => { active = false; request.current++; };
  }, [projectId, storageKey]);
  useEffect(() => { let active = true; if (!session) {setTurns([]);setSelected('');return;}
    localStorage.setItem(storageKey,session); setHistoryLoading(true);
    void execute<{turns:Turn[];total:number}>('get_conversation',{sessionId:session,offset:historyOffset}).then(result => {if(active){setTurns(result.turns);setHistoryTotal(result.total ?? result.turns.length);const remembered=localStorage.getItem(storageKey+':turn:'+session);const last=result.turns.find(t=>t.id===remembered)??result.turns.at(-1);setSelected(last?.id??''); setSubject(last?.answer.citations.find(c=>c.title)?.title?.slice(0,300) ?? last?.question.slice(0,300) ?? '');}}).catch(e=>{if(active)setError(asError(e).message);}).finally(()=>{if(active)setHistoryLoading(false);});
    return()=>{active=false;};
  },[session,tick,storageKey,historyOffset]);
  useEffect(()=>{if(!modelAvailable)setUseModel(false);},[modelAvailable]);
  useEffect(()=>{if(session&&selected)localStorage.setItem(storageKey+':turn:'+session,selected);},[session,selected,storageKey]);
  const create = async () => {const next=await execute<Session>('create_conversation',{projectId:projectId || null});setSessions(list=>[next,...list]);setSession(next.id);setHistoryOffset(0);setSubject('');setQuestion('');return next.id;};
  const ask = async (text:string,continueSubject=true) => {if(!text.trim()||loading)return;const sequence=++request.current;setLoading(true);setError('');
    try {let id=session;if(!id)id=await create();const result=await execute<{answer:AssistantAnswer;turnId:string;resolvedQuestion:string}>('ask_conversation',{sessionId:id,question:text.trim(),subject,followUp:continueSubject&&followUp,date,useModel});
      if(alive.current&&request.current===sequence){setQuestion('');setTurns(list=>[...list,{id:result.turnId,question:text.trim(),resolvedQuestion:result.resolvedQuestion,answer:result.answer,favorite:false,createdAt:result.answer.updatedAt}]);setSelected(result.turnId);setHistoryOffset(0);setTick(v=>v+1);setSubject(result.answer.citations.find(c=>c.title)?.title?.slice(0,300)??text.slice(0,300));setSessions(await execute<Session[]>('list_conversations',{projectId}));}
    }catch(e){if(alive.current&&request.current===sequence)setError(asError(e).message);}finally{if(alive.current&&request.current===sequence)setLoading(false);}
  };
  const turn=turns.find(t=>t.id===selected); const answer=turn?.answer;
  useEffect(() => {
    if (!initialQuestion || !sessionsReady || initialHandled.current === initialQuestion.id) return;
    initialHandled.current = initialQuestion.id;
    void ask(initialQuestion.text, false);
    onInitialQuestionConsumed?.();
  }, [initialQuestion, sessionsReady]);
  const scope=state.projects.find(p=>p.id===projectId)?.name ?? '全部项目';
  return <div className="work-page delivery-page assistant-page"><div className="work-page-heading"><div><div className="eyebrow">项目助理</div><h2>项目问答</h2><p>连续追问当前记录，历史回答保留当时的引用和用量。</p></div><button className="button secondary" disabled={loading} onClick={()=>void create().catch(e=>setError(asError(e).message))}>新对话</button></div>
    <div className="delivery-scroll assistant-scroll"><details className="assistant-options"><summary>会话与回答设置</summary><div className="assistant-scope"><MessageCircle size={15}/><span>{scope}</span><span>以 {date} 评估当前记录</span><select aria-label="问答会话" value={session} disabled={loading} onChange={e=>{setSession(e.target.value);setHistoryOffset(0);setSubject('');}}><option value="">新对话</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></div>
    <PreferencesPanel onChanged={onChanged}/></details>
    {turns.length>0&&<details className="assistant-options"><summary>对话历史 · {historyTotal} 条</summary><div className="conversation-history"><div className="inbox-toolbar"><strong>对话历史 · 共 {historyTotal} 条</strong><label><input type="checkbox" checked={favorites} onChange={e=>setFavorites(e.target.checked)}/>只看本页收藏</label><button className="text-button" disabled={loading} onClick={()=>setTick(v=>v+1)}>重新读取</button></div>{turns.filter(t=>!favorites||t.favorite).map(t=><button key={t.id} className={t.id===selected?'selected':''} onClick={()=>setSelected(t.id)}><span>{t.favorite?'★ ':''}{t.question}</span><small>{formatMoment(t.createdAt)}</small></button>)}</div></details>}
    {historyTotal>100&&<div className="inbox-toolbar"><button className="button secondary compact" disabled={loading||historyLoading||historyOffset===0} onClick={()=>setHistoryOffset(v=>Math.max(0,v-100))}>较新回答</button><span>从最近第 {historyOffset+1} 条开始</span><button className="button secondary compact" disabled={loading||historyLoading||historyOffset+100>=historyTotal} onClick={()=>setHistoryOffset(v=>v+100)}>较早回答</button></div>}
    {sessions.length>0&&sessions.length%100===0&&<button className="text-button" disabled={loading} onClick={async()=>{try{const older=await execute<Session[]>('list_conversations',{projectId,offset:sessions.length});setSessions(list=>[...list,...older]);}catch(e){setError(asError(e).message);}}}>加载更早的会话</button>}
    {historyLoading&&<p role="status"><Spinner/>正在读取历史…</p>}
    {answer&&turn&&<section className="assistant-answer" aria-label="项目问答回答"><div className="assistant-answer-heading"><span>{answer.mode==='model'?'模型整理':'本地汇总'} · {formatMoment(turn.createdAt)}</span><div><button className="text-button" onClick={async()=>{try{await execute('favorite_answer',{turnId:turn.id,favorite:!turn.favorite});setTurns(list=>list.map(t=>t.id===turn.id?{...t,favorite:!t.favorite}:t));}catch(e){setError(asError(e).message);}}}>{turn.favorite?'取消收藏':'收藏回答'}</button><button className="text-button" disabled={loading} onClick={()=>void ask(turn.resolvedQuestion,false)}><RefreshCw size={13}/>重新核对</button></div></div><h3>{turn.question}</h3>{turn.resolvedQuestion!==turn.question&&<p className="field-hint">本次完整问题：{turn.resolvedQuestion}</p>}<p className="field-hint">历史回答保留生成时的结论；当前项目有变化时请重新核对。</p>{answer.status==='partial'&&<p>部分回答：缺失信息已单列。</p>}<div className="assistant-answer-content">{answer.answer}</div>{answer.limitations?.length>0&&<details className="assistant-limitations"><summary>回答范围</summary>{answer.limitations.map((l,i)=><p key={i}>{l}</p>)}</details>}
    {answer.queryTrace&&<details className="assistant-limitations"><summary>本次用量 · {answer.queryTrace.modelCalls} 次请求 · {answer.queryTrace.reportedTokens?.toLocaleString()??'未报告'} tokens · {(answer.queryTrace.elapsedMs/1000).toFixed(1)} 秒</summary><p>{answer.queryTrace.usageComplete?'提供方用量报告完整':'部分请求未报告用量，不能视为零费用'}</p>{answer.queryTrace.stages?.map((stage,i)=><p key={i}>{stage.stage} · {(stage.elapsedMs/1000).toFixed(1)} 秒 · {stage.usage?.totalTokens??'未知'} tokens {stage.errorCode}</p>)}</details>}
    <div className="assistant-citations"><h4><FileText size={14}/>回答依据 · {answer.citations.length} 条</h4>{answer.citations.map((citation,index)=><details className="assistant-citation" key={citation.id}><summary><span className="assistant-citation-number">[{index+1}]</span><span>{CITATION_KIND[citation.kind]}</span><strong>{citation.title}</strong></summary><div><p>{citation.content}</p><div className="assistant-citation-actions">{citation.memoryId&&<button className="text-button" onClick={()=>onMemoryOpen?.(citation.memoryId!,citation.projectId)}>打开记忆及版本</button>}{citation.taskId&&<button className="text-button" onClick={()=>onTaskOpen(citation.taskId!,citation.projectId)}>打开任务</button>}{citation.managementId&&<button className="text-button" onClick={()=>onManagementOpen?.(citation.kind as import('../../types').ManagementKind,citation.managementId!,citation.projectId||'')}>打开管理记录</button>}{citation.evidence?.map(e=><button className="text-button" key={e.segmentId} onClick={()=>onEvidence?.(e)}>{e.sourceTitle} · {e.locator}</button>)}<button className="text-button" onClick={()=>{setSubject(citation.title);setFollowUp(true);}}>继续问这条记录</button></div></div></details>)}</div></section>}
    <form className="assistant-compose" onSubmit={e=>{e.preventDefault();void ask(question);}}><label className="field-label" htmlFor="assistant-question">{turns.length?'继续提问':'你想了解什么？'}</label>{turns.length>0&&<div className="followup-subject"><label><input type="checkbox" checked={followUp} onChange={e=>setFollowUp(e.target.checked)}/>沿用追问对象</label>{followUp&&<input aria-label="追问对象" value={subject} maxLength={300} onChange={e=>setSubject(e.target.value)} placeholder="写清继续讨论的任务或事项"/>}</div>}<textarea id="assistant-question" value={question} onChange={e=>setQuestion(e.target.value)} rows={3} maxLength={1500} disabled={loading||!state.projects.length} required placeholder="例如：这个事项下一步该跟进谁？"/><div className="assistant-compose-footer"><label><input type="checkbox" checked={useModel} onChange={e=>setUseModel(e.target.checked)} disabled={loading||!modelAvailable} aria-describedby={!modelAvailable ? 'assistant-model-help' : undefined}/><Sparkles size={13}/>使用已配置模型</label><button className="button primary" disabled={loading||!question.trim()||!state.projects.length}>{loading?<Spinner/>:<Send size={14}/>} {loading?'正在核对当前记录…':'提问'}</button></div><DeliveryError message={error}/>{!modelAvailable && <p className="assistant-model-help" id="assistant-model-help">{state.aiSettings.configured ? '当前使用本地汇总，模型尚未启用。' : '当前使用本地汇总，尚未配置 AI 模型。'}<button type="button" className="text-button" onClick={onModelSettings}>{state.aiSettings.configured ? '检查模型设置' : '配置模型'}</button></p>}</form>
    {!turns.length&&<div className="assistant-suggestions">{PROJECT_QUESTIONS.slice(0,3).map(q=><button key={q} className="button secondary compact" disabled={loading} onClick={()=>void ask(q)}>{q}</button>)}</div>}
    </div></div>;
}
