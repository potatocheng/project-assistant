import { useId } from 'react';

/** The open current is shared by the brand, focus state and assistant entry. */
export function WaterMark({ className = '', size = 36 }: { className?: string; size?: number }) {
  const gradient = useId().replace(/:/g, '');
  return <svg className={`water-mark ${className}`} width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <defs><linearGradient id={gradient} x1="9" y1="34" x2="31" y2="5" gradientUnits="userSpaceOnUse"><stop stopColor="#9FDFFF"/><stop offset=".5" stopColor="#329BFF"/><stop offset="1" stopColor="#0879F5"/></linearGradient></defs>
    <g className="water-current" stroke={`url(#${gradient})`} strokeWidth="7" strokeLinecap="round">
      <path d="M12 29a12 12 0 0 1 2-20"/>
      <path d="M20 8a12 12 0 0 1 12 14"/>
      <path d="M28 29a12 12 0 0 1-11 3"/>
    </g>
    <circle cx="20" cy="20" r="4.5" fill="#1688F8"/>
    <circle className="water-drop" cx="34" cy="5" r="3" fill="#68BAFF"/>
  </svg>;
}
