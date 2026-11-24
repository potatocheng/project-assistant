import { lazy, Suspense } from 'react';
import {
  CalendarDays, FileDiff, FilePlus2, FileText, LayoutGrid, Library,
  ListTodo, Plus, ShieldAlert, Users,
} from 'lucide-react';
import type { AppState, Evidence, ManagementKind, Page } from '../../types';
import { PageLoading } from '../interaction';

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
  notify: (message: string, error?: boolean) => void;
}

const TABS: Array<{ id: ProjectTab; label: string; icon: typeof LayoutGrid }> = [
  { id: 'overview', label: '项目总览', icon: LayoutGrid },
  { id: 'tasks', label: '任务清单', icon: ListTodo },
  { id: 'daily', label: '每日排期', icon: CalendarDays },
  { id: 'governance', label: '风险与决策', icon: ShieldAlert },
  { id: 'changes', label: '变更与验收', icon: FileDiff },
  { id: 'coordination', label: '周报与会议', icon: Users },
  { id: 'sources', label: '原始资料', icon: FileText },
  { id: 'memories', label: '项目记忆', icon: Library },
];

export function ProjectSpace(props: Props) {
  const { activeTab, state, projectId, date } = props;
  const activeProject = state.projects.find(p => p.id === projectId);
  const taskCount = state.tasks.filter(t => (!projectId || t.projectId === projectId) && ['todo', 'in_progress', 'blocked'].includes(t.status)).length;

  return (
    <div className="space-shell">
      <header className="space-header">
        <div className="space-header-top">
          <div className="space-title-group">
            <h2>{activeProject ? activeProject.name : '全部项目'}</h2>
            <select
              aria-label="切换项目"
              className="today-scope-select"
              value={projectId}
              onChange={e => props.onProjectChange(e.target.value)}
            >
              <option value="">全部项目</option>
              {state.projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="today-header-controls">
            <button className="button secondary compact" onClick={props.onImport}>
              <FilePlus2 size={14} />
              导入资料
            </button>
            <button className="button primary compact" onClick={props.onCreateTask}>
              <Plus size={14} />
              新建任务
            </button>
          </div>
        </div>
        <nav className="space-tabs" aria-label="项目视图切换">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`space-tab ${activeTab === id ? 'is-active' : ''}`}
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => props.onTabChange(id)}
            >
              <Icon size={14} />
              <span>{label}</span>
              {id === 'tasks' && taskCount > 0 && <span className="space-tab-count">{taskCount}</span>}
            </button>
          ))}
        </nav>
      </header>

      <div className="space-content">
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
              createTaskRequest={props.createTaskRequest}
              onCreateTaskConsumed={props.onCreateTaskConsumed}
              focusTaskId={props.focusTaskId}
              onChanged={props.onChanged}
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
