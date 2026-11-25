import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [dir, version = 'first'] = process.argv.slice(2);
assert.ok(['first','release','embedding'].includes(version));
const read = async name => JSON.parse(await readFile(path.join(dir, name+'.json'), 'utf8'));
const names = version === 'first'
  ? ['fresh-before','fresh-after','fresh-profiles','fresh-input-before','fresh-selection','controls-before','controls-after']
  : ['confirmation-before','confirmation-'+version,'confirmation-profiles','confirmation-before-input',
     'selection-'+version,'controls-before','controls-'+version];
const [before, after, profiles, inputs, traces, controlBefore, controlAfter] = await Promise.all(names.map(read));
const key = row => row.topic+'/'+row.index;
function exactPairedP(gains, losses) {
  const n = gains + losses;
  let mass = .5 ** n, tail = mass;
  for (let i = 1; i <= Math.min(gains,losses); i++) {
    mass *= (n-i+1)/i;
    tail += mass;
  }
  return Math.min(1,2*tail);
}
const count = (rows, predicate) => rows.filter(predicate).length;
const rows = before.cases.map((old,i) => {
  const next = after.cases[i], profile = profiles[i], trace = traces[i], input = inputs[i];
  assert.ok([next,profile,trace,input].every(r=>key(r)===key(old)));
  assert.equal(old.expected,next.expected);
  const id = createHash('sha256').update('prefeval-v1/'+key(old)).digest('hex');
  const target = profile.habits.find(h=>h.id===id);
  assert.ok(target);
  const matchedBefore = (input.messages[0].content+'\n').includes('\n- [工作流] '+target.instruction+'\n');
  const indices = trace.selectorResult?.indices;
  const valid = Array.isArray(indices) && indices.length<=4 &&
    indices.every(x=>Number.isInteger(x) && x>0 && x<=profile.habits.length);
  return {topic:old.topic, before:old.correct, after:next.correct, matchedBefore,
    matchedAfter:trace.selected.includes(id), focused:(trace.focus??trace.selected).includes(id),
    shown:trace.selected.length, latency:trace.durationMs,
    valid, error:trace.error};
});
const gains = count(rows,r=>!r.before&&r.after), losses = count(rows,r=>r.before&&!r.after);
const latencies = rows.map(r=>r.latency).sort((a,b)=>a-b);
function controls(results) {
  const byMode = Object.fromEntries(['left','right','override'].map(mode=>{
    const items = results.filter(r=>r.mode===mode);
    return [mode,{correct:count(items,r=>r.correct),n:items.length,errors:count(items,r=>r.error)}];
  }));
  const tasks = [...new Set(results.map(r=>r.task))];
  const bothDirections = count(tasks,task=>['left','right'].every(mode=>
    results.some(r=>r.task===task && r.mode===mode && r.correct)));
  return {...byMode,bothDirections};
}
const topics = [...new Set(rows.map(r=>r.topic))];
const topicChanges = topics.map(topic=>rows.filter(r=>r.topic===topic)
  .reduce((net,r)=>net+Number(r.after)-Number(r.before),0));
const summary = {
  n:rows.length,before:before.correct,after:after.correct,gains,losses,exactMcNemarP:exactPairedP(gains,losses),
  topics:{improved:count(topicChanges,d=>d>0),same:count(topicChanges,d=>d===0),declined:count(topicChanges,d=>d<0)},
  targetInPrompt:{ before:count(rows,r=>r.matchedBefore),after:count(rows,r=>r.matchedAfter),focused:count(rows,r=>r.focused),
    lost:count(rows,r=>r.matchedBefore&&!r.matchedAfter) },
  correctWhenTargetInPrompt:{before:count(rows,r=>r.matchedBefore&&r.before),after:count(rows,r=>r.matchedAfter&&r.after)},
  selection:{valid:count(rows,r=>r.valid),errors:count(rows,r=>r.error),empty:count(rows,r=>!r.shown),
    meanShown:rows.reduce((sum,r)=>sum+r.shown,0)/rows.length,
    medianMs:latencies[Math.floor(rows.length*.5)],p95Ms:latencies[Math.ceil(rows.length*.95)-1]},
  controls:{before:controls(controlBefore),after:controls(controlAfter)},
};
console.log(JSON.stringify(summary,null,2));
