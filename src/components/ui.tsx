import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';

export function Spinner() { return <LoaderCircle size={15} className="spinner" aria-hidden="true" />; }

export function Dialog({ title, subtitle, children, close, busy, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; close: () => void; busy?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ busy, close });
  latest.current = { busy, close };
  const id = useId();
  const titleId = `${id}-title`;
  const subtitleId = `${id}-subtitle`;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
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
      if (event.key === 'Escape') {
        if (!latest.current.busy) {
          event.preventDefault();
          latest.current.close();
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
    return () => { document.removeEventListener('keydown', handler); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}><div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} aria-busy={Boolean(busy)} tabIndex={-1} ref={ref}>
    <div className="dialog-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={close} disabled={busy}><X size={19} /></button></div>
    {children}
  </div></div>;
}
