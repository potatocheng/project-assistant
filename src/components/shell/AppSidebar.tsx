import { useRef, type ReactNode, type RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  FolderKanban, MessageSquareText, Plus, Search, Sun, X,
} from 'lucide-react';
import type { Page, Project } from '../../types';
import { shortcutLabel } from '../../design/motion';
import { CountPulse, useSlidingIndicator, useSwipeDismiss } from '../interaction';
import { Spinner } from '../ui';
import { BrandMark } from './BrandMark';

export type NavBadges = { proactive: number; followups: number; pending: number; management: number; tasks: number };

type PrimaryNav = {
  id: 'today' | 'projects' | 'comms';
  page: Page;
  label: string;
  icon: LucideIcon;
  matches: (page: Page) => boolean;
};

const PROJECT_PAGES = new Set<Page>(['overview', 'tasks', 'daily', 'governance', 'changes', 'coordination', 'sources', 'memories']);
const COMMS_PAGES = new Set<Page>(['reports', 'chat-replies', 'proactive', 'followups', 'inbox']);

export const PRIMARY_NAV: PrimaryNav[] = [
  { id: 'today', page: 'workbench', label: '今日行动流', icon: Sun, matches: page => page === 'workbench' },
  { id: 'projects', page: 'overview', label: '项目空间', icon: FolderKanban, matches: page => PROJECT_PAGES.has(page) },
  { id: 'comms', page: 'reports', label: '沟通与汇报', icon: MessageSquareText, matches: page => COMMS_PAGES.has(page) },
];

const PAGE_LABELS: Record<Page, string> = {
  workbench: '今日行动流',
  overview: '项目总览',
  tasks: '任务清单',
  daily: '每日排期',
  governance: '风险与决策',
  changes: '变更与验收',
  coordination: '周报与会议',
  sources: '原始资料',
  memories: '已确认记录',
  reports: '工作日报',
  'chat-replies': '飞书自动回复',
  proactive: '主动推进与巡检',
  followups: '提醒与跟进',
  inbox: '待确认内容',
  assistant: 'AI 副驾驶',
  backups: '备份与恢复',
};

const searchShortcut = shortcutLabel('K');

export function pageLabel(page: Page) {
  return PAGE_LABELS[page] ?? '工作区';
}

export function AppSidebar({
  id,
  sidebarRef,
  page,
  projects,
  activeProjectId,
  badges,
  runningJobs,
  drawer,
  drawerActive,
  drawerLeaving,
  showArchived,
  archivedProjectCount = 0,
  onToggleArchived,
  onNavigate,
  onSelectProject,
  onSearch,
  onClose,
  onCreateProject,
  createProjectDisabled,
  footer,
}: {
  id: string;
  sidebarRef: RefObject<HTMLElement | null>;
  page: Page;
  projects: Project[];
  activeProjectId: string;
  badges: NavBadges;
  runningJobs: number;
  drawer: boolean;
  drawerActive: boolean;
  drawerLeaving: boolean;
  showArchived: boolean;
  archivedProjectCount?: number;
  onToggleArchived: (show: boolean) => void;
  onNavigate: (page: Page) => void;
  onSelectProject: (projectId: string) => void;
  onSearch: () => void;
  onClose: () => void;
  onCreateProject: () => void;
  createProjectDisabled: boolean;
  footer: ReactNode;
}) {
  const commsAttention = badges.proactive + badges.followups + badges.pending;
  const workspaceGroupRef = useRef<HTMLDivElement>(null);
  const projectsGroupRef = useRef<HTMLDivElement>(null);

  useSlidingIndicator(workspaceGroupRef, ".sidebar-link[aria-current='page']", [page, drawer]);
  useSlidingIndicator(projectsGroupRef, ".sidebar-link[aria-current='page']", [page, activeProjectId, projects.length, drawer]);

  useSwipeDismiss({
    ref: sidebarRef,
    open: drawer,
    enabled: drawer,
    direction: 'left',
    onClose,
    scrimSelector: '.nav-scrim',
  });

  return (
    <aside
      id={id}
      ref={sidebarRef}
      className={`app-sidebar ${drawer ? 'is-drawer' : ''} ${drawerActive ? 'is-active' : ''} ${drawerLeaving ? 'is-leaving' : ''}`}
      role={drawer ? 'dialog' : undefined}
      aria-modal={drawer || undefined}
      aria-label="工作区导航"
      tabIndex={-1}
    >
      <div className="sidebar-brand">
        <button className="sidebar-brand-button" onClick={() => onNavigate('workbench')} aria-label="循序 Cadence · 今日行动流">
          <BrandMark size={24} />
          <span>循序</span>
        </button>
        {runningJobs > 0 && (
          <span className="sidebar-processing" role="status" title={`${runningJobs} 项处理中`}>
            <Spinner />
            <CountPulse value={runningJobs} />
          </span>
        )}
        {drawer && (
          <button className="icon-button sidebar-close" aria-label="收起导航" onClick={onClose}>
            <X size={18} />
          </button>
        )}
      </div>

      <button className="sidebar-search-button" onClick={onSearch}>
        <Search size={14} />
        <span>搜索工作区</span>
        <kbd>{searchShortcut}</kbd>
      </button>

      <nav className="sidebar-nav" aria-label="主导航">
        <div className="sidebar-group sliding-indicator-container" ref={workspaceGroupRef}>
          <span className="sliding-indicator-bar sidebar-active-bar" aria-hidden="true" />
          <span className="sidebar-group-label">工作区</span>
          {PRIMARY_NAV.map(({ id: navId, page: destination, label, icon: Icon, matches }) => {
            const active = matches(page);
            const count =
              navId === 'today' ? 0
                : navId === 'projects' ? badges.tasks
                  : commsAttention;
            const attention = navId === 'comms' && count > 0;
            return (
              <button
                key={navId}
                className="sidebar-link"
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(destination)}
              >
                <Icon size={15} strokeWidth={1.85} />
                <span>{label}</span>
                {count > 0 && (
                  <small className={`sidebar-count ${attention ? 'is-attention' : ''}`}>
                    <CountPulse value={count} display={count > 99 ? '99+' : count} />
                  </small>
                )}
              </button>
            );
          })}
        </div>

        <div className="sidebar-group sliding-indicator-container" ref={projectsGroupRef}>
          <span className="sliding-indicator-bar sidebar-active-bar" aria-hidden="true" />
          <div className="sidebar-group-header">
            <span className="sidebar-group-label">我的项目</span>
            <button
              className="sidebar-group-action"
              title="新建项目"
              aria-label="新建项目"
              disabled={createProjectDisabled}
              onClick={onCreateProject}
            >
              <Plus size={14} />
            </button>
          </div>
          {projects.length === 0 ? (
            <p className="sidebar-empty-projects">暂无项目</p>
          ) : (
            projects.map(project => {
              const selected = PROJECT_PAGES.has(page) && activeProjectId === project.id;
              return (
                <button
                  key={project.id}
                  className="sidebar-link"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className={`sidebar-project-dot ${selected ? 'is-active' : ''}`} />
                  <span>{project.name}</span>
                </button>
              );
            })
          )}
          {(archivedProjectCount > 0 || showArchived) && (
            <label className="sidebar-archive-toggle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={e => onToggleArchived(e.target.checked)}
              />
              <span>显示已归档{archivedProjectCount > 0 ? ` (${archivedProjectCount})` : ''}</span>
            </label>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        {footer}
      </div>
    </aside>
  );
}
