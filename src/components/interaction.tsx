import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Check, ChevronRight, CircleAlert, X } from 'lucide-react';
import { EASING, MOTION, prefersReducedMotion } from '../design/motion';
import { Spinner } from './ui';

export function usePresence(open: boolean, exitDuration: number = MOTION.exit) {
  const [mounted, setMounted] = useState(open);
  const [active, setActive] = useState(open);
  const mountedRef = useRef(open);
  mountedRef.current = mounted;

  useEffect(() => {
    const reduced = prefersReducedMotion();
    if (open) {
      mountedRef.current = true;
      setMounted(true);
      if (reduced) {
        setActive(true);
        return;
      }
      let raf1 = 0;
      let raf2 = 0;
      raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => setActive(true));
      });
      return () => {
        if (raf1) window.cancelAnimationFrame(raf1);
        if (raf2) window.cancelAnimationFrame(raf2);
      };
    }

    setActive(false);
    if (!mountedRef.current) return;
    if (reduced || exitDuration <= 0) {
      mountedRef.current = false;
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
    }, exitDuration);
    return () => window.clearTimeout(timer);
  }, [open, exitDuration]);

  return {
    mounted: open || mounted,
    active: open ? active : false,
    exiting: !open && mounted,
  };
}

export function AnimatedCollapse({
  open,
  children,
  className = '',
  unmountOnExit = true,
  id,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  unmountOnExit?: boolean;
  id?: string;
}) {
  const presence = usePresence(open, MOTION.collapse);
  const shouldRender = unmountOnExit ? presence.mounted : true;
  if (!shouldRender) return null;

  return (
    <div
      id={id}
      className={`animated-collapse ${presence.active ? 'is-active' : ''} ${className}`.trim()}
      aria-hidden={!open || undefined}
    >
      <div className="animated-collapse-inner">{children}</div>
    </div>
  );
}

export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeSelector: string,
  deps: readonly unknown[] = [],
) {
  const readyRef = useRef(false);
  const rafRef = useRef(0);

  const update = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(activeSelector);
    if (!active) {
      readyRef.current = false;
      delete container.dataset.indicatorActive;
      container.dataset.indicatorReady = 'false';
      return;
    }

    const x = active.offsetLeft;
    const y = active.offsetTop;
    const w = active.offsetWidth;
    const h = active.offsetHeight;

    container.style.setProperty('--ind-x', `${x}px`);
    container.style.setProperty('--ind-y', `${y}px`);
    container.style.setProperty('--ind-w', `${w}px`);
    container.style.setProperty('--ind-h', `${h}px`);
    container.dataset.indicatorActive = 'true';

    if (!readyRef.current) {
      readyRef.current = true;
      container.dataset.indicatorReady = 'false';
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        if (containerRef.current) {
          containerRef.current.dataset.indicatorReady = 'true';
        }
      });
    }
  }, [containerRef, activeSelector]);

  useEffect(() => () => {
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
  }, []);

  useLayoutEffect(() => {
    update();
  }, [update, ...deps]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update());
    observer.observe(container);
    const active = container.querySelector<HTMLElement>(activeSelector);
    if (active) observer.observe(active);
    return () => observer.disconnect();
  }, [containerRef, activeSelector, update, ...deps]);
}

export function useScrollFade(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
) {
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 2) {
      el.dataset.fadeLeft = 'false';
      el.dataset.fadeRight = 'false';
      return;
    }
    el.dataset.fadeLeft = el.scrollLeft > 4 ? 'true' : 'false';
    el.dataset.fadeRight = el.scrollLeft < overflow - 4 ? 'true' : 'false';
  }, [ref]);

  useLayoutEffect(() => {
    sync();
  }, [sync, ...deps]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', sync, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => sync());
      observer.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', sync);
      observer?.disconnect();
    };
  }, [ref, sync, ...deps]);
}

export function CountPulse({
  value,
  display,
  className = '',
}: {
  value: number;
  display?: string | number;
  className?: string;
}) {
  const prevRef = useRef<number>(value);
  const [pulse, setPulse] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (prevRef.current === value) return;
    const dir = value > prevRef.current ? 'up' : 'down';
    prevRef.current = value;
    if (prefersReducedMotion()) return;
    setPulse(null);
    const raf = window.requestAnimationFrame(() => setPulse(dir));
    return () => window.cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span
      className={`count-pulse ${pulse ? `is-${pulse}` : ''} ${className}`.trim()}
      onAnimationEnd={() => setPulse(null)}
    >
      {display ?? value}
    </span>
  );
}

