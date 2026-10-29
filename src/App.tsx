import { RuntimeSettings, EncryptedExport } from './components/RuntimeSettings';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { GlobalSearch, LifecyclePanel, BatchImport } from './components/WorkspaceTools';
import type { SearchHit } from './components/WorkspaceTools';
import { Inbox } from './components/Inbox';
import { WorkspaceDraftContext, hasPendingDrafts, settleDrafts, resetDraftVersions } from './drafts';
import { RetentionFields, RetentionLabel, defaultRetention } from './components/RetentionFields';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Archive, ArrowDownToLine, ArrowRight, Bell, CalendarDays, Check, CheckCheck, ChevronDown, ClipboardList,
  ChevronRight, CircleAlert, FilePlus2, FileText, Folder, HardDrive, History, Layers3,
  ListTodo, Menu, MessageCircle, PencilLine, Plus, RefreshCw, Search, Settings2, ShieldCheck, Upload, X,
} from 'lucide-react';
import { ListPager } from './components/ListPager';
import { WaterMark } from './components/WaterMark';
const Workbench = lazy(() => import('./components/Workbench').then(m => ({ default: m.Workbench })));
import { Dialog, Spinner } from './components/ui';
import { ModelSettingsDialog, endpointInfo } from './components/ModelSettings';
const MemoryCenter=lazy(()=>import('./components/MemoryCenter').then(m=>({default:m.MemoryCenter})));
import { FeishuSettingsDialog } from './components/FeishuSettings';
import { ExtractionStatus } from './components/ExtractionStatus';
import { ExtractionDrafts } from './components/ExtractionDrafts';
import { ProposalEditor } from './components/ProposalEditor';
const TaskWorkspace=lazy(()=>import('./components/work/TaskWorkspace').then(m=>({default:m.TaskWorkspace})));
const ReportWorkspace=lazy(()=>import('./components/work/ReportWorkspace').then(m=>({default:m.ReportWorkspace})));
const TaskProposals=lazy(()=>import('./components/work/TaskProposals').then(m=>({default:m.TaskProposals})));
const DeliveryOverview=lazy(()=>import('./components/delivery/DeliveryOverview').then(m=>({default:m.DeliveryOverview})));
const FollowUpCenter=lazy(()=>import('./components/delivery/FollowUpCenter').then(m=>({default:m.FollowUpCenter})));
const AssistantWorkspace=lazy(()=>import('./components/delivery/AssistantWorkspace').then(m=>({default:m.AssistantWorkspace})));
import { useFollowUpAlerts } from './components/delivery/useFollowUpAlerts';
const GovernanceWorkspace=lazy(()=>import('./components/governance/GovernanceWorkspace').then(m=>({default:m.GovernanceWorkspace})));
const ChangeAcceptanceWorkspace=lazy(()=>import('./components/governance/ChangeAcceptanceWorkspace').then(m=>({default:m.ChangeAcceptanceWorkspace})));
const CoordinationWorkspace=lazy(()=>import('./components/governance/CoordinationWorkspace').then(m=>({default:m.CoordinationWorkspace})));
import { useManagementAttention } from './components/governance/useManagementAttention';
import { localDay, WorkFilters } from './components/work/shared';
import { asError, execute, exportBackup, readFile } from './api';
import { KIND_LABELS } from './types';
import type {
  AiSettings, AppState, Backup, BackupInspection, Evidence, FileInput, ImportResult, Job, Memory,
  MemoryDetail, MemoryKind, Page, Project, Proposal, Source, SourceDetail,
} from './types';

const QualityLab=lazy(()=>import('./components/QualityLab').then(m=>({default:m.QualityLab})));
type DialogName = 'quality' | 'runtime' | 'search' | 'lifecycle' | 'batch-import' | 'project' | 'import' | 'restore' | 'revise' | 'workspace' | 'settings' | 'feishu' | 'memory-center' | 'memory-review' | 'proposal' | null;
type Notice = { message: string; error?: boolean } | null;
const SAMPLE = {
  title: '示例 · 客户服务平台评审纪要',
  text: '客户服务平台评审纪要（示例资料）\n\n项目目标：一期面向客服团队，统一客户信息查询与工单处理。\n\n会议决策：一期优先上线工单列表和详情，知识库管理安排在下一阶段。\n\n验收要求：支持按状态筛选工单；处理记录保留操作人和时间。\n\n待办事项：设计负责人提交页面确认稿，研发负责人确认接口联调时间。具体交付日期待评审后确认。\n\n待关注风险：测试账号尚未开通，可能影响联调，需要与运维确认开通时间。',
};

