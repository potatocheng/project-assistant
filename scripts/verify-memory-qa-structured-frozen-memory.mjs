// Real process snapshot-copy verification, zero provider requests.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {readPublicLiveReport} from './memory-public-live-io.mjs';
import {copyFrozenPaperWorkspace,assertFrozenHostMemory} from './memory-qa-structured-freeze.mjs';
const root=path.resolve(import.meta.dirname,'..'),state=JSON.parse(await readFile(path.join(root,'.local-data/qa-structured-round-status.json'))),
 report=await readPublicLiveReport(path.join(root,'docs/memory-public-live-qa-targeted-dev-v4-results.json'));
await mkdir(path.join(root,'.local-data'),{recursive:true});const dir=await mkdtemp(path.join(root,'.local-data/qa-structured-frozen-process-'));
const results=[];
for(const [i,paper]of report.documents.entries()) {
 const dest=path.join(dir,`paper-${i}`),copy=await copyFrozenPaperWorkspace(root,paper,dest),child=spawn(state.baseline.binary,[dest],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true}),lines=createInterface({input:child.stdout}),pending=new Map();let seq=0,stderr='';
 child.stderr.on('data',b=>stderr+=b);lines.on('line',line=>{const r=JSON.parse(line),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.ok?p.resolve(r.data):p.reject(new Error(r.error.message));});
 child.on('error',e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();});
 const host={call:(command,payload={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Frozen process timeout'));},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,command,payload})+'\n');})};
 try { await assertFrozenHostMemory(host,paper); results.push({paperId:paper.id,memories:paper.memories.length,copy,passed:true}); }
 finally {const end=once(child,'exit');child.kill('SIGTERM');await end;lines.close();}
 if(stderr)throw new Error('Unexpected frozen baseline process diagnostic stderr');
}
const result={version:'memory-qa-structured-frozen-process-v1',recordedAt:new Date().toISOString(),providerRequests:0,binarySha256:state.baseline.binarySha256,passed:results.length===6&&results.every(r=>r.passed),workspace:path.relative(root,dir),results};
await writeFile(path.join(dir,'evidence.json'),JSON.stringify(result,null,2));
await writeFile(path.join(root,'docs/memory-qa-structured-frozen-process.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,papers:results.length,memories:results.reduce((n,r)=>n+r.memories,0),providerRequests:0,evidence:'docs/memory-qa-structured-frozen-process.json'}));
