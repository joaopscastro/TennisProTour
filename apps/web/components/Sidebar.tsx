'use client';

import Link from 'next/link';

export type NavKey = 'roster' | 'scouting' | 'tournaments' | 'manager-pro';

const NAV_ITEMS: Array<{ key: NavKey; label: string; href: string }> = [
  { key: 'roster', label: 'Roster', href: '/' },
  { key: 'scouting', label: 'Scouting', href: '/scouting' },
  { key: 'tournaments', label: 'Tournaments', href: '/tournaments' },
  { key: 'manager-pro', label: 'Manager Pro', href: '/manager-pro' },
];

interface Props {
  active: NavKey;
  /** Omit on pages with no single-manager context (bracket, replay) —
   * the footer then shows generic copy instead of fetching/guessing a
   * tier for a manager that isn't actually relevant on that screen. */
  tier?: 'free' | 'pro';
}

/**
 * The persistent nav shell (docs/ui-direction.md: "design it once...
 * reuse across the other three screens"). Ball logo + net-line motif
 * are structural conventions carried through every screen in the
 * Grand Circuit set, not just the roster dashboard.
 */
export function Sidebar({ active, tier }: Props) {
  return (
    <div
      className="w-[232px] flex-none flex flex-col p-[22px_16px] text-[oklch(96%_0.004_75)]"
      style={{ background: 'oklch(18% 0.006 75)' }}
    >
      <div className="flex items-center gap-[10px] px-2 pt-1 pb-[26px]">
        <div
          className="w-7 h-7 rounded-[5px] flex-none flex items-center justify-center"
          style={{ background: 'oklch(24% 0.008 75)' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9.5" fill="oklch(76% 0.19 122)" />
            <path d="M5.2 3.6c3 3.4 3 13.4 0 16.8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M18.8 3.6c-3 3.4-3 13.4 0 16.8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </div>
        <div className="font-bold text-[15px] tracking-[0.2px]">Grand Circuit</div>
      </div>

      <div className="flex flex-col gap-[2px]">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="flex items-center gap-[10px] px-3 py-[10px] rounded-[6px] text-[13.5px] no-underline"
            style={
              item.key === active
                ? { background: 'oklch(28% 0.008 75)', fontWeight: 600, color: 'inherit' }
                : { color: 'oklch(80% 0.005 75)' }
            }
          >
            <div
              className="w-[6px] h-[6px] rounded-full"
              style={{ background: item.key === active ? 'oklch(72% 0.14 45)' : 'transparent' }}
            />
            {item.label}
          </Link>
        ))}
        <div
          className="flex items-center justify-between px-3 py-[10px] rounded-[6px] text-[13.5px]"
          style={{ color: 'oklch(52% 0.006 75)' }}
        >
          <div className="flex items-center gap-[10px]">
            <div className="w-[6px] h-[6px] rounded-full bg-transparent" />
            Social
          </div>
          <div
            className="text-[10px] font-semibold tracking-[0.4px] px-[6px] py-[2px] rounded-[4px]"
            style={{ background: 'oklch(28% 0.008 75)', color: 'oklch(65% 0.006 75)' }}
          >
            SOON
          </div>
        </div>
      </div>

      <div className="mt-auto p-3 rounded-[8px] flex flex-col gap-[6px]" style={{ background: 'oklch(24% 0.008 75)' }}>
        <div className="flex items-center gap-[6px] mb-1">
          <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.55)' }} />
          <div className="w-px h-2" style={{ background: 'rgba(255,255,255,0.85)' }} />
          <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.55)' }} />
        </div>
        <div className="text-[11px] font-semibold tracking-[0.4px] uppercase" style={{ color: 'oklch(70% 0.006 75)' }}>
          {tier === 'pro' ? 'Manager Pro' : 'Free tier'}
        </div>
        <div className="text-[12px] leading-[1.4]" style={{ color: 'oklch(78% 0.005 75)' }}>
          {tier === 'pro' ? '4 roster slots · faster point decay applies' : '2 roster slots · upgrade for more room'}
        </div>
      </div>
    </div>
  );
}
