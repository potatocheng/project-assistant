import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildPriorRunLedger } from './memory-public-live-budget.mjs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), hash=b=>createHash('sha256').update(b).digest('hex');
const old=JSON.parse(await readFile(path.join(root,'docs/memory-qa-targeted-preregistration.json')));
const state=JSON.parse(await readFile(path.join(root,'.local-data/qa-structured-round-status.json')));
const anchor=async file=>({file,sha256:hash(await readFile(path.join(root,file)))});
const doc={version:'memory-qa-structured-preregistration-v1',registeredAt:null,datasetSha256:old.datasetSha256,model:old.model,
 baselineDevelopment:{...await anchor('docs/memory-public-live-qa-targeted-dev-v4-results.json'),original:{desktopComplete:13,connectorComplete:15,desktopReferencesSufficient:15,connectorReferencesSufficient:15,correctAbstentionPerEntry:1,combinedQaTokens:259312}},
 costReferenceDevelopment:old.costReferenceDevelopment,baselineFull:old.baselineFull,thresholds:old.thresholds,qaCostTargets:old.qaCostTargets,fullTargets:old.fullTargets,
 limits:{development:{maxRequests:1200,maxTokens:6000000,maxFreshAttempts:3,maxDiagnosticPairs:1},full:{maxRequests:2000,maxTokens:12000000}},productionCaps:old.productionCaps,
 historicalRounds:await Promise.all([['qa-targeted','docs/memory-public-live-qa-targeted-dev-v4-results.json'],['qa-calibrated','docs/memory-public-live-qa-calibrated-dev-v3-results.json']].map(async([name,file])=>({name,ledger:await buildPriorRunLedger(root,file,{datasetSha256:old.datasetSha256,model:old.model,tagPrefix:name+'-dev',split:'development'})}))),
 diagnosticFrozenMemory:await anchor('docs/memory-public-live-qa-targeted-dev-v4-results.json'),
 baselineBinary:{file:path.relative(root,state.baseline.binary).replaceAll('\\','/'),sha256:state.baseline.binarySha256,sourceRoot:path.relative(root,state.baseline.sourceRoot).replaceAll('\\','/'),productionSha256:state.baseline.productionSha256},
 diagnostics:{maxPairs:1,questionsPerArm:20,arms:['baseline','candidate'],freeze:'confirmed memory content/facets/current revision/provenance',suppliedPackFrozen:false,baseline:'execute preserved old binary now; no historical answers in paired systems',judges:'unchanged three separated judge systems/prompts/labels; baseline arm makes no judge calls, candidate compares both newly executed outputs',cost:'both arms and all failed fresh development attempts share 1200 requests/6M tokens; historical rounds listed separately'},
 methodology:{development:'fixed 20 development questions, previously examined; not blind',full:'100 fixed regression questions, previously examined; only after all gates pass',truth:'QASPER human labels unchanged; same-model judging is not new human validation; obligation and claim diagnostics are observed traces, not independent correctness truth',source:'no gold or question-specific corpus IDs in production code',incrementalReferences:'Evaluate union of actual selected producer packs, verify each final claim provenance. Each actual call independently <=24 references/36k chars; a union is not one supplied context pack.'}};
await writeFile(path.join(root,'docs/memory-qa-structured-preregistration-draft.json'),JSON.stringify(doc,null,2),{flag:'wx'});
console.log(JSON.stringify({draft:'docs/memory-qa-structured-preregistration-draft.json',historical:doc.historicalRounds.map(r=>({name:r.name,requests:r.ledger.requests,tokens:r.ledger.totalTokens}))}));
