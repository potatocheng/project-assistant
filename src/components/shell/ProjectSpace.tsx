import { lazy, Suspense, useRef } from 'react';
import {
  CalendarDays, FileDiff, FilePlus2, FileText, LayoutGrid, Library,
  ListTodo, Plus, ShieldAlert, Users,
} from 'lucide-react';
import type { AppState, Evidence, ManagementKind, Page } from '../../types';
import { CountPulse, PageLoading, type ToastAction, usePageMotion, useScrollFade, useSlidingIndicator } from '../interaction';
import './space.css';

const DeliveryOverview = lazy(() => import('../delivery/DeliveryOverview').then(m => ({ default: m.DeliveryOverview })));
const TaskWorkspace = lazy(() => import('../work/TaskWorkspace').then(m => ({ default: m.TaskWorkspace })));
const GovernanceWorkspace = lazy(() => import('../governance/GovernanceWorkspace').then(m => ({ default: m.GovernanceWorkspace })));
const ChangeAcceptanceWorkspace = lazy(() => import('../governance/ChangeAcceptanceWorkspace').then(m => ({ default: m.ChangeAcceptanceWorkspace })));
const CoordinationWorkspace = lazy(() => import('../governance/CoordinationWorkspace').then(m => ({ default: m.CoordinationWorkspace })));

export type ProjectTab = 'overview' | 'daily' | 'tasks' | 'governance' | 'changes' | 'coordination' | 'sources' | 'memories';

interface Props {
  activeTab: ProjectTab;
  state: AppState;
  date: string;
  onDateChange: (day: string) => void;
  projectId: string;
  onProjectChange: (id: string) => void;
  onTabChange: (tab: Page) => void;
  onChanged: () => Promise<unknown>;
  onTaskOpen: (taskId: string, projectId: string) => void;
  onEvidence: (evidence: Evidence) => void;
  onManagementOpen: (kind: ManagementKind, id: string, projectId: string) => void;
  onMemoryOpen: (id: string, projectId?: string) => void;
  onCreateTask: () => void;
  onImport: () => void;
  createTaskRequest: number;
  onCreateTaskConsumed: () => void;
  focusTaskId: string | null;
  managementFocusId?: string;
  onModelSettings?: () => void;
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}

const TABS: Array<{ id: ProjectTab; label: string; icon: typeof LayoutGrid }> = [
  { id: 'overview', label: '项目总览', icon: LayoutGrid },
  { id: 'tasks', label: '任务清单', icon: ListTodo },
  { id: 'daily', label: '每日排期', icon: CalendarDays },
  { id: 'sources', label: '原始资料', icon: FileText },
  { id: 'memories', label: '已确认记录', icon: Library },
  { id: 'governance', label: '风险与决策', icon: ShieldAlert },
  { id: 'changes', label: '变更与验收', icon: FileDiff },
  { id: 'coordination', label: '周报与会议', icon: Users },
];

export function ProjectSpaceHeader({
  activeTab,
  state,
  projectId,
  onProjectChange,
  onTabChange,
  onImport,
  onCreateTask,
  allowAll = true,
}: {
  activeTab: ProjectTab;
  state: AppState;
  projectId: string;
  onProjectChange: (id: string) => void;
  onTabChange: (tab: Page) => void;
  onImport: () => void;
  onCreateTask: () => void;
  allowAll?: boolean;
}) {
  const effectiveProjectId = allowAll ? projectId : (projectId || state.projects[0]?.id || '');
  const taskCount = state.tasks.filter(t => (!effectiveProjectId || t.projectId === effectiveProjectId) && ['todo', 'in_progress', 'blocked'].includes(t.status)).length;
  const showQuickCreateTask = activeTab !== 'tasks' && activeTab !== 'daily';
  const tabsRef = useRef<HTMLElement>(null);
  useSlidingIndicator(tabsRef, '.space-tab.is-active', [activeTab, taskCount]);
  useScrollFade(tabsRef, [activeTab, taskCount]);

  return (
    <header className="space-header">
      <div className="space-header-top">
        <div className="space-title-group">
          <select
            aria-label="当前项目"
            className="space-project-select"
            value={effectiveProjectId}
            onChange={e => onProjectChange(e.target.value)}
          >
            {allowAll && <option value="">全部项目</option>}
            {state.projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="today-header-controls">
          <button type="button" className="button secondary compact" onClick={onImport}>
            <FilePlus2 size={14} />
            导入资料
          </button>
          {showQuickCreateTask && (
            <button type="button" className="button primary compact" onClick={onCreateTask}>
              <Plus size={14} />
              新建任务
            </button>
          )}
        </div>
      </div>
      <nav className="space-tabs sliding-indicator-container scroll-fade-x" ref={tabsRef} aria-label="项目视图切换">
        <span className="sliding-indicator-bar space-tab-indicator" aria-hidden="true" />
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`space-tab ${activeTab === id ? 'is-active' : ''}`}
            aria-current={activeTab === id ? 'page' : undefined}
            onClick={() => onTabChange(id)}
          >
            <Icon size={14} />
            <span>{label}</span>
            {id === 'tasks' && taskCount > 0 && <span className="space-tab-count"><CountPulse value={taskCount} /></span>}
          </button>
        ))}
      </nav>
    </header>
  );
}

