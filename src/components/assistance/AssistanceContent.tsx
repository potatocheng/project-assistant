import type { Assistance, AssistanceItem } from './assistance';

function AdviceItem({ item, data, onTaskOpen }: { item: AssistanceItem; data: Assistance; onTaskOpen?: (id: string, projectId: string) => void }) {
  const task = data.citations.find(c => c.taskId === item.taskId);
  return <li className="ai-advice-item">
    <h4>{item.title}</h4>
    <p className="ai-advice-next">{item.action}</p>
    <div className="ai-advice-controls">
      <details className="ai-advice-detail"><summary>分析与依据<span> · {item.evidence.length} 条</span></summary>
        <div className="ai-advice-explanation"><h5>判断理由</h5><p>{item.analysis}</p><h5>下一步</h5><p>{item.action}</p>
          <h5>记录依据</h5>{item.evidence.map((e, index) => {
            const citation = data.citations.find(c => c.id === e.referenceId);
            return <blockquote key={index}><p>{e.quote}</p><cite>{citation?.title || '项目记录'}{citation?.evidence?.[0]?.sourceTitle && ` · ${citation.evidence[0].sourceTitle}`}{citation?.evidence?.[0]?.locator && ` · ${citation.evidence[0].locator}`}</cite></blockquote>;
          })}
        </div>
      </details>
      {item.taskId && task?.projectId && onTaskOpen && <button type="button" className="text-button tiny ai-advice-open" onClick={() => onTaskOpen(item.taskId!, task.projectId)}>查看任务</button>}
    </div>
  </li>;
}

export function AssistanceContent({ data, onTaskOpen, coach = false }: { data: Assistance; onTaskOpen?: (id: string, projectId: string) => void; coach?: boolean }) {
  // Primary advice includes the next action. Supporting sections stay on demand.
  const primary = data.focus.length ? data.focus : data.actions.length ? data.actions : data.risks;
  const secondary = [
    { label: '风险', items: data.focus.length || data.actions.length ? data.risks : [] },
    { label: '补充行动', items: data.focus.length ? data.actions : [] },
  ].map(section => ({ ...section, items: section.items.filter(item => !primary.some(p => p.title === item.title && p.action === item.action)) }));
  const extraCount = secondary.reduce((sum, section) => sum + section.items.length, 0) + Math.max(0, primary.length - 3);
  return <div className="ai-assistance-content">
    {primary.length > 0 && <section className="ai-priorities" aria-label={coach ? '建议先做' : '今天先做'}>
      <ol className="ai-advice-list">{primary.slice(0, 3).map((item, index) => <AdviceItem key={index} item={item} data={data} onTaskOpen={onTaskOpen} />)}</ol>
    </section>}
    {extraCount > 0 && <details className="ai-assistance-more"><summary>其他风险与建议<span> · {extraCount} 项</span></summary>
      {primary.length > 3 && <ol className="ai-advice-list">{primary.slice(3).map((item, index) => <AdviceItem key={index} item={item} data={data} onTaskOpen={onTaskOpen} />)}</ol>}
      {secondary.map(section => section.items.length > 0 && <section key={section.label}><h3>{section.label}</h3><ol className="ai-advice-list">{section.items.map((item, index) => <AdviceItem key={index} item={item} data={data} onTaskOpen={onTaskOpen} />)}</ol></section>)}
    </details>}
    {data.questions.length > 0 && <details className="ai-assistance-questions"><summary>待你确认<span> · {data.questions.length} 项</span></summary><ul>{data.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></details>}
    {!primary.length && <p className="field-hint">资料还不足以给出具体行动，请先补充待确认信息。</p>}
  </div>;
}

export function AssistanceMeta({ data }: { data: Assistance }) {
  return <details className="ai-assistance-meta"><summary>AI 分析于 {new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}{data.cached ? ' · 已复用' : ''}<span> · 查看分析范围</span></summary>
    <p>{data.model} · 参考 {data.referenceCount} 条记录。风险判断与行动为建议，请结合实际情况核对。</p>
    {data.limited && <p>仅分析部分相关资料，可切换项目缩小范围。</p>}
    {data.limitations.map((item, index) => <p key={index}>{item}</p>)}
  </details>;
}
