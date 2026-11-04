import type { ReactNode, RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bell, CalendarDays, ClipboardList, FileDiff, FileText, Inbox, LayoutGrid, Library, ListTodo,
  MessageSquareReply, MessagesSquare, Plus, Search, ShieldAlert, Sun, Users, X, Zap,
} from 'lucide-react';
import type { Page } from '../../types';
import { Spinner } from '../ui';
import { BrandMark } from './BrandMark';

export type NavBadges = { proactive: number; followups: number; pending: number; management: number; tasks: number };
type BadgeKey = keyof NavBadges;
type NavItem = { page: Page; label: string; icon: LucideIcon; badge?: BadgeKey; tone?: 'attention' };

// One map of the product: every page is reachable from here, grouped by the question it answers.
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: '今天', items: [
    { page: 'workbench', label: '今日概览', icon: Sun },
    { page: 'proactive', label: '待处理行动', icon: Zap, badge: 'proactive', tone: 'attention' },
    { page: 'followups', label: '提醒与跟进', icon: Bell, badge: 'followups', tone: 'attention' },
    { page: 'inbox', label: '待确认内容', icon: Inbox, badge: 'pending' },
  ] },
  { label: '工作', items: [
    { page: 'daily', label: '每日清单', icon: CalendarDays },
    { page: 'tasks', label: '全部任务', icon: ListTodo, badge: 'tasks' },
    { page: 'reports', label: '工作日报', icon: ClipboardList },
  ] },
  { label: '沟通', items: [
    { page: 'assistant', label: '项目问答', icon: MessagesSquare },
    { page: 'chat-replies', label: '聊天回复', icon: MessageSquareReply },
  ] },
  { label: '项目', items: [
    { page: 'overview', label: '项目总览', icon: LayoutGrid },
    { page: 'governance', label: '风险与决策', icon: ShieldAlert, badge: 'management', tone: 'attention' },
    { page: 'changes', label: '变更与验收', icon: FileDiff },
    { page: 'coordination', label: '周报与会议', icon: Users },
  ] },
  { label: '资料', items: [
    { page: 'sources', label: '项目资料', icon: FileText },
    { page: 'memories', label: '项目记忆', icon: Library },
  ] },
];

const shortcutLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

export function pageLabel(page: Page) {
  return NAV_GROUPS.flatMap(group => group.items).find(item => item.page === page)?.label;
}

export function AppSidebar({ id, sidebarRef, page, badges, runningJobs, drawer, drawerLeaving, onNavigate, onSearch, onClose, onCreateProject, createProjectDisabled, footer }: {
  id: string; sidebarRef: RefObject<HTMLElement | null>; page: Page; badges: NavBadges; runningJobs: number;
  drawer: boolean; drawerLeaving: boolean; onNavigate: (page: Page) => void; onSearch: () => void; onClose: () => void;
  onCreateProject: () => void; createProjectDisabled: boolean; footer: ReactNode;
}) {
  return <aside id={id} ref={sidebarRef} className={`app-sidebar ${drawer ? 'is-drawer' : ''} ${drawerLeaving ? 'is-leaving' : ''}`}
    role={drawer ? 'dialog' : undefined} aria-modal={drawer || undefined} aria-label="工作区导航" tabIndex={-1}>
    <div className="sidebar-brand">
      <button className="sidebar-brand-button" onClick={() => onNavigate('workbench')} aria-label="项目助理 · 今日概览"><BrandMark size={22} /><span>项目助理</span></button>
      {runningJobs > 0 && <span className="sidebar-processing" role="status" title={`${runningJobs} 项处理中`}><Spinner /><span>{runningJobs}</span></span>}
      {drawer && <button className="icon-button sidebar-close" aria-label="收起导航" onClick={onClose}><X size={18} /></button>}
    </div>
    <button className="sidebar-search-button" onClick={onSearch}><Search size={15} /><span>搜索工作区</span><kbd>{shortcutLabel}</kbd></button>
    <nav className="sidebar-nav" aria-label="主导航">
      {NAV_GROUPS.map(group => <div className="sidebar-group" key={group.label}>
        <span className="sidebar-group-label">{group.label}</span>
        {group.items.map(({ page: destination, label, icon: Icon, badge, tone }) => {
          const count = badge ? badges[badge] : 0;
          return <button key={destination} className="sidebar-link" aria-current={page === destination ? 'page' : undefined} onClick={() => onNavigate(destination)}>
            <Icon size={16} strokeWidth={1.75} /><span>{label}</span>
            {count > 0 && <small className={`sidebar-count ${tone === 'attention' ? 'is-attention' : ''}`}>{count > 99 ? '99+' : count}</small>}
          </button>;
        })}
      </div>)}
    </nav>
    <div className="sidebar-footer"><button className="sidebar-create-project" onClick={onCreateProject} disabled={createProjectDisabled}><Plus size={16} strokeWidth={1.75} /><span>新建项目</span></button>{footer}</div>
  </aside>;
}
