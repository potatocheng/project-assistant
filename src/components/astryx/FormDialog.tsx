import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Button } from '@astryxdesign/core/Button';
import { X } from 'lucide-react';
import { Spinner } from '../ui';

// Opt-in adapter: legacy dialogs keep their nested help/result flows for now.
export function FormDialog({ title, subtitle, children, close, busy = false, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; close: () => void; busy?: boolean; wide?: boolean;
}) {
  const id = useId();
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => () => {
    // A conditionally mounted native dialog may be removed before its own
    // focus-return cleanup runs. Wait until all removal effects have settled.
    queueMicrotask(() => {
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const target = opener.current;
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.sidebar-link[aria-current="page"]')?.focus({ preventScroll: true });
    });
  }, []);
  const dismiss = () => { if (!busy) close(); };
  return <Dialog isOpen onOpenChange={open => { if (!open) dismiss(); }}
    purpose="info" width={wide ? 720 : 520}
    maxHeight="calc(100dvh - 32px)" padding={0} className="astryx-form-dialog"
    aria-labelledby={`${id}-title`} aria-describedby={subtitle ? `${id}-subtitle` : undefined}
    aria-busy={busy}>
    <div className="astryx-form-header">
      <div><h2 id={`${id}-title`} tabIndex={-1} data-autofocus="dialog-title">{title}</h2>
        {subtitle && <p id={`${id}-subtitle`}>{subtitle}</p>}
        {busy && <span className="dialog-busy" role="status"><Spinner />正在处理，请稍候…</span>}
      </div>
      <Button label="关闭对话框" icon={<X size={19} />} isIconOnly variant="ghost"
        isDisabled={busy} onClick={dismiss} />
    </div>
    {children}
  </Dialog>;
}
