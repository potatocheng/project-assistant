import type { ReactNode } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Project } from '../../types';
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';

export function localDay(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function shiftDay(day: string, amount: number): string {
  const value = new Date(`${day}T12:00:00`);
  value.setDate(value.getDate() + amount);
  return localDay(value);
}

export function formatMoment(value: string | null | undefined, time = true): string {
  if (!value) return '未记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}) }).format(parsed);
}

export function WorkFilters({ day, onDayChange, projects, projectId, onProjectChange, children, showDate = true }: {
  day: string; onDayChange: (day: string) => void; projects: Project[];
  projectId: string; onProjectChange: (projectId: string) => void; children?: ReactNode; showDate?: boolean;
}) {
  return <div className="work-filters">
    {showDate && <div className="work-date-controls">
      <Button label="前一天" tooltip="前一天" variant="ghost" size="sm" isIconOnly icon={<ChevronLeft size={17} />} onClick={() => onDayChange(shiftDay(day, -1))} />
      <label className="work-date-field"><CalendarDays size={15} /><input type="date" aria-label="工作日期" value={day} required onChange={(event) => { if (event.target.value) onDayChange(event.target.value); }} /></label>
      <Button label="后一天" tooltip="后一天" variant="ghost" size="sm" isIconOnly icon={<ChevronRight size={17} />} onClick={() => onDayChange(shiftDay(day, 1))} />
      <Button label="回到今天" variant="ghost" size="sm" isDisabled={day === localDay()} onClick={() => onDayChange(localDay())}>今天</Button>
    </div>}
    <Selector label="筛选项目" isLabelHidden value={projectId} onChange={onProjectChange}
      containerClassName="astryx-project-filter" options={[{ value: '', label: '全部项目' }, ...projects.map(project => ({ value: project.id, label: project.name }))]} />
    {children}
  </div>;
}

export function WorkEmpty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="work-empty"><h3>{title}</h3>{children && <p>{children}</p>}{action && <div>{action}</div>}</div>;
}
