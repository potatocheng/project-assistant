import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const parent=path.resolve(tmpdir());const root=await mkdtemp(path.join(parent,'pa-scale-'));
const host=spawn(path.resolve(process.platform==='win32'?'target/debug/pm-host.exe':'target/debug/pm-host'),[root],{stdio:['pipe','pipe','inherit']});
let seq=0;const pending=new Map();let closed=false;
const exit=new Promise(resolve=>host.on('exit',()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Host exited'));}resolve();}));
createInterface({input:host.stdout}).on('line',line=>{const reply=JSON.parse(line);const p=pending.get(reply.id);if(!p)return;pending.delete(reply.id);clearTimeout(p.timer);reply.ok?p.resolve(reply.data):p.reject(new Error(JSON.stringify(reply.error)));});
const call=(command,payload={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${command} timed out`));},30000);pending.set(id,{resolve,reject,timer});host.stdin.write(JSON.stringify({id,command,payload})+'\n');});
try{
 const project=await call('create_project',{name:'Synthetic scale acceptance'});
 for(let i=0;i<1500;i++)await call('create_task',{projectId:project.id,title:`scale fixture ${String(i).padStart(4,'0')}`,description:'Synthetic local-only benchmark',category:'action',assignee:null,priority:'medium',status:'todo',progress:0,dueDate:null,plannedDate:null,workDate:'2026-10-28',clientRequestId:randomUUID()});
 const start=performance.now();const state=await call('get_state');const fullMs=performance.now()-start;
 const tick=performance.now();const revision=await call('get_workspace_revision');const revisionMs=performance.now()-tick;
 const search=performance.now();const first=await call('search_workspace',{query:'scale fixture',kind:'task'});const second=await call('search_workspace',{query:'scale fixture',kind:'task',offset:50});const searchMs=performance.now()-search;
 assert.equal(first.total,1500);assert.equal(first.items.length,50);assert.equal(second.items.length,50);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,100);
 assert.equal(revision.revision,state.workspace.revision);assert(JSON.stringify(revision).length<JSON.stringify(state).length/100);
 console.log(JSON.stringify({tasks:1500,stateBytes:Buffer.byteLength(JSON.stringify(state)),revisionBytes:Buffer.byteLength(JSON.stringify(revision)),fullMs:Math.round(fullMs),revisionMs:Math.round(revisionMs),twoSearchPagesMs:Math.round(searchMs),modelCalls:0},null,2));
}finally{
 if(!closed){host.stdin.end();await exit;}
 const relative=path.relative(parent,path.resolve(root));
 if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.startsWith('pa-scale-'))throw new Error('Refusing cleanup outside generated temporary workspace');
 await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
