// Offline, human-labelled atomic quality evaluation. Never calls a model.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ratio = (a, b) => b ? a / b : null;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const statuses = new Set(['answered', 'partial', 'unknown', 'conflicted']);
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const isBool = (v) => typeof v === 'boolean';
const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] : null;

export function scoreDataset(data) {
  requireValue(data.version === 'memory-quality-v1' && Array.isArray(data.cases), 'Unsupported dataset');
  requireValue(['synthetic', 'real_deidentified', 'external_human_annotated'].includes(data.provenance?.kind), 'Declare material provenance');
  const splits = new Map(), ids = new Set();
  for (const c of data.cases) {
    requireValue(typeof c.id === 'string' && c.id && !ids.has(c.id), 'Duplicate/missing case ID'); ids.add(c.id);
    requireValue(['development', 'holdout', 'unassigned'].includes(c.split), `${c.id}: invalid split`);
    requireValue(typeof c.projectGroup === 'string' && c.projectGroup, `${c.id}: project group required`);
    for (const key of [`project:${c.projectGroup}`, ...(c.sourceHashes ?? []).map((v) => `source:${v}`)]) {
      if (c.split === 'unassigned') continue;
      requireValue(!splits.has(key) || splits.get(key) === c.split, `Development/holdout leakage: ${key}`);
      splits.set(key, c.split);
    }
  }
  return {
    version: data.version, provenance: data.provenance, caseCount: data.cases.length,
    independentBusinessBenchmark: data.provenance.kind === 'real_deidentified'
      && data.provenance.independentReview === true && !!data.provenance.reviewer
      && data.cases.some((c) => c.split === 'holdout'),
    development: scoreCases(data.cases.filter((c) => c.split === 'development')),
    holdout: scoreCases(data.cases.filter((c) => c.split === 'holdout')),
    unassigned: scoreCases(data.cases.filter((c) => c.split === 'unassigned')),
  };
}

function scoreCases(cases) {
  let proposed = 0, labelled = 0, correct = 0, gold = 0, recalled = 0, extractionComplete = true;
  let claimCount = 0, labelledClaims = 0, supported = 0, relevant = 0, cited = 0, scoped = 0;
  let judgedAnswers = 0, statusCorrect = 0, fullySupportedAnswers = 0, answerCount = 0;
  let correctAnswerTokens = 0, tokenObservations = 0, totalTokens = 0, allTokenObservations = 0, protocolErrors = 0;
  const errors = {}, latencies = [];
  for (const c of cases) {
    if (c.extraction) {
      const e = c.extraction;
      requireValue(Array.isArray(e.goldAtoms) && Array.isArray(e.candidates), `${c.id}: extraction arrays required`);
      const goldIds = new Set(e.goldAtoms.map((g) => g.id));
      requireValue(goldIds.size === e.goldAtoms.length, `${c.id}: duplicate gold atoms`);
      const found = new Set();
      extractionComplete &&= e.goldComplete === true;
      gold += e.goldAtoms.length;
      for (const candidate of e.candidates) {
        requireValue(candidate.atoms?.length > 0, `${c.id}: every candidate must be atomized`);
        extractionComplete &&= candidate.segmentationReviewed === true;
        for (const atom of candidate.atoms) {
          proposed++;
          if (!isBool(atom.correct)) { extractionComplete = false; continue; }
          labelled++;
          if (atom.correct) {
            requireValue(goldIds.has(atom.matchesGoldId), `${c.id}: correct atom lacks a gold match`);
            // Duplicate extraction is not a second true positive.
            if (!found.has(atom.matchesGoldId)) { correct++; found.add(atom.matchesGoldId); }
            else errors.duplicate = (errors.duplicate ?? 0) + 1;
          } else errors[atom.errorKind || 'unspecified'] = (errors[atom.errorKind || 'unspecified'] ?? 0) + 1;
        }
      }
      recalled += found.size;
    }
    if (c.answer) {
      answerCount++;
      const a = c.answer;
      if (a.error) protocolErrors++;
      if (Number.isFinite(a.totalTokens) && a.totalTokens >= 0) { totalTokens += a.totalTokens; allTokenObservations++; }
      requireValue(statuses.has(a.actualStatus) && Array.isArray(a.claims), `${c.id}: invalid answer`);
      requireValue(!['answered', 'partial'].includes(a.actualStatus) || a.claims.length > 0, `${c.id}: grounded answer has no claims`);
      if (Number.isFinite(a.elapsedMs) && a.elapsedMs >= 0) latencies.push(a.elapsedMs);
      let complete = a.segmentationReviewed === true;
      let allGood = true;
      for (const atom of a.claims) {
        claimCount++;
        const judged = ['supported', 'relevant', 'citationComplete', 'scopeCorrect'].every((f) => isBool(atom[f]));
        complete &&= judged;
        if (judged) {
          labelledClaims++;
          supported += Number(atom.supported); relevant += Number(atom.relevant);
          cited += Number(atom.citationComplete); scoped += Number(atom.scopeCorrect);
          allGood &&= atom.supported && atom.relevant && atom.citationComplete && atom.scopeCorrect;
        }
      }
      if (complete && statuses.has(a.expectedStatus) && isBool(a.requestSatisfied)) {
        judgedAnswers++;
        statusCorrect += Number(a.actualStatus === a.expectedStatus);
        if (!a.error && allGood && a.actualStatus === a.expectedStatus && a.requestSatisfied) {
          fullySupportedAnswers++;
          if (Number.isFinite(a.totalTokens) && a.totalTokens >= 0) { correctAnswerTokens += a.totalTokens; tokenObservations++; }
        }
      }
    }
  }
  const allAnswersLabelled = judgedAnswers === answerCount;
  const allClaimsLabelled = allAnswersLabelled && labelledClaims === claimCount;
  return {
    cases: cases.length,
    extraction: {
      proposedAtoms: proposed, labelledAtoms: labelled, annotationCoverage: ratio(labelled, proposed), complete: proposed > 0 && extractionComplete,
      precision: extractionComplete ? ratio(correct, proposed) : null,
      recall: extractionComplete ? ratio(recalled, gold) : null,
      goldAtoms: gold, matchedGoldAtoms: recalled, errors,
    },
    answer: {
      cases: answerCount, protocolErrors, judgedAnswers, claims: claimCount, labelledClaims,
      annotationCoverage: ratio(labelledClaims, claimCount), complete: answerCount > 0 && allAnswersLabelled,
      assertionSupportRate: allClaimsLabelled ? ratio(supported, claimCount) : null,
      irrelevantClaimRate: allClaimsLabelled ? ratio(claimCount - relevant, claimCount) : null,
      citationCompleteness: allClaimsLabelled ? ratio(cited, claimCount) : null,
      scopeCorrectRate: allClaimsLabelled ? ratio(scoped, claimCount) : null,
      statusAccuracy: allAnswersLabelled ? ratio(statusCorrect, answerCount) : null,
      usefulAndSupportedAnswerRate: allAnswersLabelled ? ratio(fullySupportedAnswers, answerCount) : null,
      p50Ms: quantile(latencies, .5), p95Ms: quantile(latencies, .95), latencyObservations: latencies.length,
      meanTokensOfCorrectAnswers: ratio(correctAnswerTokens, tokenObservations), tokenObservations,
      totalTokensPerUsefulAnswer: allTokenObservations===answerCount ? ratio(totalTokens, fullySupportedAnswers) : null,
      totalReportedTokens: totalTokens, tokenCoverage: ratio(allTokenObservations, answerCount),
    },
  };
}

