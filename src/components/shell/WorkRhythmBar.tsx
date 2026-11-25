import { useEffect, useState } from 'react';
import { ClipboardList, Flame, Moon, Sparkles, Sun, Sunrise } from 'lucide-react';
import { asError, execute } from '../../api';
import { type ToastAction } from '../interaction';
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
  onOpenReports: () => void;
  onReportGenerated: () => Promise<void>;
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
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
  onOpenReports,
  onReportGenerated,
  notify,
}: Props) {
  const [busyReport, setBusyReport] = useState(false);
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const phase = detectRhythmPhase(hour);

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
      notify(`已生成 ${date} 工作日报草稿。`, false, {
        label: '查看汇报',
        onClick: onOpenReports,
      });
    } catch (caught) {
      notify(asError(caught).message, true);
    } finally {
      setBusyReport(false);
    }
  };

  const reportButton = (primary = false) => (
    <button
      type="button"
      className={`button ${primary ? 'primary' : 'secondary'} compact`}
      disabled={busyReport}
      onClick={() => void generateReport()}
    >
      {busyReport ? <Spinner /> : <ClipboardList size={13} />}
      {busyReport ? '生成中…' : '生成今日日报'}
    </button>
  );

  if (phase === 'morning') {
    return (
      <section className="rhythm-bar is-morning" aria-label="早间开局节律">
        <div className="rhythm-bar-icon"><Sunrise size={16} /></div>
        <div className="rhythm-bar-copy">
          <strong>早间开局 · 先定今天最重要的事</strong>
          <p>
            {todayCount > 0
              ? <>今日待推进 <b>{todayCount}</b> 项{urgentCount > 0 ? `，另有 ${urgentCount} 项待协调与 AI 建议` : ''}</>
              : urgentCount > 0
                ? <>今日待办已清空，还有 <b>{urgentCount}</b> 项待协调或建议</>
                : '今天暂未安排待执行任务，可从任务清单认领或先导一份纪要'}
            {riskProjectCount > 0 ? `（${riskProjectCount} 个项目存在风险）。` : '。'}
          </p>
        </div>
        <div className="rhythm-bar-actions">
          {todayCount > 0 && (
            <button type="button" className="button secondary compact" onClick={onFilterWork}>
              只看今日执行
            </button>
          )}
          {reportButton(false)}
          <button
            type="button"
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
              ? `当前有 ${urgentCount} 项高优卡点或协调事项，建议优先扫清障碍；今日已完成 ${doneTodayCount} 项。`
              : todayCount > 0
                ? `今日已完成 ${doneTodayCount} 项，剩余 ${todayCount} 项按计划推进中。`
                : doneTodayCount > 0
                  ? `今日核心任务已全部推进完成（共完成 ${doneTodayCount} 项）。`
                  : '今日节奏平稳，暂无卡点提醒。'}
          </p>
        </div>
        <div className="rhythm-bar-actions">
          {urgentCount > 0 && (
            <button type="button" className="button secondary compact" onClick={onFilterAttention}>
              只看卡点协调
            </button>
          )}
          {reportButton(false)}
          <button
            type="button"
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
        <strong>傍晚收口 · 生成今日工作日报</strong>
        <p>
          今日已完成 <b>{doneTodayCount}</b> 项任务{todayCount > 0 ? `，仍有 ${todayCount} 项待推进` : '，当日待办已清空'}。收工前可按今日记录直接汇总日报。
        </p>
      </div>
      <div className="rhythm-bar-actions">
        {reportButton(true)}
      </div>
    </section>
  );
}
