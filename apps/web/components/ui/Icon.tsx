import type { CSSProperties, ReactNode } from 'react';

/**
 * Direction A icon set — inline SVG paths, 24×24 viewBox, 1.5px stroke,
 * `currentColor`. No sprite, no dependency: each icon is a small, readable
 * path set so a caller can inline it anywhere (server or client component).
 */
export type IconName =
  | 'ball'
  | 'trophy'
  | 'lock'
  | 'house'
  | 'star'
  | 'check'
  | 'close'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-up'
  | 'arrow-down'
  | 'play'
  | 'pause'
  | 'stopwatch'
  | 'search'
  | 'menu'
  | 'bars'
  | 'line-chart'
  | 'crown'
  | 'user'
  | 'info'
  | 'alert'
  | 'more'
  | 'diamond';

const PATHS: Record<IconName, ReactNode> = {
  ball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M4 8c4 2 12 2 16 0M4 16c4-2 12-2 16 0" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4h8v4a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5H5v2a3 3 0 0 0 3 3M16 5h3v2a3 3 0 0 1-3 3M10 15h4v3h-4zM8 21h8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="1.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  house: <path d="M4 11l8-7 8 7M6 10v10h12V10" />,
  star: <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3Z" />,
  check: <path d="M5 13l4 4L19 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  play: <path d="M7 5l12 7-12 7z" />,
  pause: <path d="M9 5v14M15 5v14" />,
  stopwatch: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 13V9M9 3h6M18 6l1.5 1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  bars: <path d="M5 20V10M12 20V4M19 20v-7" />,
  'line-chart': <path d="M4 5v14h16M8 15l3.5-4 3 2.5L19 8" />,
  crown: <path d="M4 18l-1.2-9 5.2 3.6L12 5l4 7.6L21.2 9 20 18H4ZM5 21h14" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-4 4.5-5.5 8-5.5s6.5 1.5 8 5.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: <path d="M12 3l9 16H3L12 3ZM12 10v4M12 17h.01" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  diamond: <path d="M12 3l8 8-8 10-8-10 8-8Z" />,
};

export interface IconProps {
  name: IconName;
  /** Pixel size of the square icon box. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible title; without it the icon is decorative (`aria-hidden`). */
  title?: string;
}

export function Icon({ name, size = 16, className, style, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: '0 0 auto', display: 'inline-block', verticalAlign: 'middle', ...style }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
