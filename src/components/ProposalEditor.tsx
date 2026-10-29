import { useState } from 'react';
import { RetentionFields, defaultRetention } from './RetentionFields';
import type { RetentionPolicy } from '../types';
import { Check, FileText } from 'lucide-react';
import { KIND_LABELS } from '../types';
import type { MemoryKind, Proposal } from '../types';
import { Dialog, Spinner } from './ui';

export function ProposalEditor({ proposal, busy, close, submit }: {
  proposal: Proposal; busy: string; close: () => void;
  submit: (payload: { proposalId: string; kind: MemoryKind; content: string; retention: RetentionPolicy }) => Promise<void>;
}) {
  const [kind, setKind] = useState(proposal.kind);
  const [content, setContent] = useState(proposal.content);
  const [retention, setRetention] = useState(proposal.retention ?? defaultRetention);
  return <Dialog title="编辑候选" subtitle="保存修改后，再确认加入项目记忆。" busy={!!busy} close={close} wide><form onSubmit={(event) => { event.preventDefault(); if (content.trim()) void submit({ proposalId: proposal.id, kind, content: content.trim(), retention }); }}><div className="dialog-body"><RetentionFields value={retention} onChange={setRetention} disabled={!!busy} /><label className="field-label" htmlFor="edit-proposal-kind">记忆类型</label><select id="edit-proposal-kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} disabled={!!busy}>{Object.entries(KIND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><label className="field-label spaced" htmlFor="edit-proposal-content">内容</label><textarea id="edit-proposal-content" rows={7} value={content} onChange={(event) => setContent(event.target.value)} required maxLength={20000} disabled={!!busy} /><div className="proposal-edit-evidence"><FileText size={16} /><p>保留 {proposal.segmentIds.length} 处原文依据，修改后的内容应与原文一致。</p></div>{proposal.origin === 'ai' && <p className="field-hint">保留 AI 来源与模型记录，并标记为已编辑。</p>}</div><div className="dialog-footer"><button type="button" className="button secondary" onClick={close} disabled={!!busy}>取消</button><button className="button primary" disabled={!!busy || !content.trim()}>{busy === 'edit-proposal' ? <Spinner /> : <Check size={15} />}保存修改</button></div></form></Dialog>;
}
