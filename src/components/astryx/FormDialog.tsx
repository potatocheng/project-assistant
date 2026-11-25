import type { ReactNode } from 'react';
import { Dialog } from '../ui';

// Delegate outer shell to Ledger Dialog so focus trapping, dirty-close guard,
// and Toast visibility (avoiding native <dialog> top-layer occlusion) stay consistent.
export function FormDialog({ title, subtitle, children, close, busy = false, wide = false, dirty = false }: {
  title: string; subtitle?: string; children: ReactNode; close: () => void; busy?: boolean; wide?: boolean; dirty?: boolean;
}) {
  return (
    <Dialog title={title} subtitle={subtitle} close={close} busy={busy} wide={wide} dirty={dirty}>
      {children}
    </Dialog>
  );
}
