import type { ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.generated.js';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

// Both generations of UI use the Ledger tokens in astryx.css, including portals.
export function UiProvider({ children }: { children: ReactNode }) {
  return <Theme theme={neutralTheme} mode="system">
    <InternationalizationProvider locale="zh-CN" messages={{ 'zh-CN': zhCN }}>
      {children}
    </InternationalizationProvider>
  </Theme>;
}
