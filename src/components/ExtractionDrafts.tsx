import { useState } from 'react';
import type { ExtractionDraft, MemoryFacets } from '../types';
import { asError, execute } from '../api';

function DraftReview({ draft, onChanged, notify, onEvidence }: { draft: ExtractionDraft; onChanged: () => Promise<unknown>; notify: (message: string, error?: boolean) => void; onEvidence: (ids: string[]) => void }) {
  const [content, setContent] = useState(draft.candidate.content);
  const [facets, setFacets] = useState<MemoryFacets>(draft.candidate.facets);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  async function review(action: 'approve' | 'reject') {
    setBusy(true);
    try {
      await execute('review_extraction_draft', { draftId: draft.id, action, reason, ...(action === 'approve' ? { content, facets } : {}) });
      await onChanged();
      notify(action === 'approve' ? '草稿已审核并生成待确认候选。' : '草稿已忽略，原始输出和原因已保留。');
    } catch (error) { notify(asError(error).message, true); } finally { setBusy(false); }
  }
  return <details className="candidate"><summary>组织范围待审核 · {draft.candidate.content.slice(0, 60)}</summary>
    <p className="field-hint">此草稿未进入正式记忆。请核对主体、角色、否定、条件与日期，逐字引文匹配不代表语义完整。</p>
    {draft.issues.map((issue, index) => <p className="field-hint" key={index}>{issue.field}：{issue.reason}</p>)}
    <button className="text-button tiny" onClick={() => onEvidence(draft.candidate.evidence.map((e) => e.segmentId))}>定位原文</button>
    {draft.candidate.evidence.map((e, i) => <blockquote key={i}>{e.quote}</blockquote>)}
    <label className="field-label">事实正文<textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} disabled={busy} /></label>
    <label className="field-label">主体<input value={facets.entity} onChange={(e) => setFacets({ ...facets, entity: e.target.value })} disabled={busy} /></label>
    <label className="field-label">主题<input value={facets.topic} onChange={(e) => setFacets({ ...facets, topic: e.target.value })} disabled={busy} /></label>
    <label className="field-label">角色<select value={facets.role} onChange={(e) => setFacets({ ...facets, role: e.target.value as MemoryFacets['role'] })} disabled={busy}><option value="">未明确</option><option value="owner">负责人</option><option value="approver">审批人</option><option value="contact">联系人</option></select></label>
    <label className="field-label">适用条件（每行一条）<textarea rows={3} value={facets.conditions.join('\n')} onChange={(e) => setFacets({ ...facets, conditions: e.target.value.split('\n').filter(Boolean) })} disabled={busy} /></label>
    <label className="field-label">生效日期<input type="date" value={facets.validFrom ?? ''} onChange={(e) => setFacets({ ...facets, validFrom: e.target.value || null })} disabled={busy} /></label>
    <label className="field-label">失效日期<input type="date" value={facets.validUntil ?? ''} onChange={(e) => setFacets({ ...facets, validUntil: e.target.value || null })} disabled={busy} /></label>
    <p className="field-hint">保留原文明确的适用范围；修改字段须同时与正文、引文一致。</p>
    <label className="field-label">审核原因<textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} disabled={busy} /></label>
    <label><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={busy} />我已核对事实依据与适用范围</label>
    <div className="candidate-actions"><button className="button secondary compact" disabled={busy || !checked || !reason.trim() || !content.trim()} onClick={() => void review('approve')}>审核并生成候选</button><button className="text-button" disabled={busy || !reason.trim()} onClick={() => void review('reject')}>忽略草稿</button></div>
  </details>;
}

export function ExtractionDrafts(props: { drafts: ExtractionDraft[]; onChanged: () => Promise<unknown>; notify: (message: string, error?: boolean) => void; onEvidence: (ids: string[]) => void }) {
  const pending = props.drafts.filter((draft) => draft.status === 'needs_review');
  if (!pending.length) return null;
  return <section className="candidate-section"><div className="section-title-row"><h3>组织范围待审核</h3><span className="count-badge">{pending.length}</span></div>{pending.map((draft) => <DraftReview key={draft.id} {...props} draft={draft} />)}</section>;
}
