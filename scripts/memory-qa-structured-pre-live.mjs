// Mandatory pre-provider check for the new round. Pure local reads.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {budgetCanonical} from './memory-public-live-budget.mjs';
export async function verifyStructuredPreLive(root,{productionSha256,binarySha256,evaluationSha256,diagnosticArm,registration,before=new Date().toISOString()}) {
 const regression=JSON.parse(await readFile(path.join(root,'docs/memory-qa-structured-regressions.json')));
 if(regression.version!=='memory-qa-structured-regressions-v1'||regression.passed!==true||regression.commands?.length!==11||regression.commands.some(c=>c.exitCode!==0)
    ||!Number.isFinite(Date.parse(regression.finishedAt))||Date.parse(regression.finishedAt)>Date.parse(before)
    ||Date.parse(registration.registeredAt)>Date.parse(regression.startedAt))throw new Error('All 11 deterministic structured checks must pass after registration and before provider calls');
 if(budgetCanonical(regression.evaluationSha256)!==budgetCanonical(evaluationSha256))throw new Error('Structured evaluation changed after passing tests');
 const source=diagnosticArm==='baseline'?registration.baselineBinary.productionSha256:regression.productionSha256;
 const binary=diagnosticArm==='baseline'?registration.baselineBinary.sha256:regression.binarySha256;
 if(budgetCanonical(source)!==budgetCanonical(productionSha256)||binary!==binarySha256)throw new Error('Structured executed binary/source differ from tested current code or registered old baseline');
 return {regressions:'docs/memory-qa-structured-regressions.json',finishedAt:regression.finishedAt,commands:11,
  executedSource:diagnosticArm==='baseline'?'registered-old-baseline':'passing-current-regressions'};
}
