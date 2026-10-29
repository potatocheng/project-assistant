import type { RetentionPolicy } from '../types';

export const defaultRetention: RetentionPolicy = { layer: 'durable', reason: '保留为项目长期记忆', reviewAfter: null };
export const retentionLabels = { durable: '长期记忆', working: '工作状态', clarify: '待澄清', archive: '仅存原文' };

export function RetentionLabel({ policy }: { policy?: RetentionPolicy }) {
  if (!policy) return null;
  const today = new Date().toLocaleDateString('sv-SE');
  const due = policy.layer === 'working' && !!policy.reviewAfter && policy.reviewAfter <= today;
  return <span className="field-hint" title={policy.reason}>{retentionLabels[policy.layer]}{policy.reviewAfter && ` · ${due ? '待复核' : '复核日期'} ${policy.reviewAfter}`}</span>;
}

export function RetentionFields({ value, onChange, disabled, draft = false }: { value: RetentionPolicy; onChange: (value: RetentionPolicy) => void; disabled?: boolean; draft?: boolean }) {
  return <fieldset disabled={disabled}>
    <legend>保留方式</legend>
    <label className="field-label">保存层次<select value={value.layer} onChange={(event) => onChange({ ...value, layer: event.target.value as RetentionPolicy['layer'], reviewAfter: null })}>
      {Object.entries(retentionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label className="field-label">保留理由<textarea rows={2} maxLength={400} required value={value.reason} onChange={(event) => onChange({ ...value, reason: event.target.value })} /></label>
    {value.layer === 'working' && !draft && <label className="field-label">复核日期<input type="date" value={value.reviewAfter ?? ''} onChange={(event) => onChange({ ...value, reviewAfter: event.target.value || null })} /></label>}
    <p className="field-hint">工作状态默认在确认后 7 天复核；到期退出默认问答，原文与历史保留。待澄清、仅存原文的内容不作为当前事实回答。</p>
  </fieldset>;
}
