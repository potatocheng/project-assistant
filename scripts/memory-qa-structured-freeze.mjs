import { readFile, readdir, cp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { budgetCanonical } from './memory-public-live-budget.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
export function frozenMemorySemanticHash(paper) {
  return hash(budgetCanonical({ projectId: paper.projectId, sourceId: paper.sourceId, sourceSha256: paper.sourceSha256,
    segments: paper.segments, memories: paper.memories.map(m => ({ id: m.id, content: m.content, facets: m.facets, kind: m.kind,
      quotes: m.quotes, detail: m.detail })) }));
}
export async function copyFrozenPaperWorkspace(root, paper, destination) {
  const source = path.resolve(root, paper.workspace), local = path.resolve(root, '.local-data');
  if (!source.startsWith(local + path.sep) || !path.resolve(destination).startsWith(local + path.sep) || source === path.resolve(destination)) throw new Error('Frozen workspace copy must stay in distinct isolated directories');
  const files = (await readdir(source)).filter(name => /^workspace\.sqlite(?:-wal|-shm)?$/.test(name));
  if (!files.includes('workspace.sqlite')) throw new Error('Frozen memory SQLite missing');
  const hashes = Object.fromEntries(await Promise.all(files.map(async name => [name, hash(await readFile(path.join(source, name)))])));
  await mkdir(destination, { recursive: false });
  for (const name of files) await cp(path.join(source, name), path.join(destination, name));
  try { await cp(path.join(source, 'originals'), path.join(destination, 'originals'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of files) if (hash(await readFile(path.join(source, name))) !== hashes[name]
      || hash(await readFile(path.join(destination, name))) !== hashes[name]) throw new Error('Frozen SQLite changed during copy');
  return { sourceWorkspace: paper.workspace, files: hashes, semanticSha256: frozenMemorySemanticHash(paper),
    note: 'Frozen confirmed memory and provenance; ranking and actual model packs remain production decisions. No frozen supplied-pack claim.' };
}
export async function assertFrozenHostMemory(host, paper) {
  const state = await host.call('get_state');
  const ids = new Set(paper.memories.map(m => m.id)), current = state.memories.filter(m => m.projectId === paper.projectId);
  if (current.length !== ids.size || current.some(m => !ids.has(m.id))) throw new Error('Frozen confirmed memory ID set changed');
  for (const m of paper.memories) if (budgetCanonical(await host.call('get_memory', { memoryId: m.id })) !== budgetCanonical(m.detail)) throw new Error('Frozen confirmed content/facets/revision/evidence changed');
  return true;
}
