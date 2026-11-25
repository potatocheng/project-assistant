import { useEffect, useState } from 'react';
import {
  Activity, BookOpen, CircleAlert, Download, ExternalLink,
  HardDrive, ShieldCheck, Sparkles, TerminalSquare,
} from 'lucide-react';
import { asError, execute, exportDocument, openExternalUrl } from '../api';
import type { AppState } from '../types';
import { AssistanceRunRecords } from './proactive/AssistanceRunRecords';
import { Dialog, Spinner } from './ui';
import './help-feedback.css';

type Tab = 'guide' | 'usage' | 'feedback' | 'about';

interface UsageSummary {
  today: string;
  todayCalls: number;
  todayTokens: number;
  totalCalls: number;
  totalTokens: number;
  maintenanceToday: number;
  usageIncomplete: boolean;
  breakdown: {
    extraction: { calls: number; tokens: number };
    qa: { calls: number; tokens: number };
    assistance: { calls: number; tokens: number };
  };
  model: {
    provider: string;
    model: string;
    configured: boolean;
    isRemote: boolean;
  };
}

function estimateCny(tokens: number): string {
  // 保守按国内主流高性价比模型综合约 ¥1.5 / 1M tokens 估算展示
  const yuan = (tokens / 1_000_000) * 1.5;
  if (tokens === 0) return '¥0.00';
  if (yuan < 0.01) return '< ¥0.01';
  return `约 ¥${yuan.toFixed(2)}`;
}