function date(value: string | null | undefined, time = false) {
  if (!value) return '未记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(parsed);
}
function bytes(value: number) {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(value / 1024))} KiB`;
}
function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon ?? <FileText size={28} strokeWidth={1.4} />}</div><h2>{title}</h2>{children && <p>{children}</p>}{action && <div className="empty-actions">{action}</div>}</div>;
}
function Kind({ kind }: { kind: MemoryKind }) { return <span className="kind-label">{KIND_LABELS[kind] ?? kind}</span>; }

function Welcome({ onCreate, onRestore }: { onCreate: () => void; onRestore: () => void }) {
  return <section className="welcome-state">
    <div className="welcome-symbol"><Layers3 size={34} strokeWidth={1.5} /></div>
    <div className="eyebrow">开始使用</div>
    <h2>从一个项目开始</h2>
    <p>连接项目聊天和资料，让助理帮你关注每天的工作与交付。</p>
    <button className="button primary" onClick={onCreate}><Plus size={17} />创建第一个项目<ArrowRight size={16} /></button>
    <ol className="welcome-steps">
      <li><span>01</span><strong>接入信息</strong><p>连接飞书群聊、文档，或直接导入资料。</p></li>
      <li><span>02</span><strong>助理整理</strong><p>提取待办与变化，请你确认有歧义的内容。</p></li>
      <li><span>03</span><strong>看今天就够了</strong><p>优先看今日工作、待决策和交付风险。</p></li>
    </ol>
    <button className="text-button" onClick={onRestore}><History size={14} />从已有备份恢复</button>
  </section>;
}

export default function App() {
  const [encryptedExport,setEncryptedExport]=useState<Backup|null>(null);
  const [recordPage,setRecordPage]=useState(0);
  const [showArchived,setShowArchived]=useState(false);
  const [rawState, setState] = useState<AppState | null>(null);
  const state = useMemo(() => {
    if (!rawState) return null; if(showArchived)return rawState;
    const projects = new Set(rawState.lifecycle?.filter(l=>l.kind==='project'&&l.archived).map(l=>l.id));
    const sources = new Set(rawState.lifecycle?.filter(l=>l.kind==='source'&&l.archived).map(l=>l.id));
    return {...rawState,projects:rawState.projects.filter(p=>!projects.has(p.id)),sources:rawState.sources.filter(s=>!projects.has(s.projectId)&&!sources.has(s.id)),tasks:rawState.tasks.filter(t=>!projects.has(t.projectId)),memories:rawState.memories.filter(m=>!projects.has(m.projectId)),proposals:rawState.proposals.filter(p=>!projects.has(p.projectId)&&!sources.has(p.sourceId))};
  }, [rawState,showArchived]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>('workbench');
  const knowledgePage = page === 'sources' || page === 'memories';
  const [assistantQuestion, setAssistantQuestion] = useState<{ id: number; text: string } | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [memoryId, setMemoryId] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [memoryDetail, setMemoryDetail] = useState<MemoryDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedSegment, setFocusedSegment] = useState<string | null>(null);
  const [previewSegments, setPreviewSegments] = useState<Set<string>>(new Set());
  const [viewedRevision, setViewedRevision] = useState<number | null>(null);
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [content, setContent] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [importSample, setImportSample] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [lastSafetyBackup, setLastSafetyBackup] = useState<string | null>(null);
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [reminderRevision, setReminderRevision] = useState(0);
  const [manualExpanded, setManualExpanded] = useState(false);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [workDay, setWorkDay] = useState(localDay());
  const [workProjectId, setWorkProjectId] = useState('');
  const [managementFocusId, setManagementFocusId] = useState<string | undefined>();
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const toolsMenu = useRef<HTMLDetailsElement>(null);
  const deliveryPage = page === 'overview' || page === 'followups' || page === 'assistant';
  const managementPage = page === 'governance' || page === 'changes' || page === 'coordination';
  const workPage = managementPage || deliveryPage || page === 'workbench' || page === 'daily' || page === 'tasks' || page === 'reports';
  const reminders = useFollowUpAlerts(!!state, reminderRevision);
  const managementAttention = useManagementAttention(!!state, state?.managementRevision, reminderRevision);

  useEffect(() => {
    if (page !== 'workbench') return;
    const timer = window.setInterval(() => setWorkDay(localDay()), 60_000);
    return () => window.clearInterval(timer);
  }, [page]);

  useEffect(() => {
    if (!mobileNav) return;
    const node = sidebarRef.current;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button, input, summary, select, [tabindex="0"]') ?? []).filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
    const initialFocus = window.setTimeout(() => focusable()[0]?.focus({ preventScroll: true }), 0);
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMobileNav(false); }
      if (event.key === 'Tab') {
        const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
        if (!node?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle);
    return () => { window.clearTimeout(initialFocus); document.removeEventListener('keydown', handle); menuTriggerRef.current?.focus(); };
  }, [mobileNav]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!toolsMenu.current?.contains(event.target as Node)) toolsMenu.current?.removeAttribute('open');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && toolsMenu.current?.open) {
        toolsMenu.current.open = false;
        toolsMenu.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, []);

  const openTool = (next: DialogName) => {
    toolsMenu.current?.removeAttribute('open');
    toolsMenu.current?.querySelector('summary')?.focus();
    setDialog(next); setMobileNav(false);
  };

  useEffect(() => {
    let last = 0;
    const touch = () => { const at = Date.now(); if (at - last > 3000) { last = at; void execute('memory_activity').catch(() => {}); } };
    window.addEventListener('pointerdown', touch); window.addEventListener('keydown', touch);
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); };
  }, []);

  const stateRevision = useRef('');
  const refreshing = useRef(false);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (hasPendingDrafts()) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  const refresh = useCallback(async () => {
    const next = await execute<AppState>('get_state');
    setState(next); stateRevision.current = next.workspace.revision ?? '';
    setReminderRevision((current) => current + 1);
    setProjectId((current) => next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? null);
    setLoadError('');
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    execute<AppState>('get_state').then((next) => {
      if (!cancelled) { setState(next); setProjectId((current) => next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id ?? null); }
    }).catch((error) => { if (!cancelled) setLoadError(asError(error).message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadTick]);

  const sources = useMemo(() => state?.sources.filter((source) => source.projectId === projectId) ?? [], [state, projectId]);
  const memories = useMemo(() => state?.memories.filter((memory) => memory.projectId === projectId) ?? [], [state, projectId]);
  const activeProject = state?.projects.find((project) => project.id === projectId);
  const activeSource = sources.find((source) => source.id === sourceId);
  const runningJobs = state?.jobs.filter((job) => job.status === 'queued' || job.status === 'running') ?? [];
  const latestExtractions = useMemo(() => {
    const result = new Map<string, Job>();
    for (const job of [...(state?.jobs ?? [])].filter((item) => item.kind === 'extract').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))) {
      if (!result.has(job.sourceId)) result.set(job.sourceId, job);
    }
    return result;
  }, [state]);
  const extractionJob = sourceId ? latestExtractions.get(sourceId) : undefined;
  const editingProposal = state?.proposals.find((proposal) => proposal.id === editingProposalId);
  const proposals = state?.proposals.filter((proposal) => proposal.sourceId === sourceId) ?? [];
  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const historical = proposals.filter((proposal) => proposal.status !== 'pending');
  const activeMemory = memories.find((memory) => memory.id === memoryId);
  const selectedRevision = memoryDetail?.revisions.find((revision) => revision.number === (viewedRevision ?? memoryDetail.memory.revision));

  useEffect(() => {
    setSourceId((current) => sources.some((source) => source.id === current) ? current : sources[0]?.id ?? null);
    setMemoryId((current) => memories.some((memory) => memory.id === current) ? current : memories[0]?.id ?? null);
  }, [sources, memories]);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || refreshing.current) return;
      refreshing.current = true;
      void execute<{ revision: string }>('get_workspace_revision')
        .then(async result => { if (result.revision !== stateRevision.current) await refresh(); })
        .catch(error => setNotice({ message: asError(error).message, error: true }))
        .finally(() => { refreshing.current = false; });
    };
    const timer = window.setInterval(check, runningJobs.length ? 1500 : 8000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [runningJobs.length, refresh]);

  useEffect(() => {
    setSelected(new Set()); setPreviewSegments(new Set()); setContent(''); setManualExpanded(false);
  }, [sourceId]);
  useEffect(() => { if (selected.size > 0) setManualExpanded(true); }, [selected.size]);

  useEffect(() => {
    if (page !== 'sources' || !sourceId) { setSourceDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true); setDetailError('');
    execute<SourceDetail>('get_source', { sourceId }).then((detail) => { if (!cancelled) setSourceDetail(detail); })
      .catch((error) => { if (!cancelled) { setSourceDetail(null); setDetailError(asError(error).message); } })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId, page, activeSource?.status, activeSource?.segmentCount, reloadTick]);

  useEffect(() => { setViewedRevision(null); }, [memoryId]);
  useEffect(() => {
    if (page !== 'memories' || !memoryId) { setMemoryDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true); setDetailError('');
    execute<MemoryDetail>('get_memory', { memoryId }).then((detail) => { if (!cancelled) setMemoryDetail(detail); })
      .catch((error) => { if (!cancelled) { setMemoryDetail(null); setDetailError(asError(error).message); } })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [memoryId, page, activeMemory?.revision, reloadTick]);

  useEffect(() => {
    if (!focusedSegment || !sourceDetail) return;
    const timer = window.setTimeout(() => document.getElementById(`segment-${focusedSegment}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
    return () => window.clearTimeout(timer);
  }, [focusedSegment, sourceDetail]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => { const shortcut=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setDialog('search');}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[]);
  const openSearchHit = (hit:SearchHit) => {
    setDialog(null); setShowArchived(true);
    if(hit.kind==='task'){openTask(hit.id,hit.projectId||'');return;}
    if(hit.kind==='memory'){openMemory(hit.id,hit.projectId||'');return;}
    if(hit.kind==='source'){setProjectId(hit.projectId);setSourceId(hit.id);setPage('sources');return;}
    if(['meeting','governance','change','deliverable','weekly_report'].includes(hit.kind)){openManagement(hit.kind as import('./types').ManagementKind,hit.id,hit.projectId||'');return;}
    setWorkProjectId(hit.projectId||'');setProjectId(hit.projectId);if(hit.kind==='report'){setWorkDay(hit.title.slice(0,10));setPage('reports');}else setPage('overview');
  };
  useEffect(()=>{if(!('__TAURI_INTERNALS__' in window))return;let active=true;const removers:Array<()=>void>=[];void Promise.all([listen('open-inbox',()=>setPage('inbox')),listen('request-quit',()=>{void settleDrafts().then(()=>invoke('finish_quit')).catch(e=>setNotice({message:`草稿尚未保存，暂未退出：${asError(e).message}`,error:true}));})]).then(list=>{if(active)removers.push(...list);else list.forEach(remove=>remove());});return()=>{active=false;removers.forEach(remove=>remove());};},[]);
  const closeDialog = useCallback(() => setDialog(null), []);
  const run = async <T,>(name: string, operation: () => Promise<T>, message?: string): Promise<T | undefined> => {
    if (busy) return undefined;
    setBusy(name);
    try {
      const result = await operation();
      try { await refresh(); if (message) setNotice({ message }); }
      catch { setNotice({ message: '操作已完成，但工作区未能刷新。请点击右上角刷新按钮重新读取。', error: true }); }
      return result;
    } catch (error) { setNotice({ message: asError(error).message, error: true }); return undefined; }
    finally { setBusy(''); }
  };

  const changeProject = (id: string) => {
    if (workPage) { setWorkProjectId(id); setProjectId(id || state?.projects[0]?.id || null); setMobileNav(false); return; }
    setProjectId(id); setFilter(''); setSourceId(null); setMemoryId(null);
    setSelected(new Set()); setContent(''); setFocusedSegment(null); setMobileNav(false);
  };
  const changePage = (next: Page) => { setManagementFocusId(undefined); if (next === 'workbench') setWorkDay(localDay()); setPage(next); setFilter(''); setMobileNav(false); };
  const openImport = (sample = false) => { setImportSample(sample); setDialog('import'); };
  const toggleSegment = (id: string) => {
    setPreviewSegments(new Set());
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const createProposal = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !sourceId || !content.trim() || !selected.size) return;
    const result = await run<Proposal>('proposal', () => execute('create_proposal', { projectId, sourceId, segmentIds: [...selected], kind, content: content.trim() }), '候选已创建，请核对后确认。');
    if (result) { setContent(''); setSelected(new Set()); }
  };
  const openEvidence = (evidence: Evidence) => {
    const source = rawState?.sources.find((item) => item.id === evidence.sourceId);
    if(source&&!state?.sources.some(s=>s.id===source.id))setShowArchived(true);
    if (source) setProjectId(source.projectId);
    setPage('sources'); setSourceId(evidence.sourceId); setFocusedSegment(evidence.segmentId); setMobileNav(false);
  };
  const openTask = (taskId: string, taskProjectId: string) => { setWorkProjectId(taskProjectId); setFocusTaskId(taskId); setPage('tasks'); };
  const openManagement = (kind: import('./types').ManagementKind, id: string, itemProjectId: string) => { setWorkProjectId(itemProjectId || ''); setManagementFocusId(id); setPage(kind === 'governance' ? 'governance' : kind === 'change' || kind === 'deliverable' ? 'changes' : 'coordination'); };
  const openMemory = (id: string, memoryProjectId?: string) => { if (memoryProjectId) setProjectId(memoryProjectId); setFilter(''); setMemoryId(id); setPage('memories'); };
  const makeBackup = () => run<Backup>('backup', () => execute('create_backup'), '备份已创建，可导出保存。');
  const download = async (backup: Backup) => {
    if (busy) return;
    setBusy(`export-${backup.id}`);
    try { const completed = await exportBackup(backup.id, backup.filename); setNotice({ message: completed ? '备份已导出。' : '已取消导出。' }); }
    catch (error) { setNotice({ message: asError(error).message, error: true }); }
    finally { setBusy(''); }
  };

  const title = { workbench: '工作台', inbox: '待处理', governance: '风险与决策', changes: '变更与验收', coordination: '周报与会议', overview: '项目总览', followups: '提醒与跟进', assistant: '项目问答', daily: '每日清单', tasks: '全部任务', reports: '工作日报', sources: '项目资料', memories: '项目记忆', backups: '备份与恢复' }[page];
  const unfinishedCount = (state?.tasks ?? []).filter((task) => ['todo', 'in_progress', 'blocked'].includes(task.status)).length;
  const breadcrumb = workPage ? state?.projects.find((project) => project.id === workProjectId)?.name ?? '全部项目' : page === 'backups' ? '本机工作区' : activeProject?.name ?? '工作区';
  const sourceList = sources.filter((source) => source.title.toLowerCase().includes(filter.toLowerCase()));
  useEffect(()=>setRecordPage(0),[page,projectId,filter]);
  const memoryList = memories.filter((memory) => memory.content.toLowerCase().includes(filter.toLowerCase()));
  const retry = () => { setLoading(true); setLoadError(''); setReloadTick((value) => value + 1); };

  const recordTotal=(page==='sources'?sourceList:memoryList).length;
  const recordIndex=Math.min(recordPage,Math.max(0,Math.ceil(recordTotal/50)-1));
  const sectionIndex = knowledgePage ? 2 : page === 'overview' || managementPage ? 1 : 0;
  return <WorkspaceDraftContext.Provider value={state?.workspace.dataDir ?? ''}><div className={`app-shell water-shell ${knowledgePage ? 'has-records' : ''} ${page === 'workbench' ? 'is-workbench' : ''}`}>
    <header className="water-topbar" inert={mobileNav}>
      <button className="water-brand" onClick={() => changePage('workbench')} aria-label="项目助理工作台"><WaterMark size={37}/><span>项目助理</span></button>
      <nav className={`water-navigation selected-${sectionIndex}`} aria-label="主导航"><span className="water-navigation-current" aria-hidden="true"/>{([{ label: '今天', page: 'workbench' }, { label: '项目', page: 'overview' }, { label: '资料', page: 'sources' }] as const).map((entry, index) => <button key={entry.page} aria-current={sectionIndex === index ? 'page' : undefined} onClick={() => changePage(entry.page)}>{entry.label}</button>)}</nav>
      <div className="water-toolbar">{runningJobs.length > 0 && <span className="water-processing" role="status"><Spinner/><span>{runningJobs.length} 项处理中</span></span>}<button className="icon-button" aria-label="搜索工作区" title="搜索 · Ctrl K" onClick={() => openTool('search')}><Search size={20}/></button><button className="icon-button water-menu-trigger" ref={menuTriggerRef} aria-label={knowledgePage ? '项目与资料目录' : '全部功能与设置'} title={knowledgePage ? '项目与资料目录' : '全部功能与设置'} aria-expanded={mobileNav} aria-controls="workspace-navigation" onClick={() => setMobileNav(true)}><Menu size={21}/></button></div>
    </header>
    {mobileNav && <button className="nav-scrim" aria-label="收起导航" onClick={() => setMobileNav(false)} />}
    {(mobileNav || knowledgePage) && <aside id="workspace-navigation" ref={sidebarRef} className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`} inert={!mobileNav && !knowledgePage} role={mobileNav ? 'dialog' : undefined} aria-modal={mobileNav || undefined} aria-label={knowledgePage ? '项目与资料目录' : '全部功能与设置'} onTransitionEnd={event => { if (mobileNav && event.target === event.currentTarget && !event.currentTarget.contains(document.activeElement)) event.currentTarget.querySelector<HTMLButtonElement>('.water-drawer-close')?.focus({ preventScroll: true }); }}>
      <div className="brand"><WaterMark size={31}/><div className="brand-copy"><strong>项目助理</strong><span>工作空间</span></div><button className="icon-button water-drawer-close" aria-label="收起导航" onClick={() => setMobileNav(false)}><X size={18}/></button></div>
      <nav className="main-nav" aria-label="工作区导航">
        <button aria-current={page === 'workbench' ? 'page' : undefined} className={page === 'workbench' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('workbench')}><WaterMark size={19}/><span>今天</span></button>
        <button className="nav-item" onClick={()=>openTool('search')}><Search size={18}/><span>搜索</span><small>Ctrl K</small></button><details className="assistant-nav-more"><summary>更多工作工具<ChevronDown size={13}/></summary><button className={page === 'inbox' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('inbox')}><CheckCheck size={18} /><span>待处理</span></button>
        <button aria-current={page === 'overview' ? 'page' : undefined} className={page === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('overview')}><Layers3 size={18} /><span>项目总览</span></button>
        <button aria-current={managementPage ? 'page' : undefined} className={managementPage ? 'nav-item active' : 'nav-item'} onClick={() => changePage('governance')}><ShieldCheck size={18} /><span>项目管理</span>{managementAttention.count > 0 && <small className="nav-count" title="风险、待审批变更和验收关注">{managementAttention.count}</small>}</button>
        <button aria-current={page === 'followups' ? 'page' : undefined} className={page === 'followups' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('followups')}><Bell size={18} /><span>提醒与跟进</span>{reminders.count > 0 && <small className="nav-count">{reminders.count}</small>}</button>
        <button aria-current={page === 'assistant' ? 'page' : undefined} className={page === 'assistant' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('assistant')}><MessageCircle size={18} /><span>项目问答</span></button>
        <button aria-current={page === 'daily' ? 'page' : undefined} className={page === 'daily' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('daily')}><CalendarDays size={18} /><span>每日清单</span></button>
        <button aria-current={page === 'tasks' ? 'page' : undefined} className={page === 'tasks' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('tasks')}><ListTodo size={18} /><span>任务</span>{unfinishedCount > 0 && <small className="nav-count" title={`${unfinishedCount} 项未完成任务`}>{unfinishedCount}</small>}</button>
        <button aria-current={page === 'reports' ? 'page' : undefined} className={page === 'reports' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('reports')}><ClipboardList size={18} /><span>日报</span></button>
        </details><span className="nav-group-label knowledge-label">项目知识</span>
        <button aria-current={page === 'sources' ? 'page' : undefined} className={page === 'sources' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('sources')}><FileText size={18} /><span>项目资料</span></button>
        <button aria-current={page === 'memories' ? 'page' : undefined} className={page === 'memories' ? 'nav-item active' : 'nav-item'} onClick={() => changePage('memories')}><Layers3 size={18} /><span>项目记忆</span></button>
      </nav>
      <div className="sidebar-section-heading"><span>项目</span><button className="icon-button small" title="新建项目" aria-label="新建项目" disabled={!state || !!busy} onClick={() => setDialog('project')}><Plus size={16} /></button></div>
      <div className="project-list">
        {workPage && !!state?.projects.length && <button className={`project-item ${!workProjectId ? 'selected' : ''}`} onClick={() => changeProject('')}><Folder size={15} /><span>全部项目</span>{!workProjectId && <span className="selected-dot" />}</button>}
        {state?.projects.map((project) => <button key={project.id} aria-pressed={project.id === (workPage ? workProjectId : projectId)} className={`project-item ${project.id === (workPage ? workProjectId : projectId) ? 'selected' : ''}`} title={project.name} onClick={() => changeProject(project.id)}><Folder size={15} /><span>{project.name}</span>{project.id === (workPage ? workProjectId : projectId) && <span className="selected-dot" />}</button>)}
        {state && !state.projects.length && <button className="no-project" onClick={() => setDialog('project')}>创建第一个项目 <Plus size={14} /></button>}
      </div>
      {(page === 'sources' || page === 'memories') && <>
        <div className="sidebar-section-heading list-heading"><span>{page === 'sources' ? '项目资料' : '已确认记忆'}</span><span className="muted-count">{page === 'sources' ? sources.length : memories.length}</span></div>
        {activeProject && <label className="sidebar-search"><Search size={14} /><input aria-label={page === 'sources' ? '查找资料' : '查找记忆'} placeholder={page === 'sources' ? '查找资料…' : '查找记忆…'} value={filter} onChange={(event) => setFilter(event.target.value)} /></label>}
        <div className="record-list">
          {page === 'sources' ? sourceList.slice(recordIndex*50,(recordIndex+1)*50).map((source) => {
            const extraction = latestExtractions.get(source.id);
            const processing = extraction?.status === 'queued' || extraction?.status === 'running';
            return <button key={source.id} className={`record-item ${source.id === sourceId ? 'selected' : ''}`} onClick={() => { setSourceId(source.id); setMobileNav(false); }}>
              <div className="record-top"><FileText size={15} /><span>{source.title}</span></div><div className="record-meta"><span>{date(source.importedAt)}</span><span className={source.status === 'failed' || extraction?.status === 'failed' ? 'text-error' : ''}>{source.status === 'failed' ? '解析失败' : source.status === 'processing' ? '解析中' : processing ? '提取中' : extraction?.status === 'failed' ? '提取失败' : extraction?.status === 'cancelled' ? '提取已取消' : extraction?.status === 'succeeded' ? '提取完成' : `${source.segmentCount} 个段落`}</span></div>
            </button>;
          }) : memoryList.slice(recordIndex*50,(recordIndex+1)*50).map((memory) => <button key={memory.id} className={`record-item memory-record ${memory.id === memoryId ? 'selected' : ''}`} onClick={() => { setMemoryId(memory.id); setMobileNav(false); }}><div className="record-meta"><span>{KIND_LABELS[memory.kind]}</span><span>v{memory.revision}</span></div><p>{memory.content}</p><RetentionLabel policy={memory.retention} /></button>)}
          <ListPager page={recordIndex} total={recordTotal} onChange={setRecordPage}/>
          {activeProject && !(page === 'sources' ? sourceList : memoryList).length && <p className="sidebar-hint">{filter ? '没有匹配的记录' : page === 'sources' ? '导入资料后会显示在这里' : '确认后的记忆会显示在这里'}</p>}
        </div>
      </>}
      <div className="sidebar-bottom"><details className="sidebar-tools" ref={toolsMenu}>
        <summary><Settings2 size={17} /><span>设置与工具</span>{!!state?.memoryReviewCount && <small title="待确认记忆">{state.memoryReviewCount}</small>}<ChevronDown size={14} /></summary>
        <div className="sidebar-tools-menu">
          <button className="model-settings-link" onClick={()=>openTool('quality')}><ShieldCheck size={16}/><span>质量与费用评估</span></button><button className="model-settings-link" onClick={() => openTool('runtime')}><Settings2 size={16}/><span>桌面运行与数据保护</span></button><label className="field-hint"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>显示归档记录</label><button className="model-settings-link" onClick={() => openTool('lifecycle')}><Archive size={16}/><span>项目归档与资料版本</span></button><button className="model-settings-link" onClick={() => openTool('memory-center')} disabled={!state || !!busy}><Layers3 size={16} /><span>记忆中心</span>{!!state?.memoryReviewCount && <small>{state.memoryReviewCount} 待确认</small>}<ChevronRight size={13} /></button>
          <button className="model-settings-link" onClick={() => openTool('feishu')} disabled={!state || !!busy}><MessageCircle size={16} /><span>飞书助理</span><ChevronRight size={13} /></button>
          <button className="model-settings-link" onClick={() => openTool('settings')} disabled={!state || !!busy}><Settings2 size={16} /><span>模型设置</span><small>{state?.aiSettings?.configured ? '已配置' : '未配置'}</small></button>
          <button aria-current={page === 'backups' ? 'page' : undefined} className={`model-settings-link ${page === 'backups' ? 'active' : ''}`} onClick={() => { toolsMenu.current?.removeAttribute('open'); changePage('backups'); }}><Archive size={16} /><span>备份与恢复</span><ChevronRight size={13} /></button>
          <button className="workspace-link" onClick={() => openTool('workspace')} disabled={!state}><HardDrive size={15} /><span>本机存储</span><ChevronRight size={13} /></button>
        </div>
      </details></div>
    </aside>}

    <main className="app-main" inert={mobileNav}>
      {page !== 'workbench' && <header className="topbar"><div className="topbar-leading"><span className="breadcrumb">{breadcrumb}</span><ChevronRight size={13} /><h1>{title}</h1></div><div className="topbar-actions">{knowledgePage && <div className="water-record-tabs"><button aria-pressed={page === 'sources'} onClick={() => changePage('sources')}>资料</button><button aria-pressed={page === 'memories'} onClick={() => changePage('memories')}>记忆</button></div>}{page === 'sources' && activeProject && <button className="button primary compact" onClick={() => openImport()} disabled={!!busy}><Plus size={15} />导入资料</button>}</div></header>}

      {state && state.workspace.recoveredJobs > 0 && !recoveryDismissed && <div className="recovery-banner"><RefreshCw size={15} /><span>已恢复 {state.workspace.recoveredJobs} 项中断的处理任务，资料仍保存在本机。</span><button className="icon-button small" aria-label="关闭恢复提示" onClick={() => setRecoveryDismissed(true)}><X size={15} /></button></div>}


      {page !== 'workbench' && ((reminders.showBanner && page !== 'followups') || (managementAttention.showBanner && !managementPage)) && <div className="water-attention-strip" role="status" aria-label="事项提醒"><Bell size={14}/>{reminders.showBanner && page !== 'followups' && <button onClick={() => { setWorkDay(localDay()); setWorkProjectId(''); changePage('followups'); }}>{reminders.count} 项待跟进<ChevronRight size={12}/></button>}{managementAttention.showBanner && !managementPage && <button onClick={() => { setWorkDay(localDay()); setWorkProjectId(''); changePage(managementAttention.items[0]?.kind === 'governance' ? 'governance' : 'changes'); }}>{managementAttention.count} 项管理关注<ChevronRight size={12}/></button>}<button className="icon-button" aria-label="收起本次事项提醒" onClick={() => { reminders.dismiss(); managementAttention.dismiss(); }}><X size={13}/></button></div>}
      <Suspense fallback={<div className="loading-view" role="status"><Spinner/>正在加载页面…</div>}>
      {loading ? <div className="loading-view"><Spinner /><span>正在打开本地工作区…</span></div> : loadError ? <Empty icon={<CircleAlert size={30} />} title="无法打开工作区" action={<button className="button primary" onClick={retry}><RefreshCw size={16} />重新连接</button>}>{loadError}</Empty> : state && !state.projects.length && page !== 'backups' ? <Welcome onCreate={() => setDialog('project')} onRestore={() => changePage('backups')} /> : page === 'workbench' && state ? <Workbench state={state} date={workDay} projectId={workProjectId} onProjectChange={setWorkProjectId} onNavigate={changePage} onProjectOpen={id => { setWorkProjectId(id); setProjectId(id); changePage('overview'); }} onTaskOpen={openTask} onManagementOpen={openManagement} onAsk={text => { setAssistantQuestion({ id: Date.now(), text }); changePage('assistant'); }} onChanged={refresh} onConnect={() => openTool('memory-center')} onReview={() => openTool('memory-review')} onMemoryOpen={openMemory} onSourceOpen={id => { const source = state.sources.find(item => item.id === id); if (source) { setProjectId(source.projectId); setSourceId(id); changePage('sources'); } }} /> : page === 'inbox' && state ? <Inbox state={state} onChanged={refresh} onMemory={(id, project) => openMemory(id, project)} onSource={id => { const source = state.sources.find(s => s.id === id); if (source) { setProjectId(source.projectId); setSourceId(id); setPage('sources'); } }} onConflicts={() => openTool('memory-center')} /> : managementPage && state ? <div className="delivery-shell management-shell"><nav className="management-tabs" aria-label="项目管理模块">{(['governance', 'changes', 'coordination'] as const).map((entry) => <button key={entry} aria-current={page === entry ? 'page' : undefined} className={page === entry ? 'active' : ''} onClick={() => changePage(entry)}>{entry === 'governance' ? '风险、问题与决策' : entry === 'changes' ? '需求变更与验收' : '周报与会议准备'}</button>)}</nav><WorkFilters day={workDay} onDayChange={setWorkDay} projects={state.projects} projectId={workProjectId} onProjectChange={setWorkProjectId} />{page === 'governance' ? <GovernanceWorkspace focusId={managementFocusId} state={state} projectId={workProjectId} date={workDay} onChanged={refresh} onTaskOpen={openTask} onEvidence={openEvidence} notify={(message, error) => setNotice({ message, error })} /> : page === 'changes' ? <ChangeAcceptanceWorkspace focusId={managementFocusId} state={state} projectId={workProjectId} date={workDay} onChanged={refresh} onTaskOpen={openTask} onEvidence={openEvidence} notify={(message, error) => setNotice({ message, error })} /> : <CoordinationWorkspace focusId={managementFocusId} state={state} projectId={workProjectId} date={workDay} onChanged={refresh} onTaskOpen={openTask} onEvidence={openEvidence} notify={(message, error) => setNotice({ message, error })} />}</div> : deliveryPage && state ? <div className="delivery-shell"><WorkFilters day={workDay} onDayChange={setWorkDay} projects={state.projects} projectId={workProjectId} onProjectChange={setWorkProjectId} />{page === 'overview' ? <DeliveryOverview onMemoryOpen={openMemory} onEvidence={openEvidence} onManagementOpen={openManagement} state={state} projectId={workProjectId} date={workDay} onChanged={refresh} onTaskOpen={openTask} notify={(message, error) => setNotice({ message, error })} /> : page === 'followups' ? <FollowUpCenter state={state} projectId={workProjectId} date={workDay} onChanged={refresh} onTaskOpen={openTask} notify={(message, error) => setNotice({ message, error })} /> : <AssistantWorkspace initialQuestion={assistantQuestion} onInitialQuestionConsumed={() => setAssistantQuestion(null)} onMemoryOpen={openMemory} onManagementOpen={openManagement} state={state} projectId={workProjectId} date={workDay} onChanged={refresh} onTaskOpen={openTask} onEvidence={openEvidence} notify={(message, error) => setNotice({ message, error })} />}</div> : workPage && state ? page === 'reports' ? <ReportWorkspace key="reports" state={state} day={workDay} setDay={setWorkDay} projectId={workProjectId} setProjectId={setWorkProjectId} onChanged={refresh} notify={(message, error) => setNotice({ message, error })} onTaskOpen={openTask} onEvidence={openEvidence} /> : <TaskWorkspace key={page} mode={page === 'daily' ? 'daily' : 'tasks'} state={state} day={workDay} setDay={setWorkDay} projectId={workProjectId} setProjectId={setWorkProjectId} focusTaskId={focusTaskId} onChanged={refresh} notify={(message, error) => setNotice({ message, error })} onEvidence={openEvidence} onReport={() => setPage('reports')} /> : page === 'backups' ? <div className="backup-page">
        <div className="page-heading"><div><div className="eyebrow">本地数据保护</div><h2>备份与恢复</h2><p>备份包含项目、资料、记忆、任务事件和日报版本。模型设置与密钥不包含在备份中。</p></div><button className="button primary" onClick={makeBackup} disabled={!!busy}>{busy === 'backup' ? <Spinner /> : <Plus size={16} />}创建备份</button></div>
        <div className="backup-summary"><div><span className="summary-number">{state?.backups.length ?? 0}</span><span>份本机备份</span></div><p>创建后可导出 ZIP 文件，保存到其他位置。</p></div>
        <div className="section-title-row"><h3>已有备份</h3><span>{state?.backups.length ?? 0} 份记录</span></div>
        {state?.backups.length ? <div className="backup-list">{[...state.backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((backup) => {
          const safety = backup.kind === 'safety' || backup.id === lastSafetyBackup || /safety/i.test(backup.filename);
          return <div className="backup-row" key={backup.id}><div className="backup-row-icon">{safety ? <ShieldCheck size={20} /> : <Archive size={20} />}</div><div className="backup-row-content"><div className="backup-row-title">{safety ? '还原前自动安全副本' : '完整工作区备份'}<span className="subtle-tag">{bytes(backup.byteSize)}</span></div><div className="backup-row-meta">{date(backup.createdAt, true)}<span>·</span>{backup.counts.projects} 个项目<span>·</span>{backup.counts.sources} 份资料<span>·</span>{backup.counts.memories} 条记忆<span>·</span>{backup.counts.tasks ?? 0} 项任务<span>·</span>{backup.counts.reports ?? 0} 个日报版本</div><div className="backup-filename" title={backup.filename}>{backup.filename}</div></div><button className="button secondary compact" onClick={() => download(backup)} disabled={!!busy}>{busy === `export-${backup.id}` ? <Spinner /> : <ArrowDownToLine size={15} />}导出</button><button className="button secondary compact" disabled={!!busy||!('__TAURI_INTERNALS__' in window)} onClick={()=>setEncryptedExport(backup)}>加密导出</button></div>;
        })}</div> : <div className="inline-empty"><Archive size={25} strokeWidth={1.4} /><h3>还没有备份</h3><p>创建第一份备份，保留当前工作区的完整副本。</p></div>}
        <section className="restore-section"><div className="restore-icon"><History size={22} /></div><div><h3>从备份恢复工作区</h3><p>还原会替换当前工作区。确认前可核对内容，系统会先保存安全副本。</p><button className="button secondary" onClick={() => setDialog('restore')} disabled={!!busy}><Upload size={15} />选择备份文件</button></div></section>
        <div className="storage-note"><HardDrive size={15} /><span>数据目录</span><code>{state?.workspace.dataDir}</code></div>
      </div> : !activeProject ? <Empty icon={<Folder size={32} strokeWidth={1.35} />} title="先创建一个项目" action={<button className="button primary" onClick={() => setDialog('project')}><Plus size={16} />新建项目</button>}>在项目中管理资料、任务和已确认的记忆。</Empty> : page === 'sources' ? <div className="workspace-grid">
        <section className="reader-panel">
          {detailLoading ? <div className="loading-view"><Spinner /><span>正在读取原文…</span></div> : detailError ? <Empty title="暂时无法读取资料" action={<button className="button secondary" onClick={() => setReloadTick((tick) => tick + 1)}>重试</button>}>{detailError}</Empty> : !sourceDetail ? <Empty title="导入第一份项目资料" action={<><button className="button primary" onClick={() => openImport()}><Plus size={16} />导入资料</button><button className="button text-button" onClick={() => openImport(true)}>先看看示例 <ArrowRight size={14} /></button></>}>粘贴会议纪要，或选择 TXT、MD、DOCX 和文本 PDF。</Empty> : <>
            <div className="document-heading"><div className="eyebrow">原始资料 <span className="separator">/</span> {sourceDetail.source.kind.toUpperCase()}</div><h2>{sourceDetail.source.title}</h2><div className="document-metadata"><span>{date(sourceDetail.source.importedAt, true)} 导入</span><span>资料日期：{date(sourceDetail.source.sourceAt)}</span><span>{sourceDetail.segments.length} 个段落</span></div>{sourceDetail.source.originalFilename && <p className="original-filename">{sourceDetail.source.originalFilename}</p>}</div>
            {sourceDetail.source.status === 'failed' ? <div className="document-error"><CircleAlert size={20} /><div><h3>这份资料未能完成解析</h3><p>{sourceDetail.source.error || '未提取到可用的文本，请检查文件后重新导入。'}</p><button className="button secondary compact" onClick={() => openImport()}>重新选择资料</button></div></div> : sourceDetail.source.status === 'processing' ? <div className="loading-view"><Spinner /><span>正在解析资料，完成后会自动显示段落…</span></div> : <>
              <div className="selection-toolbar"><span><CheckCheck size={15} />{previewSegments.size ? `正在查看候选的 ${previewSegments.size} 处依据` : '选择原文段落，作为候选的依据'}</span>{previewSegments.size > 0 ? <button className="text-button" onClick={() => { setPreviewSegments(new Set()); setFocusedSegment(null); }}>结束查看</button> : selected.size > 0 && <button className="text-button" onClick={() => setSelected(new Set())}>取消选择（{selected.size}）</button>}</div>
              <div className="source-segments">{sourceDetail.segments.map((segment, index) => <label className={`segment ${selected.has(segment.id) ? 'segment-selected' : ''} ${focusedSegment === segment.id ? 'segment-focused' : ''} ${previewSegments.has(segment.id) ? 'segment-evidence' : ''}`} id={`segment-${segment.id}`} key={segment.id}>
                <span className="segment-checkbox"><input type="checkbox" aria-label={`选择${segment.locator}`} checked={selected.has(segment.id)} onChange={() => toggleSegment(segment.id)} disabled={!!busy} /><span aria-hidden="true"><Check size={12} /></span></span><div className="segment-body"><div className="segment-locator"><span>{String(index + 1).padStart(2, '0')}</span><span>{segment.locator}</span>{focusedSegment === segment.id && <span className="located-label">已定位原文</span>}</div><p>{segment.text}</p></div>
              </label>)}</div><div className="document-end"><span />原文结束<span /></div>
            </>}
          </>}
        </section>
        <aside className={`inspector ${!activeSource ? 'inspector-empty' : ''}`}>
          <div className="inspector-heading"><span className="eyebrow">核对与确认</span><h2>待确认内容</h2><p>核对内容与原文，再保存为任务或记忆。</p></div>
          <ExtractionStatus source={activeSource} job={extractionJob} settings={state?.aiSettings} busy={busy} onSettings={() => setDialog('settings')} onStart={() => { if (sourceId) void run<Job>('start-extraction', () => execute('start_extraction', { sourceId })); }} onRetry={() => { if (extractionJob) void run<Job>('retry-extraction', () => execute('retry_extraction', { jobId: extractionJob.id })); }} onCancel={() => { if (extractionJob) void run<Job>('cancel-extraction', () => execute('cancel_extraction', { jobId: extractionJob.id }), '提取已取消，已发送的请求可能仍由模型服务处理。'); }} />
          <TaskProposals proposals={(state?.taskProposals ?? []).filter((proposal) => proposal.sourceId === sourceId)} tasks={state?.tasks ?? []} day={workDay} onChanged={refresh} notify={(message, error) => setNotice({ message, error })} onEvidence={(ids) => { setPreviewSegments(new Set(ids)); setFocusedSegment(ids[0] ?? null); }} onTaskOpen={openTask} />
          {(state?.extractionBatches ?? []).filter((batch) => batch.sourceId === sourceId && batch.coverage?.issues?.length).map((batch) => <details className="candidate" key={`${batch.jobId}:${batch.batchKey}`}><summary>提取覆盖待核对 · {batch.status === 'review_pending' ? '已安排局部复查' : batch.status === 'partitioned' ? '饱和批次已安排分区补提' : '处理完成仍可能存在遗漏'}</summary>{batch.coverage?.issues?.map((issue, index) => <p className="field-hint" key={index}>{issue.reason}{issue.segmentId && <button className="text-button tiny" onClick={() => { setPreviewSegments(new Set([issue.segmentId!])); setFocusedSegment(issue.segmentId!); }}>定位原文</button>}</p>)}{batch.coverage?.previousCandidates?.length ? <details><summary>核对复查前的候选，防止遗漏原有事实</summary>{batch.coverage.previousCandidates.map((candidate, index) => <blockquote key={index}>{candidate.content}</blockquote>)}</details> : null}</details>)}
          <ExtractionDrafts drafts={(state?.extractionDrafts ?? []).filter((draft) => draft.sourceId === sourceId)} onChanged={refresh} notify={(message, error) => setNotice({ message, error })} onEvidence={(ids) => { setPreviewSegments(new Set(ids)); setFocusedSegment(ids[0] ?? null); }} />
          <div className="candidate-section"><div className="section-title-row"><h3>待确认记忆</h3><span className="count-badge">{pending.length}</span></div>
            {pending.length ? pending.map((proposal) => <div className="candidate" key={proposal.id}>
              <div className="candidate-label"><Kind kind={proposal.kind} /><RetentionLabel policy={proposal.retention} /><button className="text-button tiny" onClick={() => { setPreviewSegments(new Set(proposal.segmentIds)); setFocusedSegment(proposal.segmentIds[0] ?? null); }}>{proposal.segmentIds.length} 处依据 <ChevronRight size={11} /></button></div>
              <div className="candidate-provenance"><span className={proposal.origin === 'ai' ? 'ai-origin' : ''}>{proposal.origin === 'ai' ? 'AI 提取' : '手动整理'}</span>{proposal.origin === 'ai' && proposal.model && <span title={`提取规则版本：${proposal.promptVersion ?? '未记录'}`}>{proposal.model}</span>}{proposal.edited && <span>已编辑</span>}</div>
              <p>{proposal.content}</p>
              {(state?.extractionDrafts ?? []).filter((draft) => draft.proposalId === proposal.id && draft.issues.length > 0).map((draft) => <details className="candidate-quotes" key={draft.id}><summary>查看提取校验记录</summary>{draft.issues.map((issue, index) => <p className="field-hint" key={index}>{issue.field}：{issue.reason}；原值：{JSON.stringify(issue.value)}</p>)}</details>)}
              {(proposal.facets?.entity || proposal.facets?.topic || proposal.facets?.role || proposal.facets?.conditions?.length || proposal.facets?.validFrom || proposal.facets?.validUntil) && <p className="field-hint">适用范围：{[proposal.facets.entity, proposal.facets.topic, proposal.facets.role ? ({ owner: '负责人', approver: '审批人', contact: '联系人' } as const)[proposal.facets.role] : '', ...(proposal.facets.conditions ?? []), proposal.facets.validFrom ? `生效 ${proposal.facets.validFrom}` : '', proposal.facets.validUntil ? `失效 ${proposal.facets.validUntil}` : ''].filter(Boolean).join(' · ')}</p>}
              {!!proposal.quotes?.length && <details className="candidate-quotes"><summary>查看原文摘录 <ChevronDown size={12} /></summary>{proposal.quotes.map((quote, index) => <div key={`${quote.segmentId}-${index}`}><blockquote>{quote.quote}</blockquote><button className="text-button tiny" onClick={() => { setPreviewSegments(new Set([quote.segmentId])); setFocusedSegment(quote.segmentId); }}>定位原文 <ArrowRight size={11} /></button></div>)}</details>}
              <div className="candidate-actions"><button className="button primary compact" disabled={!!busy} onClick={() => run<Memory>(`confirm-${proposal.id}`, () => execute('confirm_proposal', { proposalId: proposal.id }), '已确认并保存为项目记忆。')}>{busy === `confirm-${proposal.id}` ? <Spinner /> : <Check size={14} />}确认记忆</button><button className="text-button" disabled={!!busy} onClick={() => { setEditingProposalId(proposal.id); setDialog('proposal'); }}><PencilLine size={12} />编辑</button><button className="text-button" disabled={!!busy} onClick={() => run(`reject-${proposal.id}`, () => execute('reject_proposal', { proposalId: proposal.id }), '候选已忽略。')}>忽略</button></div>
            </div>) : <p className="panel-hint">提取或手动整理后，在这里核对并保存记忆。</p>}
          </div>
          <details className="manual-proposal-section" open={manualExpanded} onToggle={(event) => setManualExpanded(event.currentTarget.open)}><summary><Plus size={14} /><span>手动整理候选</span>{selected.size > 0 && <small>已选 {selected.size} 段</small>}<ChevronDown size={14} /></summary><form className="proposal-form" onSubmit={createProposal}>
            <div className={`evidence-selection ${selected.size ? 'has-selection' : ''}`}><CheckCheck size={16} /><span>{selected.size ? `已选 ${selected.size} 个原文段落` : '尚未选择原文段落'}</span></div>
            <label className="field-label" htmlFor="proposal-kind">记录类型</label><select id="proposal-kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} disabled={!!busy || !sourceDetail?.segments.length}>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <div className="field-label-row"><label className="field-label" htmlFor="proposal-content">候选内容</label><button type="button" className="text-button tiny" disabled={!selected.size || !!busy} onClick={() => setContent(sourceDetail?.segments.filter((segment) => selected.has(segment.id)).map((segment) => segment.text).join('\n\n') ?? '')}>填入所选原文</button></div>
            <textarea id="proposal-content" rows={5} value={content} maxLength={20000} onChange={(event) => setContent(event.target.value)} placeholder="写下需要保留的事实、决策、需求或风险" disabled={!!busy || !sourceDetail?.segments.length} />
            <button className="button primary full-width" type="submit" disabled={!!busy || !selected.size || !content.trim()}>{busy === 'proposal' ? <Spinner /> : <Plus size={15} />}创建候选</button>
          </form></details>
          {historical.length > 0 && <details className="candidate-history"><summary>已处理候选 <span>{historical.length}</span><ChevronDown size={14} /></summary>{historical.map((proposal) => <div className="processed-candidate" key={proposal.id}><div><span>{proposal.status === 'confirmed' ? '已确认' : '已忽略'}</span><Kind kind={proposal.kind} /><span>{proposal.origin === 'ai' ? 'AI 提取' : '手动整理'}</span></div><p>{proposal.content}</p>{proposal.memoryId && <button className="text-button tiny" onClick={() => openMemory(proposal.memoryId!)}>查看记忆 <ArrowRight size={12} /></button>}</div>)}</details>}
        </aside>
      </div> : <div className="workspace-grid">
        <section className="reader-panel memory-panel">
          {detailLoading ? <div className="loading-view"><Spinner /><span>正在读取记忆…</span></div> : detailError ? <Empty title="暂时无法读取记忆" action={<button className="button secondary" onClick={() => setReloadTick((tick) => tick + 1)}>重试</button>}>{detailError}</Empty> : !memoryDetail || !selectedRevision ? <Empty icon={<Layers3 size={30} strokeWidth={1.4} />} title="还没有已确认记忆" action={<button className="button secondary" onClick={() => changePage('sources')}>从资料整理候选 <ArrowRight size={15} /></button>}>从项目资料中提取或手动整理，确认后保存在这里。</Empty> : <>
            <div className="memory-heading"><div><div className="eyebrow">已确认记忆</div><div className="memory-kind-row"><Kind kind={memoryDetail.memory.kind} /><RetentionLabel policy={selectedRevision.retention} /><span className="version-tag">v{selectedRevision.number}</span>{selectedRevision.number === memoryDetail.memory.revision && <span className="current-label"><span />当前版本</span>}</div></div><button className="button secondary compact" disabled={!!busy} onClick={() => setDialog('revise')}>修订记忆</button></div>
            {selectedRevision.number !== memoryDetail.memory.revision && <div className="historical-banner"><History size={15} /><span>正在查看历史版本 v{selectedRevision.number}</span><button className="text-button" onClick={() => setViewedRevision(null)}>回到最新版</button></div>}
            <p className="memory-content">{selectedRevision.content}</p>
            <div className="memory-metadata"><span>{date(selectedRevision.createdAt, true)}</span><span>{selectedRevision.origin === 'automatic' ? '自动整理' : selectedRevision.origin === 'confirmation' ? '原文确认' : '用户修订'}</span></div>
            <section className="evidence-section"><div className="section-title-row"><h3>原文依据</h3><span>{selectedRevision.evidence.length} 处</span></div>{selectedRevision.evidence.length ? selectedRevision.evidence.map((evidence) => <div className="evidence-block" key={evidence.segmentId}><div className="evidence-heading"><FileText size={14} /><span>{evidence.sourceTitle}</span></div><p>{evidence.text}</p><div className="evidence-footer"><span>{evidence.locator}</span><button className="text-button" onClick={() => openEvidence(evidence)}>打开原文 <ArrowRight size={14} /></button></div></div>) : <div className="correction-note"><CircleAlert size={17} /><p>这一版是个人修正，未引用原文依据。</p></div>}</section>
            {selectedRevision.reason && <div className="revision-reason"><span>修订说明</span><p>{selectedRevision.reason}</p></div>}
          </>}
        </section>
        <aside className={`inspector timeline-inspector ${!memoryDetail ? 'inspector-empty' : ''}`}><div className="inspector-heading"><span className="eyebrow">版本记录</span><h2>修订历史</h2><p>选择版本，查看当时的内容与依据。</p></div>{memoryDetail ? <div className="timeline">{[...memoryDetail.revisions].sort((a, b) => b.number - a.number).map((revision) => <button className={`timeline-item ${selectedRevision?.number === revision.number ? 'timeline-active' : ''}`} key={revision.id} onClick={() => setViewedRevision(revision.number)}><span className="timeline-dot" /><div className="timeline-top"><strong>v{revision.number}</strong><span>{date(revision.createdAt, true)}</span></div><h3>{revision.origin === 'automatic' ? '自动整理' : revision.origin === 'confirmation' ? '原文确认' : '修订记忆'}</h3><p>{revision.reason || (revision.origin === 'confirmation' ? '根据所选原文确认。' : '个人修正。')}</p><span className="timeline-evidence">{revision.evidence.length ? `${revision.evidence.length} 处原文依据` : '未引用原文'}</span></button>)}</div> : <p className="panel-hint">确认第一条记忆后，会在这里记录版本历史。</p>}</aside>
      </div>}
      </Suspense>
    </main>

    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleAlert size={18} /> : <Check size={18} />}<p>{notice.message}</p><button className="icon-button small" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={16} /></button></div>}

    {dialog === 'project' && <ProjectDialog busy={busy} close={closeDialog} submit={async (name, description) => {
      const created = await run<Project>('project', () => execute('create_project', { name, description }), '项目已创建。');
      if (created) { changeProject(created.id); setPage('sources'); closeDialog(); }
    }} />}
    {dialog === 'import' && activeProject && <ImportDialog busy={busy} close={closeDialog} project={activeProject} sample={importSample} settings={state?.aiSettings} onBatch={() => setDialog('batch-import')} submit={async (payload, type) => {
      const result = await run<ImportResult>('import', () => execute(type === 'text' ? 'import_text' : 'import_file', { ...payload, projectId }), undefined);
      if (result) { setSourceId(result.sourceId); setPage('sources'); closeDialog(); setNotice({ message: result.duplicate ? '这份资料已导入，已打开原有记录。' : '资料已接收，处理状态会自动更新。' }); }
    }} notify={(message) => setNotice({ message, error: true })} />}
    {encryptedExport && <EncryptedExport backupId={encryptedExport.id} filename={encryptedExport.filename} close={()=>setEncryptedExport(null)}/>}
    {dialog === 'runtime' && <RuntimeSettings close={closeDialog} onChanged={refresh}/>}
    {dialog === 'search' && rawState && <GlobalSearch state={rawState} close={closeDialog} open={openSearchHit}/>}
    {dialog === 'lifecycle' && rawState && <LifecyclePanel state={rawState} close={closeDialog} onChanged={refresh}/>}
    {dialog === 'batch-import' && activeProject && <BatchImport project={activeProject} autoExtract={!!state?.aiSettings.autoExtract} close={closeDialog} onChanged={refresh}/>}
    {dialog === 'settings' && <ModelSettingsDialog close={closeDialog} onSaved={refresh} />}
    {dialog === 'quality' && <Suspense fallback={<div className="dialog-overlay"><div className="dialog loading-view" role="status"><Spinner/>正在打开质量评估…</div></div>}><QualityLab close={closeDialog}/></Suspense>}
    {(dialog === 'memory-center' || dialog === 'memory-review') && <Suspense fallback={<div className="dialog-overlay"><div className="dialog loading-view" role="status"><Spinner/>正在打开记忆中心…</div></div>}><MemoryCenter projects={state?.projects ?? []} close={closeDialog} onSaved={refresh} initialTab={dialog === 'memory-review' ? 'reviews' : 'sources'} onAccount={() => openTool('feishu')} onModelSettings={() => openTool('settings')} /></Suspense>}
    {dialog === 'feishu' && <FeishuSettingsDialog projects={state?.projects ?? []} close={closeDialog} onSaved={refresh} />}
    {dialog === 'proposal' && editingProposal && <ProposalEditor proposal={editingProposal} busy={busy} close={closeDialog} submit={async (payload) => {
      const result = await run<Proposal>('edit-proposal', () => execute('update_proposal', payload), '候选已更新，请核对后确认。');
      if (result) closeDialog();
    }} />}
    {dialog === 'revise' && memoryDetail && <ReviseDialog detail={memoryDetail} sources={sources} busy={busy} close={closeDialog} reload={async () => {
      const detail = await execute<MemoryDetail>('get_memory', { memoryId: memoryDetail.memory.id }); setMemoryDetail(detail); return detail;
    }} submit={async (payload) => {
      const result = await run<Memory>('revise', () => execute('revise_memory', payload), '修订已保存，旧版本与依据已保留。');
      if (result) { setViewedRevision(null); closeDialog(); }
    }} notify={(message) => setNotice({ message, error: true })} />}
    {dialog === 'restore' && <RestoreDialog busy={busy} close={closeDialog} current={{ projects: state?.projects.length ?? 0, sources: state?.sources.length ?? 0, memories: state?.memories.length ?? 0, tasks: state?.tasks?.length ?? 0, reports: state?.reports?.length ?? 0 }} inspect={async (file) => execute<BackupInspection>('inspect_backup', file as unknown as Record<string, unknown>)} submit={async (file) => {
      await settleDrafts();
      const restored = await run<{ safetyBackupId: string }>('restore', () => execute('restore_backup', { ...file, confirmation: 'RESTORE' }), '工作区已还原，还原前的安全副本已保存。');
      if (restored) { resetDraftVersions(); setLastSafetyBackup(restored.safetyBackupId); setSourceId(null); setMemoryId(null); setSourceDetail(null); setMemoryDetail(null); setSelected(new Set()); setContent(''); setWorkProjectId(''); setFocusTaskId(null); setReloadTick((tick) => tick + 1); closeDialog(); }
    }} notify={(message) => setNotice({ message, error: true })} />}
    {dialog === 'workspace' && <Dialog title="本机工作区" subtitle="项目资料与记忆保存在此设备。" close={closeDialog}><div className="dialog-body workspace-info"><label>数据目录</label><code>{state?.workspace.dataDir}</code><div className="workspace-info-row"><span>数据结构版本</span><strong>{state?.workspace.schemaVersion}</strong></div><div className="workspace-info-row"><span>项目 / 资料 / 记忆</span><strong>{state?.projects.length} / {state?.sources.length} / {state?.memories.length}</strong></div><p>请通过备份中心导出完整副本，搬迁时可从备份恢复。</p></div><div className="dialog-footer"><button className="button primary" onClick={() => { closeDialog(); changePage('backups'); }}>前往备份中心 <ArrowRight size={15} /></button></div></Dialog>}
  </div></WorkspaceDraftContext.Provider>;
}

function ProjectDialog({ busy, close, submit }: { busy: string; close: () => void; submit: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  return <Dialog title="新建项目" subtitle="在同一个项目中管理资料、任务与进展。" close={close} busy={!!busy}><form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void submit(name.trim(), description.trim()); }}><div className="dialog-body"><label className="field-label" htmlFor="project-name">项目名称</label><input id="project-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="例如：客户服务平台一期" autoFocus required disabled={!!busy} /><label className="field-label spaced" htmlFor="project-description">项目说明 <span>可选</span></label><textarea id="project-description" rows={3} value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} placeholder="项目的目标、范围或背景…" disabled={!!busy} /></div><div className="dialog-footer"><button type="button" className="button secondary" onClick={close} disabled={!!busy}>取消</button><button className="button primary" disabled={!name.trim() || !!busy}>{busy === 'project' ? <Spinner /> : <Plus size={15} />}创建项目</button></div></form></Dialog>;
}

function ImportDialog({ busy, close, project, sample, settings, submit, notify, onBatch }: {
  busy: string; close: () => void; onBatch: () => void; project: Project; sample: boolean; settings?: AiSettings;
  submit: (payload: Record<string, unknown>, type: 'text' | 'file') => Promise<void>; notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [title, setTitle] = useState(sample ? SAMPLE.title : '');
  const [text, setText] = useState(sample ? SAMPLE.text : '');
  const [sourceAt, setSourceAt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const submitImport = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'text') {
      if (!title.trim() || !text.trim()) return;
      if (new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) { notify('内容超过 10 MiB，请缩短后再导入。'); return; }
      await submit({ title: title.trim(), text, ...(sourceAt ? { sourceAt } : {}) }, 'text');
    } else if (file) {
      setReading(true);
      try { await submit({ ...await readFile(file), ...(sourceAt ? { sourceAt } : {}) }, 'file'); }
      catch (error) { notify(asError(error).message); }
      finally { setReading(false); }
    }
  };
  return <Dialog title="导入项目资料" subtitle={`资料归属：${project.name}`} close={close} busy={!!busy || reading} wide><form onSubmit={submitImport}><div className="dialog-body"><div className="segmented-control"><button type="button" className={mode === 'text' ? 'selected' : ''} onClick={() => setMode('text')} disabled={!!busy || reading}>粘贴文本</button><button type="button" className={mode === 'file' ? 'selected' : ''} onClick={() => setMode('file')} disabled={!!busy || reading}>选择文件</button><button type="button" disabled={!!busy||reading} onClick={onBatch}>批量导入</button></div>
    {mode === 'text' ? <><label className="field-label" htmlFor="source-title">资料标题</label><input id="source-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} placeholder="例如：10 月项目例会纪要" required disabled={!!busy} /><div className="field-label-row"><label className="field-label" htmlFor="source-text">资料正文</label><button className="text-button tiny" type="button" onClick={() => { setTitle(SAMPLE.title); setText(SAMPLE.text); }} disabled={!!busy}>填入示例文本</button></div><textarea id="source-text" className="import-textarea" rows={10} value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴会议纪要、聊天记录或邮件正文，建议保留日期和发言人。" required disabled={!!busy} /></> : <><label className="file-picker"><div className="file-picker-icon"><FilePlus2 size={26} strokeWidth={1.5} /></div><strong>{file ? file.name : '选择一份项目资料'}</strong><span>{file ? bytes(file.size) : 'TXT、MD、DOCX 或文本 PDF · 最大 10 MiB'}</span><span className="button secondary compact">{file ? '重新选择' : '选择文件'}</span><input type="file" accept=".txt,.md,.docx,.pdf" aria-label="选择项目资料文件" disabled={!!busy || reading} onChange={(event) => { const next = event.target.files?.[0] ?? null; if (next && next.size > 10 * 1024 * 1024) { notify('文件超过 10 MiB，请选择较小的文件。'); event.target.value = ''; setFile(null); } else setFile(next); }} /></label><p className="field-hint">仅支持含文本的 PDF，暂不支持扫描件。</p></>}
    <label className="field-label spaced" htmlFor="source-date">资料日期 <span>可选</span></label><input id="source-date" className="date-input" type="date" value={sourceAt} onChange={(event) => setSourceAt(event.target.value)} disabled={!!busy || reading} /><p className="field-hint">会议或消息的实际日期，用于理解原文中的时间。</p><div className="import-ai-note"><Settings2 size={15} /><p>{settings?.autoExtract && settings.configured && (endpointInfo(settings.baseUrl).local || settings.remoteConsent) ? <>解析完成后，原文将发送至 <strong>{endpointInfo(settings.baseUrl).host}</strong>，使用 {settings.model} 提取待确认候选。</> : settings?.autoExtract ? '自动提取尚未配置就绪。资料仍会正常导入，也可以手动整理。' : '自动提取已关闭。导入后可手动启动提取，或自行整理候选。'}</p></div></div><div className="dialog-footer"><button type="button" className="button secondary" onClick={close} disabled={!!busy || reading}>取消</button><button className="button primary" disabled={!!busy || reading || (mode === 'text' ? !title.trim() || !text.trim() : !file)}>{busy === 'import' || reading ? <Spinner /> : <Upload size={15} />}导入资料</button></div></form></Dialog>;
}

function ReviseDialog({ detail, sources, busy, close, reload, submit, notify }: {
  detail: MemoryDetail; sources: Source[]; busy: string; close: () => void;
  reload: () => Promise<MemoryDetail>; submit: (payload: Record<string, unknown>) => Promise<void>; notify: (message: string) => void;
}) {
  const [baseRevision, setBaseRevision] = useState(detail.memory.revision);
  const [retention, setRetention] = useState(detail.revisions.find((r) => r.number === detail.memory.revision)?.retention ?? defaultRetention);
  const emptyFacets = { entity: '', topic: '', role: '' as '' | 'owner' | 'approver' | 'contact', conditions: [] as string[], validFrom: null as string | null, validUntil: null as string | null };
  const [facets, setFacets] = useState({ ...emptyFacets, ...detail.revisions.find((r) => r.number === detail.memory.revision)?.facets });

  const [content, setContent] = useState(detail.memory.content);
  const [question, setQuestion] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<Set<string>>(new Set());
  const [reloading, setReloading] = useState(false);
  const [evidenceSourceId, setEvidenceSourceId] = useState('');
  const [evidenceSource, setEvidenceSource] = useState<SourceDetail | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const historicalEvidence = [...new Map(detail.revisions.flatMap((revision) => revision.evidence).map((item) => [item.segmentId, item])).values()];
  const available: Evidence[] = evidenceSourceId ? (evidenceSource?.segments.map((segment) => ({ segmentId: segment.id, sourceId: evidenceSource.source.id, sourceTitle: evidenceSource.source.title, locator: segment.locator, text: segment.text })) ?? []) : historicalEvidence;
  useEffect(() => {
    if (!evidenceSourceId) { setEvidenceSource(null); setEvidenceLoading(false); return; }
    let cancelled = false;
    setEvidenceLoading(true); setEvidenceError(''); setEvidenceSource(null);
    execute<SourceDetail>('get_source', { sourceId: evidenceSourceId }).then((result) => { if (!cancelled) setEvidenceSource(result); })
      .catch((error) => { if (!cancelled) setEvidenceError(asError(error).message); })
      .finally(() => { if (!cancelled) setEvidenceLoading(false); });
    return () => { cancelled = true; };
  }, [evidenceSourceId]);
  return <Dialog title="修订项目记忆" subtitle={`基于版本 v${baseRevision} 保存，旧版本会完整保留。`} close={close} busy={!!busy || reloading} wide><form onSubmit={(event) => { event.preventDefault(); if (content.trim() && reason.trim()) void submit({ memoryId: detail.memory.id, baseRevision, retention, content: content.trim(), reason: reason.trim(), question: question.trim(), facets: { ...facets, conditions: facets.conditions.map((c) => c.trim()).filter(Boolean) }, segmentIds: [...evidence] }); }}><div className="dialog-body"><RetentionFields value={retention} onChange={setRetention} disabled={!!busy} /><label className="field-label" htmlFor="revision-content">修订后的内容</label><textarea id="revision-content" rows={5} value={content} maxLength={20000} onChange={(event) => setContent(event.target.value)} required disabled={!!busy} /><label className="field-label spaced" htmlFor="revision-reason">修订理由 <span className="required-label">必填</span></label><textarea id="revision-reason" rows={2} value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么需要改动，例如：根据最新确认调整项目范围。" required disabled={!!busy} />
    <fieldset disabled={!!busy || reloading}><legend>事实适用范围（可选）</legend><p className="field-hint">主体、事项和条件请使用正文原词；不明确时留空。日期仅填写正文明确记录的有效期。</p>
      <label className="field-label" htmlFor="fact-entity">主体 / 系统</label><input id="fact-entity" maxLength={160} value={facets.entity} onChange={(e) => setFacets({ ...facets, entity: e.target.value })} />
      <label className="field-label" htmlFor="fact-topic">具体事项</label><input id="fact-topic" maxLength={160} value={facets.topic} onChange={(e) => setFacets({ ...facets, topic: e.target.value })} />
      <label className="field-label" htmlFor="fact-role">本条记录中的角色</label><select id="fact-role" value={facets.role} onChange={(e) => setFacets({ ...facets, role: e.target.value as typeof facets.role })}><option value="">未明确 / 不适用</option><option value="owner">负责人</option><option value="approver">审批人</option><option value="contact">联系人</option></select>
      <label className="field-label" htmlFor="fact-conditions">适用条件（每行一项）</label><textarea id="fact-conditions" rows={2} value={facets.conditions.join('\n')} onChange={(e) => setFacets({ ...facets, conditions: e.target.value.split('\n') })} />
      <label className="field-label" htmlFor="fact-from">生效日期</label><input id="fact-from" type="date" value={facets.validFrom ?? ''} onChange={(e) => setFacets({ ...facets, validFrom: e.target.value || null })} />
      <label className="field-label" htmlFor="fact-until">失效日期</label><input id="fact-until" type="date" value={facets.validUntil ?? ''} onChange={(e) => setFacets({ ...facets, validUntil: e.target.value || null })} />
    </fieldset>
    <label className="field-label spaced" htmlFor="revision-question">用于检查的问题 <span>可选</span></label><textarea id="revision-question" rows={2} maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={!!busy} placeholder="例如：验收由谁负责？保存后可在记忆中心检查这个问题是否召回当前修订。" />
    <div className="revision-evidence-heading"><h3>本次修订的原文依据</h3><span>可选</span></div><p className="field-hint">只选择仍能支持新内容的原文。不选时，将明确记录为个人修正。</p><label className="sr-only" htmlFor="revision-source">选择修订依据的资料</label><select className="revision-source-select" id="revision-source" value={evidenceSourceId} onChange={(event) => setEvidenceSourceId(event.target.value)} disabled={!!busy}><option value="">历史引用的原文（{historicalEvidence.length} 处）</option>{sources.filter((source) => source.status === 'ready').map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}</select>{evidenceLoading ? <p className="correction-note"><Spinner />正在读取段落…</p> : evidenceError ? <p className="form-error">{evidenceError}</p> : available.length ? <div className="revision-evidence-list">{available.map((item) => <label key={item.segmentId}><input type="checkbox" checked={evidence.has(item.segmentId)} onChange={() => setEvidence((current) => { const next = new Set(current); if (next.has(item.segmentId)) next.delete(item.segmentId); else next.add(item.segmentId); return next; })} disabled={!!busy} /><div><strong>{item.sourceTitle} · {item.locator}</strong><p>{item.text}</p></div></label>)}</div> : <p className="correction-note">这里没有可引用的原文，可从上方选择另一份项目资料。</p>}{evidence.size > 0 && <div className="field-label-row"><span className="field-hint">已选择 {evidence.size} 处依据，可跨资料选择。</span><button className="text-button tiny" type="button" disabled={!!busy} onClick={() => setEvidence(new Set())}>清除已选</button></div>}
    <div className="revision-version-check"><span>保存前会校验版本，防止覆盖其他修订。</span><button className="text-button tiny" type="button" disabled={!!busy || reloading} onClick={async () => { setReloading(true); try { const next = await reload(); setBaseRevision(next.memory.revision); setRetention(next.revisions.find((r) => r.number === next.memory.revision)?.retention ?? defaultRetention); setContent(next.memory.content); setFacets({ ...emptyFacets, ...next.revisions.find((r) => r.number === next.memory.revision)?.facets }); setEvidence(new Set()); } catch (error) { notify(asError(error).message); } finally { setReloading(false); } }}>{reloading ? '正在载入…' : '重新载入最新内容'}</button></div></div><div className="dialog-footer"><span className="footer-note">{evidence.size ? `${evidence.size} 处原文依据` : '个人修正 · 未引用原文'}</span><button type="button" className="button secondary" onClick={close} disabled={!!busy || reloading}>取消</button><button className="button primary" disabled={!!busy || reloading || !content.trim() || !reason.trim()}>{busy === 'revise' ? <Spinner /> : <Check size={15} />}保存修订</button></div></form></Dialog>;
}

function RestoreDialog({ busy, close, current, inspect, submit, notify }: {
  busy: string; close: () => void; current: { projects: number; sources: number; memories: number; tasks: number; reports: number };
  inspect: (file: FileInput) => Promise<BackupInspection>; submit: (file: FileInput) => Promise<void>; notify: (message: string) => void;
}) {
  const [password,setPassword]=useState('');
  const [selectedBackup,setSelectedBackup]=useState<File|undefined>();
  const [file, setFile] = useState<FileInput | null>(null);
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const inspectFile = async (selectedFile: File | undefined) => {
    const request = ++sequence.current;
    setFile(null); setInspection(null); setConfirmed(false); setError('');
    if (!selectedFile) return;
    setInspecting(true);
    try {
      const input = { ...await readFile(selectedFile, 256), ...(selectedFile.name.endsWith('.pabackup')?{password}:{}) };
      const checked = await inspect(input);
      if (request !== sequence.current) return;
      setFile(input); setInspection(checked);
      if (!checked.compatible) setError('这份备份与当前应用不兼容，无法还原。');
    } catch (caught) { if (request === sequence.current) setError(asError(caught).message); }
    finally { if (request === sequence.current) setInspecting(false); }
  };
  return <Dialog title="从备份恢复" subtitle="检查备份后，再确认替换当前工作区。" close={close} busy={!!busy || inspecting} wide><div className="dialog-body"><label className="file-picker backup-file-picker"><Archive size={27} strokeWidth={1.4} /><strong>{file?.filename ?? '选择工作区备份 ZIP'}</strong><span>{inspecting ? '正在检查完整性与兼容性…' : '最大 256 MiB · 不会在选择后立即还原'}</span><span className="button secondary compact">{inspecting ? <Spinner /> : <Upload size={14} />}{file ? '更换备份' : '选择备份文件'}</span><input type="file" accept=".zip,.pabackup" aria-label="选择备份ZIP文件" disabled={!!busy || inspecting} onChange={(event) => { const selected=event.target.files?.[0];setSelectedBackup(selected);setFile(null);setInspection(null);setConfirmed(false);if(!selected?.name.endsWith('.pabackup'))void inspectFile(selected); }} /></label>
    {selectedBackup?.name.endsWith('.pabackup')&&<div><label className="field-label">备份密码<input type="password" autoComplete="off" value={password} disabled={!!busy||inspecting} onChange={e=>{setPassword(e.target.value);setInspection(null);setConfirmed(false);}}/></label><button className="button secondary" disabled={!!busy||inspecting||password.length<12} onClick={()=>void inspectFile(selectedBackup)}>解密并检查</button></div>}
    {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
    {inspection && inspection.compatible && <><div className="inspection-success"><ShieldCheck size={17} /><span>备份检查通过</span><span>{date(inspection.createdAt, true)}</span></div><table className="restore-counts"><thead><tr><th>工作区内容</th><th>当前</th><th>备份中</th></tr></thead><tbody><tr><td>项目</td><td>{current.projects}</td><td>{inspection.counts.projects}</td></tr><tr><td>原始资料</td><td>{current.sources}</td><td>{inspection.counts.sources}</td></tr><tr><td>已确认记忆</td><td>{current.memories}</td><td>{inspection.counts.memories}</td></tr><tr><td>任务</td><td>{current.tasks}</td><td>{inspection.counts.tasks ?? 0}</td></tr><tr><td>日报版本</td><td>{current.reports}</td><td>{inspection.counts.reports ?? 0}</td></tr></tbody></table><div className="restore-warning"><ShieldCheck size={18} /><p>还原会替换当前全部项目、资料、记忆、任务与日报。应用会先自动创建当前工作区的安全副本。</p></div><label className="restore-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!!busy} /><span>我已核对备份，确认用它还原当前工作区</span></label></>}
    </div><div className="dialog-footer"><button className="button secondary" onClick={close} disabled={!!busy || inspecting}>取消</button><button className="button primary" disabled={!!busy || inspecting || !file || !inspection?.compatible || !confirmed} onClick={() => { if (file) void submit(file).catch((caught) => notify(asError(caught).message)); }}>{busy === 'restore' ? <Spinner /> : <History size={15} />}确认还原工作区</button></div></Dialog>;
}
