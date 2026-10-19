import { useState } from 'react';
import { Check, FileText } from 'lucide-react';
import { KIND_LABELS } from '../types';
import type { MemoryKind, Proposal } from '../types';
import { Dialog, Spinner } from './ui';

export function ProposalEditor({ proposal, busy, close, submit }: {
  proposal: Proposal; busy: string; close: () => void;
  submit: (payload: { proposalId: string; kind: MemoryKind; content: string }) => Promise<void>;
}) {
  const [kind, setKind] = useState(proposal.kind);
  const [content, setContent] = useState(proposal.content);
  return <Dialog title="编辑候选" subtitle="修改内容后，仍需确认才能成为正式记忆。" busy={!!busy} close={close} wide><form onSubmit={(event) => { event.preventDefault(); if (content.trim()) void submit({ proposalId: proposal.id, kind, content: content.trim() }); }}><div className="dialog-body"><label className="field-label" htmlFor="edit-proposal-kind">记录类型</label><select id="edit-proposal-kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} disabled={!!busy}>{Object.entries(KIND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><label className="field-label spaced" htmlFor="edit-proposal-content">候选内容</label><textarea id="edit-proposal-content" rows={7} value={content} onChange={(event) => setContent(event.target.value)} required maxLength={20000} disabled={!!busy} /><div className="proposal-edit-evidence"><FileText size={16} /><p>原有 {proposal.segmentIds.length} 处原文依据会保留。请确保修改后的内容仍由这些原文支持。</p></div>{proposal.origin === 'ai' && <p className="field-hint">AI 来源与模型记录会保留，并标记为已编辑。</p>}</div><div className="dialog-footer"><button type="button" className="button secondary" onClick={close} disabled={!!busy}>取消</button><button className="button primary" disabled={!!busy || !content.trim()}>{busy === 'edit-proposal' ? <Spinner /> : <Check size={15} />}保存候选</button></div></form></Dialog>;
}
