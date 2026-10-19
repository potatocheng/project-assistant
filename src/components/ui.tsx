import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';

export function Spinner() { return <LoaderCircle size={15} className="spinner" aria-hidden="true" />; }

export function Dialog({ title, subtitle, children, close, busy, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; close: () => void; busy?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('input:not([type="file"]):not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close();
      if (event.key !== 'Tab' || !node) return;
      const elements = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((element) => element.offsetParent !== null);
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
      if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [busy, close]);
  return <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}><div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
    <div className="dialog-header"><div><h2 id="dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={close} disabled={busy}><X size={19} /></button></div>
    {children}
  </div></div>;
}
