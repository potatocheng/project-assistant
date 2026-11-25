export const MOTION = {
  instant: 90,
  fast: 140,
  base: 200,
  slow: 260,
  exit: 140,
  stampHold: 140,
  collapse: 180,
  refreshMin: 450,
  copyReset: 1400,
} as const;

export const EASING = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  stamp: 'cubic-bezier(0.2, 0.85, 0.25, 1)',
} as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export function shortcutLabel(key: string): string {
  const upper = key.toUpperCase();
  return isMacPlatform ? `⌘${upper}` : `Ctrl ${upper}`;
}
