import { useState } from 'react';
import { ClipboardList, Flame, Moon, Sparkles, Sun, Sunrise } from 'lucide-react';
import { asError, execute } from '../../api';
import { Spinner } from '../ui';
import { detectRhythmPhase } from './copilot-actions';

interface Props {
  date: string;
  projectId: string;
  todayCount: number;
  doneTodayCount: number;
  urgentCount: number;
  riskProjectCount: number;
  onFilterWork: () => void;
  onFilterAttention: () => void;
  onAskCopilot: (question: string) => void;
  onReportGenerated: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}

export function WorkRhythmBar({
  date,
  projectId,
  todayCount,
  doneTodayCount,
  urgentCount,
  riskProjectCount,
  onFilterWork,
  onFilterAttention,
  onAskCopilot,
  onReportGenerated,
  notify,
}: Props) {
  const [busyReport, setBusyReport] = useState(false);
  const phase = detectRhythmPhase(new Date().getHours());

  const generateReport = async () => {
    if (busyReport) return;
    setBusyReport(true);
    try {
      await execute('generate_daily_report', {
        date,
        ...(projectId ? { projectId } : {}),
        clientRequestId: crypto.randomUUID(),
      });
      await onReportGenerated();
      notify(`已生成 ${date} 工作日报草稿，可直接微调或复制发送。`);
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusyReport(false);
    }
  };

  if (phase === 'morning') {
    return (
      <section className="rhythm-bar is-morning" aria-label="早间开局节律">
        <div className="rhythm-bar-icon"><Sunrise size={16} /></div>
        <div className="rhythm-bar-copy">
          <strong>早间开局 · 先定今天最重要的事</strong>
          <p>
            今日待推进 <b>{todayCount}</b> 项{urgentCount > 0 ? `（含 ${urgentCount} 项需优先协调）` : ''}
            {riskProjectCount > 0 ? `，另有 ${riskProjectCount} 个项目存在交付风险。` : '，整体节奏可控。'}
          </p>
        </div>
        <div className="rhythm-bar-actions">
          <button className="button secondary compact" onClick={onFilterWork}>
            锁定今日执行
          </button>
          <button
            className="text-button tiny"
            onClick={() => onAskCopilot('请结合最新资料，总结今天最应该优先推进的 3 件事和潜在风险')}
          >
            <Sparkles size={12} />晨间重点
          </button>
        </div>
      </section>
    );
  }

  if (phase === 'midday') {
    return (
      <section className="rhythm-bar is-midday" aria-label="盘中推进节律">
        <div className="rhythm-bar-icon">{urgentCount > 0 ? <Flame size={16} /> : <Sun size={16} />}</div>
        <div className="rhythm-bar-copy">
          <strong>盘中推进 · 紧盯阻塞与关键协调</strong>
          <p>
            {urgentCount > 0
              ? `当前有 ${urgentCount} 项高优卡点或协调事项，建议优先扫清障碍。`
              : `今日已完成 ${doneTodayCount} 项，剩余 ${todayCount} 项按计划推进中。`}
          </p>
        </div>
        <div className="rhythm-bar-actions">
          {urgentCount > 0 && (
            <button className="button secondary compact" onClick={onFilterAttention}>
              只看卡点协调
            </button>
          )}
          <button
            className="text-button tiny"
            onClick={() => onAskCopilot('目前有哪些阻塞或逾期事项需要我立刻催办？')}
          >
            <Sparkles size={12} />AI 排障
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rhythm-bar is-evening" aria-label="傍晚收口节律">
      <div className="rhythm-bar-icon"><Moon size={16} /></div>
      <div className="rhythm-bar-copy">
        <strong>傍晚收口 · 一键生成今日工作日报</strong>
        <p>
          今日已完成 <b>{doneTodayCount}</b> 项任务，剩余 <b>{todayCount}</b> 项待推进。下班前可由助理自动汇总今日进展。
        </p>
      </div>
      <div className="rhythm-bar-actions">
        <button className="button primary compact" disabled={busyReport} onClick={() => void generateReport()}>
          {busyReport ? <Spinner /> : <ClipboardList size={13} />}
          一键生成今日日报
        </button>
      </div>
    </section>
  );
}
