import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.generated.js';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'pa:theme';

function readStoredThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // ignore storage errors
  }
  return 'system';
}

function applyThemeToDocument(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  if (mode === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }
}

const ThemeModeContext = createContext<{
  themeMode: ThemeMode;
  setThemeMode: (next: ThemeMode) => void;
}>({
  themeMode: 'system',
  setThemeMode: () => {},
});

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

// Both generations of UI use the Ledger tokens in astryx.css, including portals.
export function UiProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredThemeMode);
  const mountedRef = useRef(false);

  useEffect(() => {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    let raf1 = 0;
    let raf2 = 0;
    if (root && mountedRef.current) {
      root.classList.add('theme-switching');
      applyThemeToDocument(themeMode);
      // Force synchronous style recalc so surfaces and controls switch on the exact same frame.
      void root.offsetHeight;
      raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => {
          root.classList.remove('theme-switching');
        });
      });
    } else {
      mountedRef.current = true;
      applyThemeToDocument(themeMode);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // ignore storage errors
    }
    return () => {
      if (raf1) window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      root?.classList.remove('theme-switching');
    };
  }, [themeMode]);

  return (
    <ThemeModeContext.Provider value={{ themeMode, setThemeMode: setThemeModeState }}>
      <Theme theme={neutralTheme} mode={themeMode}>
        <InternationalizationProvider locale="zh-CN" messages={{ 'zh-CN': zhCN }}>
          {children}
        </InternationalizationProvider>
      </Theme>
    </ThemeModeContext.Provider>
  );
}
