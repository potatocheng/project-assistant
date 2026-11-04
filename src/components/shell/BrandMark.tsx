/** Ledger mark: an ink page with ruled entries; the accent tick is the one confirmed line. */
export function BrandMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  return <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
    <path d="M7 8.5h10M7 12h10M7 15.5h5" stroke="var(--bg-surface)" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="16.5" cy="15.5" r="1.9" fill="var(--accent)" />
  </svg>;
}