export function HelpFeedbackDialog({
  state,
  close,
  onModelSettings,
  notify,
}: {
  state: AppState | null;
  close: () => void;
  onModelSettings: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>('guide');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (tab !== 'usage') return;
    let active = true;
    setLoadingUsage(true);
    setUsageError('');
    execute<UsageSummary>('get_usage_summary')
      .then(data => {
        if (active) setUsage(data);
      })
      .catch(caught => {
        if (active) setUsageError(asError(caught).message);
      })
      .finally(() => {
        if (active) setLoadingUsage(false);
      });
    return () => {
      active = false;
    };
  }, [tab]);

  const exportSanitizedDiagnostics = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const diag = await execute<Record<string, unknown>>('get_diagnostics');
      const day = new Date().toISOString().slice(0, 10);
      const saved = await exportDocument({
        title: '循序脱敏诊断报告',
        content: JSON.stringify(diag, null, 2),
        format: 'json',
        filename: `project-assistant-diagnostics-${day}.json`,
      });
      if (saved) notify('脱敏诊断报告已导出（不含项目正文、密钥与个人路径）。');
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog
      title="帮助、隐私与反馈"
      subtitle="上手指南、AI 用量账单估算、本地隐私边界与问题反馈"
      close={close}
      wide
    >
      <div className="dialog-body help-center">
        <div className="segmented-control" role="tablist" aria-label="帮助与反馈分类">
          {([
            ['guide', '快速上手'],
            ['usage', 'AI 用量与隐私'],
            ['feedback', '反馈与诊断'],
            ['about', '关于与版本'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'selected' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'guide' && (
          <div className="help-section" role="tabpanel">
            <div className="help-card-grid">
              <div className="help-card">
                <div className="help-card-step">01 · 导入任何项目资料</div>
                <strong>无需企业审批，直接把资料丢进来</strong>
                <p>
                  支持直接拖拽 <b>Word / Excel / PPT / PDF / CSV / 邮件(EML)</b>，或直接复制粘贴微信、企微、钉钉群聊与腾讯会议转写文稿，系统按段落/页/表格行保留精确原文坐标。
                </p>
              </div>
              <div className="help-card">
                <div className="help-card-step">02 · 2 分钟接上 AI 模型</div>
                <strong>自带密钥，100% 掌控成本与数据</strong>
                <p>
                  内置 DeepSeek、通义千问、豆包、Kimi、智谱、硅基流动预设；也可连本地 Ollama 完全离线运行。开启前会明确弹出外发确认。
                </p>
                <button type="button" className="text-button tiny" onClick={() => { close(); onModelSettings(); }}>
                  去配置模型 →
                </button>
              </div>
              <div className="help-card">
                <div className="help-card-step">03 · 盯卡点 + 一键出汇报</div>
                <strong>看板、甘特时间轴与老板版周报</strong>
                <p>
                  每天先看「今日行动流」清阻塞，项目内随时切「看板视图」或「里程碑时间轴」；傍晚用 AI 切换老板/群对齐/客户版风格，一键导出 Word、汇报长图或 PDF。
                </p>
              </div>
            </div>
            <div className="help-tip-box">
              <Sparkles size={15} />
              <div>
                <strong>进阶玩法：飞书个人助理（可选）</strong>
                <p>如果你所在企业允许创建飞书自建应用，可在「工具与设置 → 飞书助理」绑定群聊或同事私聊，自动同步消息并在群里 @你时按项目证据自动代答。普通使用完全不强制配置飞书。</p>
              </div>
            </div>
          </div>
        )}

        {tab === 'usage' && (
          <div className="help-section" role="tabpanel">
            {loadingUsage ? (
              <p className="field-hint"><Spinner /> 正在汇总本机 AI 用量记录…</p>
            ) : usageError ? (
              <div className="form-error" role="alert"><CircleAlert size={16} /><p>{usageError}</p></div>
            ) : usage && (
              <>
                <div className="help-metrics-grid">
                  <div className="help-metric-card">
                    <span>今日请求数</span>
                    <strong>{usage.todayCalls} 次</strong>
                    <small>{usage.todayTokens.toLocaleString()} tokens</small>
                  </div>
                  <div className="help-metric-card">
                    <span>本机累计请求</span>
                    <strong>{usage.totalCalls} 次</strong>
                    <small>{usage.totalTokens.toLocaleString()} tokens</small>
                  </div>
                  <div className="help-metric-card">
                    <span>参考费用估算</span>
                    <strong>{usage.model.provider === 'ollama' ? '¥0.00 (本机)' : estimateCny(usage.totalTokens)}</strong>
                    <small>{usage.usageIncomplete ? '含部分未返回 usage 的请求' : '按主流模型 ~¥1.5/百万 tokens 估算'}</small>
                  </div>
                </div>
                <div className="help-breakdown">
                  <div><span>资料提取候选</span><strong>{usage.breakdown.extraction.calls} 次 · {usage.breakdown.extraction.tokens.toLocaleString()} tokens</strong></div>
                  <div><span>项目证据问答</span><strong>{usage.breakdown.qa.calls} 次 · {usage.breakdown.qa.tokens.toLocaleString()} tokens</strong></div>
                  <div><span>今日重点 / 任务推进</span><strong>{usage.breakdown.assistance.calls} 次 · {usage.breakdown.assistance.tokens.toLocaleString()} tokens</strong></div>
                </div>
              </>
            )}

            <div className="help-privacy-list">
              <h4><ShieldCheck size={15} /> 本地数据隐私与安全边界</h4>
              <ul>
                <li><strong>100% 本地存储</strong>：所有项目、资料、记忆、任务与日报均保存在本机设备中，应用无云端服务器、无账号体系、无遥测上报。</li>
                <li><strong>密钥隔离与加密保护</strong>：模型 API Key 与飞书凭据独立保存，支持系统钥匙串加密；导出的备份文件绝不包含任何密钥。</li>
                <li><strong>显式授权才外发</strong>：未开启远程模型发送授权前，不会向外发送任何项目文字；连接本机 Ollama 可完全离线运行。</li>
              </ul>
              {state?.workspace.dataDir && (
                <div className="storage-note" style={{ marginTop: 8 }}>
                  <HardDrive size={14} />
                  <span>当前本机工作区目录：</span>
                  <code>{state.workspace.dataDir}</code>
                </div>
              )}
            </div>
            <AssistanceRunRecords projectId="" revision={String(usage?.totalCalls ?? state?.workspace.schemaVersion ?? 0)} />
          </div>
        )}

        {tab === 'feedback' && (
          <div className="help-section" role="tabpanel">
            <div className="help-tip-box">
              <Activity size={16} />
              <div>
                <strong>遇到报错、闪退或格式兼容问题？</strong>
                <p>请先导出一份「脱敏诊断报告」，提交反馈时一并附上，可帮助我们快速定位原因。</p>
              </div>
            </div>
            <div className="help-privacy-list">
              <h4>脱敏诊断报告包含什么（以及绝不包含什么）</h4>
              <ul>
                <li><strong>仅包含</strong>：应用版本号、系统环境、各模块记录数量统计、AI 服务类型/模型名（不含密钥）、最近失败任务的错误阶段。</li>
                <li><strong>绝不包含</strong>：任何项目名称、资料原文、任务内容、记忆文本、API 密钥、飞书 Secret、聊天消息或本机用户名路径。</li>
              </ul>
            </div>
            <div className="help-actions-row">
              <button
                type="button"
                className="button primary"
                disabled={exporting}
                onClick={() => void exportSanitizedDiagnostics()}
              >
                {exporting ? <Spinner /> : <Download size={15} />}
                一键导出脱敏诊断报告 (.json)
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => void openExternalUrl('https://github.com/potatocheng/project-assistant/issues')}
              >
                前往 GitHub Issues 反馈
                <ExternalLink size={14} />
              </button>
            </div>
          </div>
        )}

        {tab === 'about' && (
          <div className="help-section" role="tabpanel">
            <div className="help-about-head">
              <div>
                <h3>循序 · Cadence（本地 AI 交付工作台）</h3>
                <p>当前版本：v0.3.0 · MIT 开源协议</p>
              </div>
            </div>
            <div className="help-changelog">
              <h4><BookOpen size={14} /> 当前版本核心能力</h4>
              <ul>
                <li><strong>今日行动流 & AI 副驾驶</strong>：把逾期、阻塞、待拍板和待确认收拢到一页，支持对话直接查进度、建任务、改排期、写日报（写入操作均需确认卡拍板）。</li>
                <li><strong>全格式办公资料解析</strong>：支持 TXT、MD、Word (.docx)、文本 PDF、Excel (.xlsx/.csv)、PPT (.pptx) 与邮件 (.eml)，全部带精准原文坐标。</li>
                <li><strong>可视化交付视图</strong>：项目内支持「任务看板（支持拖拽流转）」与「里程碑甘特时间轴」。</li>
                <li><strong>多风格汇报与一键导出</strong>：支持 AI 一键改写为老板摘要版 / 团队对齐版 / 客户汇报版，导出 Word (.docx)、CSV、汇报长图 (PNG)、PDF 与 Markdown。</li>
              </ul>
            </div>
            <p className="field-hint">
              <TerminalSquare size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />
              开源仓库与隐私白皮书：github.com/potatocheng/project-assistant
            </p>
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <span className="field-hint">所有项目数据均安全保存于您的本机设备</span>
        <button type="button" className="button secondary" onClick={close}>关闭</button>
      </div>
    </Dialog>
  );
}
