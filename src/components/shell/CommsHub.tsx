import { lazy, Suspense, useRef } from 'react';
import { Bell, ClipboardList, Inbox as InboxIcon, MessageSquareReply, Zap } from 'lucide-react';
import type { AppState, Evidence, ManagementKind, Page } from '../../types';
import { ChatReplies } from '../ChatReplies';
import { Inbox } from '../Inbox';
import { ProactiveCenter } from '../proactive/ProactiveCenter';
import { CountPulse, PageLoading, type ToastAction, usePageMotion, useScrollFade, useSlidingIndicator } from '../interaction';
import './space.css';

const ReportWorkspace = lazy(() => import('../work/ReportWorkspace').then(m => ({ default: m.ReportWorkspace })));
const FollowUpCenter = lazy(() => import('../delivery/FollowUpCenter').then(m => ({ default: m.FollowUpCenter })));

export type CommsTab = 'reports' | 'chat-replies' | 'proactive' | 'followups' | 'inbox';

interface Props {
  activeTab: CommsTab;
  state: AppState;
  date: string;
  onDateChange: (day: string) => void;
  projectId: string;
  onProjectChange: (id: string) => void;
  onTabChange: (tab: Page) => void;
  refreshRevision: number;
  onProactiveChanged: () => void;
  onChanged: () => Promise<unknown>;
  onTaskOpen: (taskId: string, projectId: string) => void;
  onEvidence: (evidence: Evidence) => void;
  onManagementOpen: (kind: ManagementKind, id: string, projectId: string) => void;
  onOverviewOpen: (projectId: string) => void;
  onMemoryOpen: (id: string, projectId?: string) => void;
  onSourceOpen: (id: string) => void;
  onMemoryReviewOpen: (projectId: string) => void;
  onConflictsOpen: () => void;
  onFeishuSettings: () => void;
  feishuEnabled?: boolean;
  badges: { proactive: number; followups: number; pending: number };
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}

const TABS: Array<{ id: CommsTab; label: string; icon: typeof ClipboardList; badgeKey?: 'proactive' | 'followups' | 'pending' }> = [
  { id: 'reports', label: '工作日报', icon: ClipboardList },
  { id: 'proactive', label: '主动推进与巡检', icon: Zap, badgeKey: 'proactive' },
  { id: 'followups', label: '提醒与跟进', icon: Bell, badgeKey: 'followups' },
  { id: 'inbox', label: '待确认内容', icon: InboxIcon, badgeKey: 'pending' },
  { id: 'chat-replies', label: '飞书自动回复', icon: MessageSquareReply },
];

export function CommsHub(props: Props) {
  const { activeTab, state, projectId, date, badges, feishuEnabled = false } = props;
  const visibleTabs = TABS.filter(tab => tab.id !== 'chat-replies' || feishuEnabled || activeTab === 'chat-replies');
  const tabsRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevTabRef = useRef(activeTab);
  const prevIdx = visibleTabs.findIndex(t => t.id === prevTabRef.current);
  const currIdx = visibleTabs.findIndex(t => t.id === activeTab);
  const direction: -1 | 0 | 1 = currIdx > prevIdx ? 1 : currIdx < prevIdx ? -1 : 0;
  prevTabRef.current = activeTab;
  useSlidingIndicator(tabsRef, '.space-tab.is-active', [activeTab, badges.proactive, badges.followups, badges.pending, feishuEnabled]);
  useScrollFade(tabsRef, [activeTab, visibleTabs.length]);
  usePageMotion(contentRef, activeTab, direction);

  return (
    <div className="space-shell">
      <header className="space-header">
        <div className="space-header-top">
          <div className="space-title-group">
            <h2>沟通与汇报</h2>
          </div>
          <div className="today-header-controls">
            <select
              aria-label="筛选项目范围"
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
        </div>
        <nav className="space-tabs sliding-indicator-container scroll-fade-x" ref={tabsRef} aria-label="沟通与汇报视图">
          <span className="sliding-indicator-bar space-tab-indicator" aria-hidden="true" />
          {visibleTabs.map(({ id, label, icon: Icon, badgeKey }) => {
            const count = badgeKey ? badges[badgeKey] : 0;
            return (
              <button
                key={id}
                type="button"
                className={`space-tab ${activeTab === id ? 'is-active' : ''}`}
                aria-current={activeTab === id ? 'page' : undefined}
                onClick={() => props.onTabChange(id)}
              >
                <Icon size={14} />
                <span>{label}</span>
                {count > 0 && (
                  <span className={`space-tab-count ${count > 0 ? 'is-attention' : ''}`}>
                    <CountPulse value={count} />
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="space-content" ref={contentRef}>
        <Suspense fallback={<PageLoading label="正在加载视图" />}>
          {activeTab === 'reports' && (
            <ReportWorkspace
              state={state}
              day={date}
              setDay={props.onDateChange}
              projectId={projectId}
              setProjectId={props.onProjectChange}
              hideProjectFilter
              onChanged={props.onChanged}
              notify={props.notify}
              onTaskOpen={props.onTaskOpen}
              onEvidence={props.onEvidence}
            />
          )}
          {activeTab === 'chat-replies' && (
            <ChatReplies
              projects={state.projects}
              projectId={projectId}
              onProjectChange={props.onProjectChange}
              openSettings={props.onFeishuSettings}
              refreshKey={props.refreshRevision}
            />
          )}
          {activeTab === 'proactive' && (
            <ProactiveCenter
              projects={state.projects}
              projectId={projectId}
              onProjectChange={props.onProjectChange}
              refreshRevision={props.refreshRevision}
              onChanged={props.onProactiveChanged}
              onTaskOpen={props.onTaskOpen}
              onManagementOpen={props.onManagementOpen}
              onOverviewOpen={props.onOverviewOpen}
              onMemoryReviewOpen={props.onMemoryReviewOpen}
              notify={props.notify}
            />
          )}
          {activeTab === 'followups' && (
            <FollowUpCenter
              state={state}
              projectId={projectId}
              date={date}
              onChanged={props.onChanged}
              onTaskOpen={props.onTaskOpen}
              notify={props.notify}
            />
          )}
          {activeTab === 'inbox' && (
            <Inbox
              projectId={projectId}
              onProjectChange={props.onProjectChange}
              state={state}
              onChanged={props.onChanged}
              onMemory={props.onMemoryOpen}
              onSource={props.onSourceOpen}
              onConflicts={props.onConflictsOpen}
              notify={props.notify}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