export function ProjectSpace(props: Props) {
  const { activeTab, state, projectId, date } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const prevTabRef = useRef(activeTab);
  const prevIdx = TABS.findIndex(t => t.id === prevTabRef.current);
  const currIdx = TABS.findIndex(t => t.id === activeTab);
  const direction: -1 | 0 | 1 = currIdx > prevIdx ? 1 : currIdx < prevIdx ? -1 : 0;
  prevTabRef.current = activeTab;
  usePageMotion(contentRef, activeTab, direction);

  return (
    <div className="space-shell">
      <ProjectSpaceHeader
        activeTab={activeTab}
        state={state}
        projectId={projectId}
        onProjectChange={props.onProjectChange}
        onTabChange={props.onTabChange}
        onImport={props.onImport}
        onCreateTask={props.onCreateTask}
      />

      <div className="space-content" ref={contentRef}>
        <Suspense fallback={<PageLoading label="正在加载项目视图" />}>
          {activeTab === 'overview' && (
            <DeliveryOverview
              state={state}
              projectId={projectId}
              date={date}
              onChanged={props.onChanged}
              onTaskOpen={props.onTaskOpen}
              onEvidence={props.onEvidence}
              onManagementOpen={props.onManagementOpen}
              onMemoryOpen={props.onMemoryOpen}
              notify={props.notify}
            />
          )}
          {(activeTab === 'tasks' || activeTab === 'daily') && (
            <TaskWorkspace
              key={activeTab}
              mode={activeTab}
              state={state}
              day={date}
              setDay={props.onDateChange}
              projectId={projectId}
              setProjectId={props.onProjectChange}
              hideProjectFilter
              createTaskRequest={props.createTaskRequest}
              onCreateTaskConsumed={props.onCreateTaskConsumed}
              focusTaskId={props.focusTaskId}
              onChanged={props.onChanged}
              onModelSettings={props.onModelSettings}
              notify={props.notify}
              onEvidence={props.onEvidence}
              onReport={() => props.onTabChange('reports')}
            />
          )}
          {activeTab === 'governance' && (
            <GovernanceWorkspace
              focusId={props.managementFocusId}
              state={state}
              projectId={projectId}
              date={date}
              onChanged={props.onChanged}
              onTaskOpen={props.onTaskOpen}
              onEvidence={props.onEvidence}
              notify={props.notify}
            />
          )}
          {activeTab === 'changes' && (
            <ChangeAcceptanceWorkspace
              focusId={props.managementFocusId}
              state={state}
              projectId={projectId}
              date={date}
              onChanged={props.onChanged}
              onTaskOpen={props.onTaskOpen}
              onEvidence={props.onEvidence}
              notify={props.notify}
            />
          )}
          {activeTab === 'coordination' && (
            <CoordinationWorkspace
              focusId={props.managementFocusId}
              state={state}
              projectId={projectId}
              date={date}
              onChanged={props.onChanged}
              onTaskOpen={props.onTaskOpen}
              onEvidence={props.onEvidence}
              notify={props.notify}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
