import type { ReactNode } from 'react';

/**
 * Hand-authored flat flags for the 15 nationality codes
 * `PlayerGenerationPolicy.NATIONALITIES` can produce (packages/domain).
 * 16×12 inline SVG, no sprite and no dependency; an unmapped code falls
 * back to the mono `gc-flcode` chip so nothing ever renders blank.
 */
const FLAGS: Record<string, ReactNode> = {
  // Brazil — green field, yellow diamond, blue globe.
  BR: (
    <>
      <rect width="16" height="12" fill="#009C3B" />
      <path d="M8 1.6 14.6 6 8 10.4 1.4 6 8 1.6Z" fill="#FFDF00" />
      <circle cx="8" cy="6" r="2.3" fill="#002776" />
    </>
  ),
  // United States — 13 stripes + canton.
  US: (
    <>
      <rect width="16" height="12" fill="#FFFFFF" />
      <rect width="16" height="0.92" y="0" fill="#B22234" />
      <rect width="16" height="0.92" y="1.85" fill="#B22234" />
      <rect width="16" height="0.92" y="3.69" fill="#B22234" />
      <rect width="16" height="0.92" y="5.54" fill="#B22234" />
      <rect width="16" height="0.92" y="7.38" fill="#B22234" />
      <rect width="16" height="0.92" y="9.23" fill="#B22234" />
      <rect width="16" height="0.92" y="11.08" fill="#B22234" />
      <rect width="7" height="6.46" fill="#3C3B6E" />
      <circle cx="1.4" cy="1.2" r="0.45" fill="#FFFFFF" />
      <circle cx="3.5" cy="1.2" r="0.45" fill="#FFFFFF" />
      <circle cx="5.6" cy="1.2" r="0.45" fill="#FFFFFF" />
      <circle cx="2.4" cy="3.2" r="0.45" fill="#FFFFFF" />
      <circle cx="4.5" cy="3.2" r="0.45" fill="#FFFFFF" />
      <circle cx="1.4" cy="5.2" r="0.45" fill="#FFFFFF" />
      <circle cx="3.5" cy="5.2" r="0.45" fill="#FFFFFF" />
      <circle cx="5.6" cy="5.2" r="0.45" fill="#FFFFFF" />
    </>
  ),
  // Spain — red / yellow / red.
  ES: (
    <>
      <rect width="16" height="3" fill="#AA151B" />
      <rect y="3" width="16" height="6" fill="#F1BF00" />
      <rect y="9" width="16" height="3" fill="#AA151B" />
    </>
  ),
  // France — blue / white / red verticals.
  FR: (
    <>
      <rect width="5.33" height="12" fill="#0055A4" />
      <rect x="5.33" width="5.34" height="12" fill="#FFFFFF" />
      <rect x="10.67" width="5.33" height="12" fill="#EF4135" />
    </>
  ),
  // United Kingdom — simplified Union Jack.
  GB: (
    <>
      <rect width="16" height="12" fill="#012169" />
      <path d="M0 0l16 12M16 0L0 12" stroke="#FFFFFF" strokeWidth="2.4" />
      <path d="M0 0l16 12M16 0L0 12" stroke="#C8102E" strokeWidth="1.2" />
      <path d="M8 0v12M0 6h16" stroke="#FFFFFF" strokeWidth="3.6" />
      <path d="M8 0v12M0 6h16" stroke="#C8102E" strokeWidth="2" />
    </>
  ),
  // Germany — black / red / gold.
  DE: (
    <>
      <rect width="16" height="4" fill="#000000" />
      <rect y="4" width="16" height="4" fill="#DD0000" />
      <rect y="8" width="16" height="4" fill="#FFCE00" />
    </>
  ),
  // Italy — green / white / red verticals.
  IT: (
    <>
      <rect width="5.33" height="12" fill="#009246" />
      <rect x="5.33" width="5.34" height="12" fill="#FFFFFF" />
      <rect x="10.67" width="5.33" height="12" fill="#CE2B37" />
    </>
  ),
  // Argentina — light blue / white / light blue + sun.
  AR: (
    <>
      <rect width="16" height="4" fill="#74ACDF" />
      <rect y="4" width="16" height="4" fill="#FFFFFF" />
      <rect y="8" width="16" height="4" fill="#74ACDF" />
      <circle cx="8" cy="6" r="1.6" fill="#F6B40E" />
    </>
  ),
  // Japan — white field, red disc.
  JP: (
    <>
      <rect width="16" height="12" fill="#FFFFFF" />
      <circle cx="8" cy="6" r="3.2" fill="#BC002D" />
    </>
  ),
  // Australia — navy + canton cross + Commonwealth/Southern Cross stars.
  AU: (
    <>
      <rect width="16" height="12" fill="#00008B" />
      <path d="M4 0v6M0 3h8" stroke="#FFFFFF" strokeWidth="1.6" />
      <path d="M4 0v6M0 3h8" stroke="#C8102E" strokeWidth="0.8" />
      <circle cx="4" cy="8.8" r="1.1" fill="#FFFFFF" />
      <circle cx="11.2" cy="2" r="0.7" fill="#FFFFFF" />
      <circle cx="13.4" cy="5.2" r="0.7" fill="#FFFFFF" />
      <circle cx="11.6" cy="9" r="0.7" fill="#FFFFFF" />
      <circle cx="9.6" cy="5.6" r="0.7" fill="#FFFFFF" />
    </>
  ),
  // Serbia — red / blue / white + crest.
  RS: (
    <>
      <rect width="16" height="4" fill="#C6363C" />
      <rect y="4" width="16" height="4" fill="#0C4076" />
      <rect y="8" width="16" height="4" fill="#FFFFFF" />
      <circle cx="5.3" cy="6" r="1.9" fill="#C6363C" stroke="#EDB92E" strokeWidth="0.4" />
      <path d="M5.3 4.6v2.8M3.9 6h2.8" stroke="#FFFFFF" strokeWidth="0.5" />
    </>
  ),
  // Canada — red / white / red + simplified maple leaf.
  CA: (
    <>
      <rect width="4" height="12" fill="#D80621" />
      <rect x="4" width="8" height="12" fill="#FFFFFF" />
      <rect x="12" width="4" height="12" fill="#D80621" />
      <path
        d="M8 2.4l.8 1.3 1.4-.5-.4 1.3 1.5.8-1.2.9.4 1.2-1.4-.2-.3 1.8-.8-1.4-.8 1.4-.3-1.8-1.4.2.4-1.2-1.2-.9 1.5-.8-.4-1.3 1.4.5L8 2.4Z"
        fill="#D80621"
      />
      <path d="M8 7.4v1.4" stroke="#D80621" strokeWidth="0.7" />
    </>
  ),
  // Sweden — blue + yellow Nordic cross.
  SE: (
    <>
      <rect width="16" height="12" fill="#006AA7" />
      <rect x="5" width="2" height="12" fill="#FECC00" />
      <rect y="5" width="16" height="2" fill="#FECC00" />
    </>
  ),
  // Czechia — white / red + blue triangle.
  CZ: (
    <>
      <rect width="16" height="6" fill="#FFFFFF" />
      <rect y="6" width="16" height="6" fill="#D7141A" />
      <path d="M0 0L8 6L0 12Z" fill="#11457E" />
    </>
  ),
  // Portugal — green / red + armillary sphere.
  PT: (
    <>
      <rect width="6" height="12" fill="#046A38" />
      <rect x="6" width="10" height="12" fill="#DA291C" />
      <circle cx="6" cy="6" r="2.2" fill="#FFD100" />
      <circle cx="6" cy="6" r="1.2" fill="#DA291C" />
    </>
  ),
};

export interface FlagProps {
  /** Two-letter nationality code (any case). */
  code: string;
  /** Rendered width in px; height follows at 16:12. */
  size?: number;
  className?: string;
  title?: string;
}

export function Flag({ code, size = 16, className, title }: FlagProps) {
  const key = code?.toUpperCase?.() ?? '';
  const glyph = FLAGS[key];
  if (!glyph) {
    return (
      <span className={`gc-flcode ${className ?? ''}`} title={title ?? key}>
        {key || '—'}
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 16 12"
      width={size}
      height={size * 0.75}
      className={`gc-fl ${className ?? ''}`}
      role="img"
      aria-label={title ?? key}
      focusable="false"
    >
      {glyph}
    </svg>
  );
}
