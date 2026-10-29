import {useRef,useState} from 'react';
import {asError,execute} from '../../api';
import type {Task} from '../../types';
import {Dialog,Spinner} from '../ui';
import {ListPager} from '../ListPager';
import {localDay} from './shared';

export function BatchScheduleDialog({tasks:initial,day,close,onSaved}:{tasks:Task[];day:string;close:()=>void;onSaved:()=>Promise<void>}) {
  // Freeze versions on opening: changed tasks must be reviewed again, never silently overwritten.
  const [tasks]=useState(initial);const [selected,setSelected]=useState<Set<string>>(new Set());
  const [query,setQuery]=useState('');const [page,setPage]=useState(0);const [plannedDate,setDate]=useState(day);
  const [workDate,setWorkDate]=useState(localDay());const [note,setNote]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const request=useRef(crypto.randomUUID());const touch=()=>{request.current=crypto.randomUUID();setError('');};
  const rows=tasks.filter(t=>`${t.title} ${t.assignee??''}`.toLowerCase().includes(query.toLowerCase()));
  const visible=rows.slice(page*50,(page+1)*50);
  return <Dialog title="批量安排任务日期" subtitle="最多100项；任一任务版本变化时整批停止，请重新打开核对。" close={close} busy={busy} wide><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await execute('batch_schedule_tasks',{tasks:tasks.filter(t=>selected.has(t.id)).map(t=>({taskId:t.id,baseVersion:t.version})),plannedDate,workDate,note,clientRequestId:request.current});await onSaved();}catch(e){setError(asError(e).message);}finally{setBusy(false);}}}><div className="dialog-body"><fieldset disabled={busy} className="draft-fields"><input aria-label="筛选批量任务" placeholder="搜索任务或负责人" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><div className="inbox-toolbar"><span>已选 {selected.size} 项</span><button type="button" className="text-button" onClick={()=>{setSelected(new Set([...selected,...visible.map(t=>t.id)].slice(0,100)));touch();}}>选择本页</button><button type="button" className="text-button" onClick={()=>{setSelected(new Set());touch();}}>清空选择</button></div><div className="batch-task-list">{visible.map(t=><label key={t.id}><input type="checkbox" checked={selected.has(t.id)} disabled={!selected.has(t.id)&&selected.size>=100} onChange={e=>{setSelected(current=>{const next=new Set(current);if(e.target.checked)next.add(t.id);else next.delete(t.id);return next;});touch();}}/><span>{t.title}<small>{t.assignee||'负责人待定'} · {t.plannedDate||'未排期'} · v{t.version}</small></span></label>)}</div><ListPager page={page} total={rows.length} onChange={setPage}/><div className="task-form-grid"><label>计划日期<input type="date" value={plannedDate} required onChange={e=>{setDate(e.target.value);touch();}}/></label><label>进展日期<input type="date" value={workDate} required onChange={e=>{setWorkDate(e.target.value);touch();}}/></label></div><label className="field-label spaced">排期说明<textarea value={note} maxLength={10000} required onChange={e=>{setNote(e.target.value);touch();}}/></label></fieldset>{error&&<p className="inline-error" role="alert">{error}</p>}</div><div className="dialog-footer"><button type="button" className="button secondary" onClick={close} disabled={busy}>取消</button><button className="button primary" disabled={busy||!selected.size||!note.trim()||!plannedDate||!workDate}>{busy&&<Spinner/>}保存 {selected.size} 项排期</button></div></form></Dialog>;
}
