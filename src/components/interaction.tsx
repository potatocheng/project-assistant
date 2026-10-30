import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Bell, CalendarDays, Check, CheckCheck, ChevronRight, CircleAlert, ClipboardList, LayoutGrid, ListTodo, MessageCircle, Radar, X } from 'lucide-react';
import type { Page } from '../types';

export function usePresence(open: boolean, duration = 160) {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration);
    return () => window.clearTimeout(timer);
  }, [open, present, duration]);
  return { mounted: open || present, exiting: !open && present };
}

const workLinks = [
  { page: 'workbench', label: '今日概览', icon: LayoutGrid },
  { page: 'proactive', label: '待处理行动', icon: Radar },
  { page: 'chat-replies', label: '聊天回复', icon: MessageCircle },
  { page: 'daily', label: '每日清单', icon: CalendarDays },
  { page: 'tasks', label: '全部任务', icon: ListTodo },
  { page: 'followups', label: '提醒与跟进', icon: Bell },
  { page: 'assistant', label: '项目问答', icon: MessageCircle },
  { page: 'reports', label: '工作日报', icon: ClipboardList },
  { page: 'inbox', label: '待处理', icon: CheckCheck },
] as const;
const projectLinks = [
  { page: 'overview', label: '项目总览' },
  { page: 'governance', label: '风险与决策' },
  { page: 'changes', label: '变更与验收' },
  { page: 'coordination', label: '周报与会议' },
] as const;

export function WorkspaceNav({ page, onNavigate, pendingCount = 0 }: { page: Page; onNavigate: (page: Page) => void; pendingCount?: number }) {
  const ref = useRef<HTMLElement>(null);
  const isProject = projectLinks.some(link => link.page === page);
  const isWork = workLinks.some(link => link.page === page);
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const selected = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!selected) return;
    const update = () => {
      nav.style.setProperty('--nav-x', `${selected.offsetLeft}px`);
      nav.style.setProperty('--nav-width', `${selected.offsetWidth}`);
    };
    update();
    // Reveal the current destination inside the strip without scrolling the page.
    const left = selected.offsetLeft - nav.clientWidth / 2 + selected.offsetWidth / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [page]);
  if (!isWork && !isProject) return null;
  return <nav className="workspace-nav" aria-label={isProject ? '项目功能' : '日常工作'} ref={ref}>
    <span className="workspace-nav-indicator" aria-hidden="true" />
    {isProject ? projectLinks.map(link => <button key={link.page} aria-current={page === link.page ? 'page' : undefined} onClick={() => onNavigate(link.page)}>{link.label}</button>)
      : workLinks.map(({ page: destination, label, icon: Icon }) => <button key={destination} aria-current={page === destination ? 'page' : undefined} onClick={() => onNavigate(destination)}><Icon size={15} /><span>{label}</span>{destination === 'inbox' && pendingCount > 0 && <small>{pendingCount > 99 ? '99+' : pendingCount}</small>}</button>)}
  </nav>;
}

export function usePageMotion(ref: RefObject<HTMLDivElement | null>, page: Page) {
  const previous = useRef(page);
  useLayoutEffect(() => {
    if (previous.current === page) return;
    previous.current = page;
    const node = ref.current;
    if (!node || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = node.animate([{ opacity: .65, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    return () => animation.cancel();
  }, [page, ref]);
}

export function PageLoading({ label = '正在读取工作区' }: { label?: string }) {
  return <div className="page-skeleton" role="status" aria-label={label}>
    <span className="page-skeleton-title" /><span className="page-skeleton-summary" />
    <div>{[0, 1, 2].map(row => <span className="page-skeleton-row" key={row}><i /><span><b /><b /></span><ChevronRight size={16} /></span>)}</div>
    <span className="visually-hidden">{label}…</span>
  </div>;
}

export function FeedbackToast({ notice, onClose }: { notice: { message: string; error?: boolean }; onClose: () => void }) {
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const paused = hovered || focused || hidden;
  const remaining = useRef(5500);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const timer = useRef<number | undefined>(undefined);
  const dismiss = () => {
    window.clearTimeout(timer.current);
    setExiting(true);
  };
  useEffect(() => {
    setExiting(false);
    remaining.current = 5500;
  }, [notice]);
  useEffect(() => {
    if (!exiting) return;
    const id = window.setTimeout(() => closeRef.current(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140);
    return () => window.clearTimeout(id);
  }, [exiting]);
  useEffect(() => {
    if (notice.error || paused || exiting) return;
    const started = Date.now();
    timer.current = window.setTimeout(dismiss, remaining.current);
    return () => { window.clearTimeout(timer.current); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [notice, paused, exiting]);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return <div className={`toast feedback-toast ${notice.error ? 'toast-error' : ''} ${exiting ? 'is-leaving' : ''}`} role={notice.error ? 'alert' : 'status'} aria-atomic="true" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="feedback-toast-icon" aria-hidden="true">{notice.error ? <CircleAlert size={20} /> : <Check size={20} />}</span>
    <div><strong>{notice.error ? '操作需要关注' : '操作完成'}</strong><p>{notice.message}</p></div>
    <button className="icon-button small" aria-label="关闭通知" onClick={dismiss}><X size={16} /></button>
  </div>;
}
