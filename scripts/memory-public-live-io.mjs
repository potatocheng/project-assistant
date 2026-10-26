// Full papers and model envelopes stay in ignored local artifacts. Versioned
// reports keep answers, metadata and hashes; scorers resolve verified details.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { publicReportPath } from './memory-public-live-options.mjs';
const root = path.resolve(import.meta.dirname, '..');
const hash = v => createHash('sha256').update(v).digest('hex');
export async function readPublicLiveReport(file) {
  const value = JSON.parse(await readFile(file));
  if (value.artifactKind !== 'compact_public_live_report') return value;
  const target = path.resolve(root, value.detailFile);
  if (!target.startsWith(path.join(root, '.local-data') + path.sep)) throw new Error('Details must be an isolated local artifact');
  const bytes = await readFile(target);
  if (hash(bytes) !== value.detailSha256) throw new Error('Detailed report fingerprint changed');
  const detail = JSON.parse(bytes);
  if (detail.datasetSha256 !== value.datasetSha256) throw new Error('Detailed dataset fingerprint mismatch');
  return detail;
}
export async function savePublicLiveReport(report) {
  const detailFile = path.join(report.workspace, 'results.json');
  const full = JSON.stringify(report);
  await writeFile(path.join(root, detailFile), full);
  const compact = structuredClone(report);
  compact.artifactKind = 'compact_public_live_report';
  compact.detailFile = detailFile; compact.detailSha256 = hash(full);
  compact.detailNote = 'Complete source paragraphs, candidate bodies, full shown references and raw generation outputs are in the ignored local detail artifact; answers and ID-level metadata retained here.';
  for (const d of compact.documents) {
    d.segments = d.segments?.map(({ id, paragraphId, text }) => ({ id, paragraphId, textSha256: hash(text) }));
    d.memories = d.memories.map(m => ({ id: m.id, proposalId: m.proposalId, kind: m.kind, paragraphId: m.paragraphId, contentSha256: hash(m.content), facets: m.facets }));
    if (d.extractionDrafts) d.extractionDrafts = d.extractionDrafts.map(({ candidate, ...draft }) => ({ ...draft, candidateSha256: hash(JSON.stringify(candidate)) }));
    if (d.extraction) {
      for (const name of ['proposals', 'taskProposals']) d.extraction[name] = (d.extraction[name] ?? []).map(p => ({ id: p.id, contentSha256: hash(p.content ?? p.title ?? '') }));
    }
    for (const q of d.questions) for (const value of Object.values(q.entries)) {
      value.generations = value.generations.map(g => ({ receiptId: g.receiptId,
        referenceIds: g.references.map(r => r.id ?? r.memoryId), rawStatus: g.output?.status, rawGrounded: g.output?.grounded }));
      if (value.result) {
        delete value.result.context;
        value.result.citations = (value.result.citations ?? []).map(c => ({ id: c.id, memoryId: c.memoryId, projectId: c.projectId, title: c.title ?? c.sourceTitle, revision: c.revision, kind: c.kind }));
      }
    }
  }
  const output = publicReportPath(root, report);
  await writeFile(output, JSON.stringify(compact, null, 2));
  return output;
}
