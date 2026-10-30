import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, X } from 'lucide-react';

export function Spinner() { return <LoaderCircle size={15} className="spinner" aria-hidden="true" />; }

// Reference counts keep the underlying workspace inert when dialogs are nested.
const dialogLocks = new Map<HTMLElement, { count: number; previous: boolean }>();
let scrollLocks = 0;
let previousOverflow = '';

export function useModalLayer(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const layer = ref.current;
    if (!active || !layer) return;
    const siblings = Array.from(layer.parentElement?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer && !element.matches('.toast, .nav-scrim'));
    for (const element of siblings) {
      const lock = dialogLocks.get(element) ?? { count: 0, previous: element.inert };
      lock.count += 1; dialogLocks.set(element, lock); element.inert = true;
    }
    if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    return () => {
      for (const element of siblings) {
        const lock = dialogLocks.get(element);
        if (lock && --lock.count === 0) { element.inert = lock.previous; dialogLocks.delete(element); }
      }
      if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
    };
  }, [ref, active]);
}

export function Dialog({ title, subtitle, children, close, busy, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; close: () => void; busy?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const backdropPressed = useRef(false);
  const closing = useRef(false);
  const [exiting, setExiting] = useState(false);
  const latest = useRef({ busy, close });
  latest.current = { busy, close };
  const id = useId();
  const titleId = `${id}-title`;
  const subtitleId = `${id}-subtitle`;
  useModalLayer(overlay);
  const requestClose = useCallback(() => {
    if (latest.current.busy || closing.current) return;
    closing.current = true;
    setExiting(true);
  }, []);
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => latest.current.close(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150);
    return () => window.clearTimeout(timer);
  }, [exiting]);
  useEffect(() => {
    const previous = returnFocus.current;
    const node = ref.current;
    if (!node) return;
    const getFocusableElements = () => Array.from(node.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex], [contenteditable="true"]')).filter((element) => {
      const visibility = window.getComputedStyle(element).visibility;
      return element.tabIndex >= 0
        && !element.matches(':disabled, input[type="hidden"]')
        && !element.closest('[hidden], [inert], [aria-hidden="true"]')
        && element.getClientRects().length > 0
        && visibility !== 'hidden'
        && visibility !== 'collapse';
    });
    const elements = getFocusableElements();
    const initial = elements.find((element) => element.matches('input:not([type="file"]), textarea, select')) ?? elements[0] ?? node;
    initial.focus({ preventScroll: true });
    const handler = (event: KeyboardEvent) => {
      // Only the front dialog handles Escape and traps focus when help or a
      // result form is opened inside an existing task dialog.
      if (Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1) !== node) return;
      if (event.key === 'Escape') {
        if (!latest.current.busy) {
          event.preventDefault();
          requestClose();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = getFocusableElements();
      if (!elements.length) { event.preventDefault(); node.focus(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      const currentIndex = elements.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) { last.focus(); event.preventDefault(); }
      if (!event.shiftKey && (currentIndex === -1 || document.activeElement === last)) { first.focus(); event.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('.water-menu-trigger')?.focus({ preventScroll: true });
    };
  }, [requestClose]);
  return createPortal(<div className={`dialog-overlay ${exiting ? 'is-leaving' : ''}`} ref={overlay} onPointerDown={event => { backdropPressed.current = event.target === event.currentTarget; }} onPointerUp={event => { if (backdropPressed.current && event.target === event.currentTarget) requestClose(); backdropPressed.current = false; }} onPointerCancel={() => { backdropPressed.current = false; }}><div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} aria-busy={Boolean(busy)} tabIndex={-1} ref={ref}>
    <div className="dialog-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}{busy && <span className="dialog-busy" role="status"><Spinner />正在处理，请稍候…</span>}</div><button className="icon-button" aria-label="关闭对话框" onClick={requestClose} disabled={busy || exiting}><X size={19} /></button></div>
    {children}
  </div></div>, document.querySelector('.app-shell') ?? document.body);
}