export function useCopyFeedback(resetMs: number = MOTION.copyReset) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const markCopied = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = window.setTimeout(() => setCopied(false), resetMs);
  }, [resetMs]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { copied, markCopied };
}

export function useStampCollapse() {
  const [phase, setPhase] = useState<'idle' | 'done' | 'dismiss' | 'collapsing'>('idle');
  const aliveRef = useRef(true);
  const settlingRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    };
  }, []);

  const wait = (ms: number) =>
    new Promise<void>(resolve => {
      const id = window.setTimeout(resolve, ms);
      timersRef.current.push(id);
    });

  const settle = useCallback(async (kind: 'done' | 'dismiss', after: () => Promise<void> | void) => {
    if (settlingRef.current) return;
    settlingRef.current = true;
    try {
      if (!prefersReducedMotion()) {
        setPhase(kind);
        await wait(MOTION.stampHold);
        if (!aliveRef.current) return;
        setPhase('collapsing');
        await wait(MOTION.collapse);
        if (!aliveRef.current) return;
      }
      await after();
    } finally {
      settlingRef.current = false;
      if (aliveRef.current) setPhase('idle');
    }
  }, []);

  return {
    phase,
    settling: phase !== 'idle',
    settle,
    wrapperClass: phase === 'collapsing' ? 'stream-card-collapse is-collapsing' : 'stream-card-collapse',
    cardClass: phase === 'done' ? 'is-settling-done' : phase === 'dismiss' ? 'is-settling-dismiss' : '',
  };
}

export function useSwipeDismiss({
  ref,
  open,
  enabled,
  direction,
  onClose,
  scrimSelector,
}: {
  ref: RefObject<HTMLElement | null>;
  open: boolean;
  enabled: boolean;
  direction: 'left' | 'right';
  onClose: () => void;
  scrimSelector?: string;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node || !open || !enabled) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let swiping = false;
    let lastDelta = 0;

    const getScrim = () =>
      scrimSelector ? document.querySelector<HTMLElement>(scrimSelector) : null;

    const resetVisuals = () => {
      node.classList.remove('is-swiping');
      node.style.transform = '';
      const scrim = getScrim();
      if (scrim) scrim.style.removeProperty('--swipe-opacity');
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startTime = performance.now();
      swiping = false;
      lastDelta = 0;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (!swiping) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.3) {
          pointerId = null;
          return;
        }
        const wrongWay = direction === 'left' ? dx > 0 : dx < 0;
        if (wrongWay) {
          pointerId = null;
          return;
        }
        swiping = true;
        node.classList.add('is-swiping');
        try {
          node.setPointerCapture(event.pointerId);
        } catch {
          // ignore pointer capture failure
        }
      }

      const clamped = direction === 'left' ? Math.min(0, dx) : Math.max(0, dx);
      lastDelta = clamped;
      node.style.transform = `translate3d(${clamped}px, 0, 0)`;

      const width = Math.max(1, node.offsetWidth || 300);
      const progress = Math.max(0, Math.min(1, 1 - Math.abs(clamped) / width));
      const scrim = getScrim();
      if (scrim) scrim.style.setProperty('--swipe-opacity', String(progress));
    };

    const finish = (event: PointerEvent, cancelled = false) => {
      if (event.pointerId !== pointerId) return;
      const wasSwiping = swiping;
      const delta = lastDelta;
      const elapsed = Math.max(1, performance.now() - startTime);
      pointerId = null;
      swiping = false;
      lastDelta = 0;
      resetVisuals();

      if (!wasSwiping || cancelled) return;
      const width = Math.max(1, node.offsetWidth || 300);
      const velocity = Math.abs(delta) / elapsed;
      if (Math.abs(delta) > width * 0.28 || velocity > 0.45) {
        onCloseRef.current();
      }
    };

    const onPointerUp = (e: PointerEvent) => finish(e, false);
    const onPointerCancel = (e: PointerEvent) => finish(e, true);

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCancel);
    return () => {
      resetVisuals();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [ref, open, enabled, direction, scrimSelector]);
}