export function annotationTemplate(live, bytes) {
  const cases = [];
  for (const [entry, observations] of Object.entries(live.goldQa ?? {})) {
    for (const row of observations) {
      const claims = row.claims?.length ? row.claims : [{ text: row.answer }];
      const usage = row.queryTrace?.usageComplete ? row.queryTrace.reportedTokens : null;
      cases.push({ id: `${entry}:${row.id}`, projectGroup: `shared-corpus:${live.datasetSha256 ?? hash(bytes)}`,
        sourceHashes: [live.datasetSha256 ?? hash(bytes)], split: 'unassigned', question: row.question,
        answer: { actualStatus: row.status ?? (row.grounded ? 'answered' : 'unknown'), expectedStatus: null,
          requestSatisfied: null, segmentationReviewed: false, elapsedMs: row.elapsedMs, totalTokens: usage,
          error: row.error ?? null, errorCode: row.errorCode ?? null, answerText: row.answer, citations: row.citations,
          claims: row.grounded ? claims.map((c) => ({ ...c, supported: null, relevant: null, citationComplete: null, scopeCorrect: null })) : [] } });
    }
  }
  for (const row of live.extraction ?? []) {
    cases.push({ id: `extraction:${row.id}`, projectGroup: `document:${hash(row.sourceText ?? row.id)}`, sourceHashes: [hash(row.sourceText ?? row.id)], split: 'unassigned',
      sourceText: row.sourceText, extraction: { goldComplete: false, goldAtoms: [],
        candidates: [...(row.candidates ?? []), ...(row.tasks ?? [])].map((c) => ({ id: c.id, snapshot: c, segmentationReviewed: false,
          atoms: [{ text: c.content ?? `${c.title}: ${c.description}`, correct: null, matchesGoldId: null, errorKind: null }] })) } });
  }
  return { version: 'memory-quality-v1', provenance: { kind: 'synthetic', independentReview: false, reviewer: null, importedResultsSha256: hash(bytes) }, cases };
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
  requireValue(output, 'Usage: node scripts/evaluate-memory-quality.mjs [--init] input.json --output output.json');
  const input = args[0] === '--init' ? args[1] : args[0];
  requireValue(input && input !== '--output' && input !== output, 'Use distinct input and output files');
  const bytes = await readFile(input);
  const data = JSON.parse(bytes);
  const result = args[0] === '--init' ? annotationTemplate(data, bytes) : { ...scoreDataset(data), inputSha256: hash(bytes), recordedAt: new Date().toISOString() };
  await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(`Saved ${output}; no model requests. Unlabelled semantic scores remain null.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
