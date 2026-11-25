import { useId } from 'react';

/** Cadence (循序) brand mark: stepped timeline bars in deep ink anchored by a vermilion seal beacon. */
export function BrandMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const bgId = `cadence-bg-${uid}`;
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={bgId} x1="2" y1="1" x2="22" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#232d39" />
          <stop offset="100%" stopColor="#151b23" />
        </linearGradient>
      </defs>
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${bgId})`} stroke="#ffffff" strokeOpacity="0.12" strokeWidth="0.75" />
      <line x1="8.2" y1="3.6" x2="8.2" y2="20.4" stroke="#e9ecee" strokeOpacity="0.35" strokeWidth="0.75" />
      <rect x="5.5" y="6" width="8" height="2.4" rx="1.2" fill="#F4F6F7" />
      <rect x="7" y="10.8" width="12" height="2.4" rx="1.2" fill="#F4F6F7" />
      <rect x="11.4" y="15.6" width="7.6" height="2.4" rx="1.2" fill="#F4F6F7" />
      <circle cx="8.2" cy="12" r="2.1" fill="#C23A22" />
      <path d="M8.2 10.75L8.55 11.65L9.45 12L8.55 12.35L8.2 13.25L7.85 12.35L6.95 12L7.85 11.65Z" fill="#FFFFFF" />
    </svg>
  );
}