export function usePageMotion(
  ref: RefObject<HTMLDivElement | null>,
  key: string,
  direction: -1 | 0 | 1 = 0,
) {
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    const node = ref.current;
    if (!node || prefersReducedMotion()) return;
    const keyframes =
      direction !== 0
        ? [
            { opacity: 0.84, transform: `translate3d(${direction * 6}px, 0, 0)` },
            { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          ]
        : [
            { opacity: 0.82, transform: 'translate3d(0, 3px, 0)' },
            { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          ];
    const animation = node.animate(keyframes, {
      duration: MOTION.fast,
      easing: EASING.out,
    });
    return () => animation.cancel();
  }, [key, direction, ref]);
}

export function PageLoading({ label = '正在读取工作区' }: { label?: string }) {
  return (
    <div className="page-skeleton" role="status" aria-label={label}>
      <span className="page-skeleton-title" />
      <span className="page-skeleton-summary" />
      <div>
        {[0, 1, 2].map(row => (
          <span className="page-skeleton-row" key={row}>
            <i />
            <span>
              <b />
              <b />
            </span>
            <ChevronRight size={16} />
          </span>
        ))}
      </div>
      <span className="visually-hidden">{label}…</span>
    </div>
  );
}

export type ToastAction = { label: string; onClick: () => void | Promise<void> };
export type ToastNotice = { id?: number; message: string; error?: boolean; action?: ToastAction };

export function FeedbackToast({ notice, onClose }: { notice: ToastNotice; onClose: () => void }) {
  const [exiting, setExiting] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [actionBusy, setActionBusy] = useState(false);
  const paused = hovered || focused || hidden || actionBusy;
  const duration = notice.action ? 7500 : 4500;
  const remaining = useRef(duration);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const latestNotice = useRef(notice);
  latestNotice.current = notice;
  const firstNoticeRef = useRef(true);
  const timer = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current);
    setExiting(true);
  }, []);

  useEffect(() => {
    window.clearTimeout(timer.current);
    setExiting(false);
    setActionBusy(false);
    remaining.current = notice.action ? 7500 : 4500;
    if (firstNoticeRef.current) {
      firstNoticeRef.current = false;
      return;
    }
    if (!prefersReducedMotion()) {
      setUpdated(false);
      const raf = window.requestAnimationFrame(() => setUpdated(true));
      return () => window.cancelAnimationFrame(raf);
    }
  }, [notice]);

  useEffect(() => {
    if (paused && exiting) {
      setExiting(false);
    }
  }, [paused, exiting]);

  useEffect(() => {
    if (!exiting) return;
    const id = window.setTimeout(
      () => closeRef.current(),
      prefersReducedMotion() ? 0 : MOTION.exit,
    );
    return () => window.clearTimeout(id);
  }, [exiting]);

  useEffect(() => {
    if (notice.error || paused || exiting) return;
    const started = Date.now();
    const wait = Math.max(remaining.current, 1500);
    timer.current = window.setTimeout(dismiss, wait);
    return () => {
      window.clearTimeout(timer.current);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [notice, paused, exiting, dismiss]);

  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);

  const runAction = async () => {
    const action = notice.action;
    if (!action || actionBusy) return;
    const currentNotice = notice;
    setActionBusy(true);
    try {
      await action.onClick();
      if (latestNotice.current === currentNotice) dismiss();
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div
      className={`toast feedback-toast ${notice.error ? 'toast-error' : ''} ${exiting ? 'is-leaving' : ''} ${updated ? 'is-updated' : ''}`}
      role={notice.error ? 'alert' : 'status'}
      aria-atomic="true"
      onAnimationEnd={event => {
        if (event.animationName === 'workspace-toast-pulse') setUpdated(false);
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <span className="feedback-toast-icon" aria-hidden="true">
        {notice.error ? <CircleAlert size={20} /> : <Check size={20} />}
      </span>
      <div className="feedback-toast-body">
        {notice.error && <strong>操作未完成</strong>}
        <p>{notice.message}</p>
      </div>
      {notice.action && (
        <button
          type="button"
          className="button secondary compact feedback-toast-action"
          disabled={actionBusy}
          onClick={() => void runAction()}
        >
          {actionBusy ? <Spinner /> : null}
          {notice.action.label}
        </button>
      )}
      <button className="icon-button small" aria-label="关闭通知" onClick={dismiss}>
        <X size={16} />
      </button>
    </div>
  );
}
