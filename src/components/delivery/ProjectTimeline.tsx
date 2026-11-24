import { CalendarRange, Flag } from 'lucide-react';
import type { Task } from '../../types';
import type { Milestone, ProjectDelivery } from './types';

function toDayMs(ymd: string): number {
  return new Date(`${ymd}T12:00:00`).getTime();
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shortDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function ProjectTimeline({
  project,
  tasks,
  date,
  onEditMilestone,
  onTaskOpen,
}: {
  project: ProjectDelivery;
  tasks: Task[];
  date: string;
  onEditMilestone: (milestone: Milestone) => void;
  onTaskOpen: (taskId: string, projectId: string) => void;
}) {
  const activeTasks = tasks.filter(t => t.status !== 'cancelled');
  const totalCount = activeTasks.length;
  const doneCount = activeTasks.filter(t => t.status === 'done').length;
  const progressCount = activeTasks.filter(t => t.status === 'in_progress').length;
  const blockedCount = activeTasks.filter(t => t.status === 'blocked').length;
  const todoCount = Math.max(0, totalCount - doneCount - progressCount - blockedCount);

  const pct = (n: number) => (totalCount ? (n / totalCount) * 100 : 0);

  // Collect date anchors for the timeline
  const datedMilestones = project.milestones.filter(m => m.baselineDate || m.forecastDate);
  const datedTasks = activeTasks.filter(t => t.dueDate || t.plannedDate).slice(0, 8);

  const allDates: string[] = [date];
  if (project.profile.targetDate) allDates.push(project.profile.targetDate);
  datedMilestones.forEach(m => {
    if (m.baselineDate) allDates.push(m.baselineDate);
    if (m.forecastDate) allDates.push(m.forecastDate);
  });
  datedTasks.forEach(t => {
    if (t.plannedDate) allDates.push(t.plannedDate);
    if (t.dueDate) allDates.push(t.dueDate);
  });

  const sortedMs = allDates.map(toDayMs).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
  const rawMin = sortedMs[0] ?? toDayMs(date);
  const rawMax = sortedMs[sortedMs.length - 1] ?? toDayMs(addDays(date, 14));
  const minMs = rawMin - 2 * 86_400_000;
  const maxMs = Math.max(rawMax + 2 * 86_400_000, minMs + 7 * 86_400_000);
  const span = maxMs - minMs;

  const pos = (ymd: string) => {
    const ms = toDayMs(ymd);
    if (Number.isNaN(ms)) return 0;
    return Math.min(98, Math.max(2, ((ms - minMs) / span) * 100));
  };

  const todayPos = pos(date);
  const minLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(minMs));
  const midLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(minMs + span / 2));
  const maxLabel = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(maxMs));

  return (
    <section className="delivery-timeline-panel" aria-label="交付健康度与里程碑时间轴">
      <div className="delivery-section-heading">
        <div>
          <h3><CalendarRange size={16} />交付节奏与里程碑时间轴</h3>
          <p>一图对比任务分布、原定基准日与当前预计交付日。</p>
        </div>
        <span className="delivery-health-ratio">
          {totalCount > 0 ? `任务完成率 ${Math.round((doneCount / totalCount) * 100)}%（${doneCount}/${totalCount}）` : '暂无任务'}
        </span>
      </div>

      {totalCount > 0 && (
        <div className="health-bar-card">
          <div className="health-stacked-bar" role="img" aria-label={`已完成 ${doneCount}，进行中 ${progressCount}，阻塞 ${blockedCount}，待办 ${todoCount}`}>
            {doneCount > 0 && <i className="is-done" style={{ width: `${pct(doneCount)}%` }} title={`已完成 ${doneCount}`} />}
            {progressCount > 0 && <i className="is-progress" style={{ width: `${pct(progressCount)}%` }} title={`进行中 ${progressCount}`} />}
            {blockedCount > 0 && <i className="is-blocked" style={{ width: `${pct(blockedCount)}%` }} title={`阻塞 ${blockedCount}`} />}
            {todoCount > 0 && <i className="is-todo" style={{ width: `${pct(todoCount)}%` }} title={`待办 ${todoCount}`} />}
          </div>
          <div className="health-legend">
            <span><b className="is-done" />已完成 {doneCount}</span>
            <span><b className="is-progress" />进行中 {progressCount}</span>
            <span><b className="is-blocked" />阻塞 {blockedCount}</span>
            <span><b className="is-todo" />待办 {todoCount}</span>
          </div>
        </div>
      )}

      {datedMilestones.length === 0 && datedTasks.length === 0 ? (
        <p className="delivery-inline-hint">为里程碑或任务设置计划/截止日期后，此处将自动渲染甘特时间轴。</p>
      ) : (
        <div className="gantt-chart">
          <div className="gantt-axis">
            <div className="gantt-label-col">节点 / 关键任务</div>
            <div className="gantt-track-col gantt-scale">
              <span>{minLabel}</span>
              <span>{midLabel}</span>
              <span>{maxLabel}</span>
            </div>
          </div>

          <div className="gantt-rows">
            {datedMilestones.map(m => {
              const base = m.baselineDate || m.forecastDate!;
              const forecast = m.forecastDate || m.baselineDate!;
              const left = Math.min(pos(base), pos(forecast));
              const right = Math.max(pos(base), pos(forecast));
              const slipped = (m.slipDays ?? 0) > 0 || m.isOverdue;
              const done = m.status === 'completed';
              const tone = done ? 'is-done' : slipped ? 'is-risk' : 'is-ontrack';
              return (
                <button
                  key={`ms-${m.id}`}
                  type="button"
                  className="gantt-row"
                  onClick={() => onEditMilestone(m)}
                  title={`${m.title}：基准 ${m.baselineDate || '未定'} · 预计 ${m.forecastDate || '未定'}`}
                >
                  <div className="gantt-label-col">
                    <Flag size={12} className={`gantt-icon ${tone}`} />
                    <span>{m.title}</span>
                  </div>
                  <div className="gantt-track-col">
                    <div className="gantt-today-line" style={{ left: `${todayPos}%` }} />
                    {m.baselineDate && (
                      <span
                        className="gantt-baseline-marker"
                        style={{ left: `${pos(m.baselineDate)}%` }}
                        title={`基准日：${m.baselineDate}`}
                      />
                    )}
                    <div
                      className={`gantt-bar ${tone}`}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(4, right - left)}%`,
                      }}
                    >
                      <span className="gantt-bar-label">
                        {shortDay(forecast)}
                        {m.slipDays && m.slipDays > 0 ? ` (+${m.slipDays}天)` : ''}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}

            {datedTasks.map(t => {
              const start = t.plannedDate || t.dueDate!;
              const end = t.dueDate || t.plannedDate!;
              const left = Math.min(pos(start), pos(end));
              const right = Math.max(pos(start), pos(end));
              const overdue = !!t.dueDate && t.dueDate < date && t.status !== 'done';
              const tone = t.status === 'done' ? 'is-done' : t.status === 'blocked' || overdue ? 'is-risk' : 'is-task';
              return (
                <button
                  key={`task-${t.id}`}
                  type="button"
                  className="gantt-row is-subrow"
                  onClick={() => onTaskOpen(t.id, t.projectId)}
                >
                  <div className="gantt-label-col">
                    <span className="gantt-task-dot" />
                    <span>{t.title}</span>
                  </div>
                  <div className="gantt-track-col">
                    <div className="gantt-today-line" style={{ left: `${todayPos}%` }} />
                    <div
                      className={`gantt-task-bar ${tone}`}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(3, right - left)}%`,
                      }}
                    >
                      <span className="gantt-bar-label">{t.assignee || '待定'} · {shortDay(end)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="gantt-footnote">
            <span><i className="gantt-today-legend" />虚线为今日（{date}）</span>
            <span>◆ 菱形为原定基准日 · 实条为预计/任务跨度（点击即可编辑或查看详情）</span>
          </div>
        </div>
      )}
    </section>
  );
}
