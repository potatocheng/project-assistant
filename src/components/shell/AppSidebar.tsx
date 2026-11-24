import type { ReactNode, RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  FolderKanban, MessageSquareText, Plus, Search, Sparkles, Sun, X,
} from 'lucide-react';
import type { Page, Project } from '../../types';
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
  memories: '项目记忆',
  reports: '工作日报',
  'chat-replies': '飞书自动回复',
  proactive: '主动推进与巡检',
  followups: '提醒与跟进',
  inbox: '待确认内容',
  assistant: 'AI 副驾驶',
  backups: '备份与恢复',
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const searchShortcut = isMac ? '⌘K' : 'Ctrl K';
const copilotShortcut = isMac ? '⌘J' : 'Ctrl J';

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
  drawerLeaving,
  copilotOpen,
  onNavigate,
  onSelectProject,
  onToggleCopilot,
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
  drawerLeaving: boolean;
  copilotOpen: boolean;
  onNavigate: (page: Page) => void;
  onSelectProject: (projectId: string) => void;
  onToggleCopilot: () => void;
  onSearch: () => void;
  onClose: () => void;
  onCreateProject: () => void;
  createProjectDisabled: boolean;
  footer: ReactNode;
}) {
  const todayAttention = badges.proactive + badges.followups + badges.pending;
  const commsAttention = badges.proactive + badges.pending;

  return (
    <aside
      id={id}
      ref={sidebarRef}
      className={`app-sidebar ${drawer ? 'is-drawer' : ''} ${drawerLeaving ? 'is-leaving' : ''}`}
      role={drawer ? 'dialog' : undefined}
      aria-modal={drawer || undefined}
      aria-label="工作区导航"
      tabIndex={-1}
    >
      <div className="sidebar-brand">
        <button className="sidebar-brand-button" onClick={() => onNavigate('workbench')} aria-label="项目助理 · 今日行动流">
          <BrandMark size={22} />
          <span>项目助理</span>
        </button>
        {runningJobs > 0 && (
          <span className="sidebar-processing" role="status" title={`${runningJobs} 项处理中`}>
            <Spinner />
            <span>{runningJobs}</span>
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
        <div className="sidebar-group">
          <span className="sidebar-group-label">工作区</span>
          {PRIMARY_NAV.map(({ id: navId, page: destination, label, icon: Icon, matches }) => {
            const active = matches(page);
            const count =
              navId === 'today' ? todayAttention
                : navId === 'projects' ? badges.tasks
                  : commsAttention;
            const attention = navId !== 'projects' && count > 0;
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
                    {count > 99 ? '99+' : count}
                  </small>
                )}
              </button>
            );
          })}
        </div>

        <div className="sidebar-group">
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
            projects.slice(0, 10).map(project => {
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
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-copilot-btn"
          aria-pressed={copilotOpen}
          onClick={onToggleCopilot}
        >
          <Sparkles size={15} />
          <span>AI 副驾驶</span>
          <kbd>{copilotShortcut}</kbd>
        </button>
        {footer}
      </div>
    </aside>
  );
}
