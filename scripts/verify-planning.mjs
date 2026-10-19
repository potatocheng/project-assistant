// Public Rust-process proof; no external service is contacted.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
const root=path.resolve(import.meta.dirname,'..');
await mkdir(path.join(root,'.local-data'),{recursive:true});
const workspace=await mkdtemp(path.join(root,'.local-data','planning-proof-'));
const binary=path.join(root,'target','debug',process.platform==='win32'?'pm-host.exe':'pm-host');
const now=new Date();const day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
function startHost() {
  const child = spawn(binary, [workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const reply = JSON.parse(line);
    const request = pending.get(reply.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.data);
    else request.reject(Object.assign(new Error(reply.error?.message), reply.error));
  });
  child.on('error', (error) => {
    for (const request of pending.values()) request.reject(error);
  });
  child.on('exit', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Rust host exited before reply.'));
    }
    pending.clear();
  });
  return {
    call(command, payload = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout: ${command}`)), 30000);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      lines.close();
    },
  };
}

let host=startHost();const checks=[];
try {
 const p=await host.call('create_project',{name:'交付项目 · 排期验收'});
 const make=(title,extra={})=>host.call('create_task',{projectId:p.id,title,description:'验收隔离工作区',category:'action',assignee:null,priority:'medium',status:'todo',progress:0,dueDate:null,plannedDate:null,workDate:day,clientRequestId:crypto.randomUUID(),...extra});
 const a=await make('确认接口约定',{dueDate:day});const b=await make('上线联调',{dueDate:day});
 const c=await make('跟进外部验收环境',{category:'follow_up',assignee:'业务方'});const d=await make('整理归档材料',{priority:'low'});await make('整理归档材料',{priority:'low'});
 await assert.rejects(host.call('generate_daily_plan',{date:day,projectId:p.id}));
 const capacity=await host.call('save_daily_capacity',{date:day,minutes:120,bufferMinutes:30,baseRevision:null});
 for(const [task,minutes] of [[a,30],[b,60],[c,15],[d,30]]) await host.call('save_task_estimate',{taskId:task.id,baseVersion:task.version,baseUpdatedAt:null,minutes});
 const analysis=await host.call('analyze_task_workload',{date:day,projectId:p.id,useModel:false});const merge=analysis.result.changes.find(c=>c.kind==='merge');assert(merge);
 await host.call('confirm_planning_draft',{draftId:analysis.id,selectedIds:[merge.id]});
 const relation=await host.call('preview_task_relation',{date:day,projectId:p.id,kind:'dependency',taskId:b.id,targetId:a.id,reason:'接口约定确认后才能开始联调'});
 assert.equal((await host.call('get_daily_planning',{date:day,projectId:p.id})).relations.filter(r=>r.kind==='dependency').length,0);
 await host.call('confirm_planning_draft',{draftId:relation.id,selectedIds:[relation.result.changes[0].id]});
 const before=await host.call('get_state');const plan=await host.call('generate_daily_plan',{date:day,projectId:p.id});
 assert.deepEqual((await host.call('get_state')).tasks,before.tasks);assert.equal(plan.result.scheduledMinutes,90);assert.deepEqual(plan.result.items.map(t=>t.taskId),[a.id,b.id]);assert(plan.result.deferred.length>=2);
 checks.push('mandatory daily capacity; explicit duplicate merge and dependency review; drafts never modify task state');
 const revised=await host.call('generate_daily_plan',{date:day,projectId:p.id,durationOverrides:{[b.id]:40},skipTaskIds:[d.id]});
 assert(revised.result.scheduledMinutes<=90);assert.equal(revised.result.items.find(t=>t.taskId===b.id).minutes,40);
 await host.call('confirm_planning_draft',{draftId:revised.id,selectedIds:[]});
 assert.equal((await host.call('confirm_planning_draft',{draftId:revised.id,selectedIds:[]})).duplicate,true);
 await assert.rejects(host.call('confirm_planning_draft',{draftId:plan.id,selectedIds:[]}));
 checks.push('duration and skip changes require a fresh preview; approved order is capacity-bounded and confirmation is idempotent');
 const overview=await host.call('get_daily_planning',{date:day,projectId:p.id});assert.equal(overview.capacity.minutes,120);assert.equal(overview.allocations.length,3);
 const pending=await host.call('generate_daily_plan',{date:day,projectId:p.id});const backup=await host.call('create_backup');const bytes=await readFile(path.join(workspace,'backups',backup.filename));
 await host.stop();host=startHost();
 const after=await host.call('get_daily_planning',{date:day,projectId:p.id});assert.deepEqual(after.allocations,overview.allocations);assert.deepEqual(after.relations,overview.relations);
 await host.call('restore_backup',{filename:backup.filename,contentBase64:bytes.toString('base64'),confirmation:'RESTORE'});
 await assert.rejects(host.call('confirm_planning_draft',{draftId:pending.id,selectedIds:[]}));
 const restored=await host.call('get_daily_planning',{date:day,projectId:p.id});assert.deepEqual(restored.allocations,overview.allocations);assert.equal(restored.capacity.revision,capacity.revision);
 checks.push('real process restart and archive restore preserve capacity, graph and approved plan; pending previews cannot apply after restore');
 const result={passed:true,workspace,day,projectId:p.id,checks};await writeFile(path.join(workspace,'verification.json'),JSON.stringify(result,null,2));process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
} finally {await host.stop();}
