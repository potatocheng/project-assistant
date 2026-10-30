// Reproducible external evidence-retrieval fixture. Downloads data, never code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, '.local-data/open-benchmarks');
await mkdir(directory, { recursive: true });
const url = 'https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz';
const expected = 'a28fdf966db827bcee3d873107d6b6669864fb7ca8fbf73a192f5e39191bdb5a';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalized = (text) => text.replace(/\s+/gu, ' ').trim();
const archivePath = path.join(directory, 'qasper-train-dev-v0.3.tgz');
let archive;
try { archive = await readFile(archivePath); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length')) > 25 * 1024 * 1024) throw new Error('Invalid upstream download');
  archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 25 * 1024 * 1024 || sha(archive) !== expected) throw new Error('Upstream checksum mismatch');
  await writeFile(archivePath, archive, { flag: 'wx' });
}
if (sha(archive) !== expected) throw new Error('Cached archive checksum mismatch');
const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
let dev;
for (let offset = 0; offset + 512 <= tar.length;) {
  const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/s, '');
  if (!name) break;
  const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid archive member');
  if (name.split('/').at(-1) === 'qasper-dev-v0.3.json') dev = tar.subarray(offset + 512, offset + 512 + size);
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!dev) throw new Error('Pinned validation split not found');
const raw = JSON.parse(dev), eligible = [], skipped = { noAnnotations: 0, disagreement: 0, nonTextEvidence: 0 };
for (const [paperId, paper] of Object.entries(raw)) {
  const paragraphs = paper.full_text.flatMap((section, si) => section.paragraphs.map((content, pi) => ({
    id: `${paperId}:s${si}:p${pi}`, content, section: section.section_name,
  }))).filter((p) => p.content.trim());
  const queries = [];
  for (const qa of paper.qas) {
    const answers = qa.answers.map((a) => a.answer);
    if (!answers.length) { skipped.noAnnotations++; continue; }
    const unanswerable = answers.every((a) => a.unanswerable === true);
    if (!unanswerable && answers.some((a) => a.unanswerable === true)) { skipped.disagreement++; continue; }
    const acceptableEvidenceSets = answers.filter((a) => !a.unanswerable).map((a) => (a.evidence ?? []).map((evidence) =>
      paragraphs.filter((p) => normalized(p.content) === normalized(evidence)).map((p) => p.id)))
      .filter((groups) => groups.length && groups.every((g) => g.length));
    if (!unanswerable && !acceptableEvidenceSets.length) { skipped.nonTextEvidence++; continue; }
    queries.push({ id: qa.question_id, question: qa.question, answerable: !unanswerable, acceptableEvidenceSets,
      expectedAnswers: answers.map((a) => ({ unanswerable: a.unanswerable, extractiveSpans: a.extractive_spans,
        yesNo: a.yes_no, freeForm: a.free_form_answer })) });
  }
  // Question choice is fixed by ID hash, independent of the retrieval result.
  queries.sort((a, b) => sha(a.id).localeCompare(sha(b.id)));
  if (queries.length) eligible.push({ id: paperId, title: paper.title, paragraphs, queries });
}
eligible.sort((a, b) => sha(`pm-public-v1:${a.id}`).localeCompare(sha(`pm-public-v1:${b.id}`)));
const documents = [];
for (const [split, quota] of [['development', 20], ['holdout', 80]]) {
  let count = 0;
  while (count < quota && eligible.length) {
    const paper = eligible.shift();
    paper.queries = paper.queries.slice(0, Math.min(4, quota - count));
    count += paper.queries.length;
    documents.push({ ...paper, split, sourceHash: sha(JSON.stringify(paper.paragraphs)) });
  }
}
const dataset = { version: 'qasper-memory-retrieval-v1', provenance: {
  kind: 'external_human_annotated', dataset: 'QASPER v0.3 validation', url,
  license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  citation: 'Dasigi et al. (2021), A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers.',
  homepage: 'https://huggingface.co/datasets/allenai/qasper', archiveSha256: expected, validationSha256: sha(dev),
  adaptation: 'Deterministic paper-disjoint 20/80 question split; all full-text paragraphs retained. Text-only evidence matches; no translation, model-generated labels, question-specific extraction or ranking tuning.',
}, documents };
const serialized = JSON.stringify(dataset, null, 2), output = path.join(directory, 'qasper-memory-v1.json');
try { await writeFile(output, serialized, { flag: 'wx' }); } catch (error) {
  if (error.code !== 'EEXIST' || await readFile(output, 'utf8') !== serialized) throw error;
}
const manifest = { ...dataset.provenance, version: dataset.version, datasetSha256: sha(serialized),
  fixture: path.relative(root, output), sourcePapers: Object.keys(raw).length, selectedPapers: documents.length,
  selectedQuestions: documents.flatMap((p) => p.queries).length, skipped,
  documents: documents.map((p) => ({ id: p.id, split: p.split, sourceHash: p.sourceHash, paragraphs: p.paragraphs.length,
    questions: p.queries.map((q) => ({ id: q.id, answerable: q.answerable })) })) };
await writeFile(path.join(root, 'docs/memory-public-dataset-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ fixture: output, datasetSha256: manifest.datasetSha256, papers: documents.length, questions: manifest.selectedQuestions, skipped }));
