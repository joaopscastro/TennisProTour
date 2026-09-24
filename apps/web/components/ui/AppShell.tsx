'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ClerkAuthControls } from '../ClerkAuthControls';
import { fetchWorldClock, WorldClockDto } from '../../lib/api';
import { useCountdown, formatCountdownClock } from '../../lib/useCountdown';
import { Icon } from './Icon';

export type NavKey = 'roster' | 'scouting' | 'tournaments' | 'rankings' | 'managers' | 'manager-pro';

const NAV_ITEMS: Array<{ key: NavKey; label: string; href: string }> = [
  { key: 'roster', label: 'Roster', href: '/' },
  { key: 'scouting', label: 'Scouting', href: '/scouting' },
  { key: 'tournaments', label: 'Tournaments', href: '/tournaments' },
  { key: 'rankings', label: 'Rankings', href: '/rankings' },
  { key: 'managers', label: 'Managers', href: '/managers' },
  { key: 'manager-pro', label: 'Manager Pro', href: '/manager-pro' },
];

interface Props {
  active: NavKey;
  /** Omit on pages with no single-manager context (bracket, replay). */
  tier?: 'free' | 'pro';
  /** Current XP balance — persistent chrome, omitted on manager-less pages. */
  xpBalance?: number;
  children: React.ReactNode;
}

/** Direction A chrome (design/prototypes/a-broadcast-telemetry.html): a flat
 *  56px topbar carrying the brand, the underline nav tabs and the broadcast
 *  strip (world clock + next-day countdown, XP, tier), with the page content
 *  in a column below. Same props as `Sidebar` so a screen can swap
 *  `<AppFrame><Sidebar …/></AppFrame>` for `<AppShell …>` one at a time.
 *
 *  The clock logic is lifted verbatim from the Sidebar: fetch once, re-read
 *  on visibility, re-fetch when the countdown expires (compressed cadence
 *  would otherwise stick at zero), and the honest "World stalled" badge. */
export function AppShell({ active, tier, xpBalance, children }: Props) {
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const loadClock = useCallback(() => {
    fetchWorldClock().then(setWorldClock).catch(() => {});
  }, []);
  useEffect(() => {
    loadClock();
    const onVisible = () => { if (document.visibilityState === 'visible') loadClock(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadClock]);
  const remainingMs = useCountdown(worldClock?.nextTickAt ?? null, loadClock);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      <header className="gc-topbar">
        <div className="gc-topbar-in">
          <Link href="/" className="gc-brand">
            <Icon name="ball" size={20} className="ball" />
            <span style={{ lineHeight: 1.05 }}>
              <span style={{ display: 'block' }}>Grand Circuit</span>
              <span className="t-label" style={{ display: 'block', fontSize: 9, letterSpacing: '2px' }}>Tennis Manager</span>
            </span>
          </Link>

          <nav className="gc-topnav" aria-label="Main">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={`gc-tab${item.key === active ? ' is-active' : ''}`}
                aria-current={item.key === active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
            {/* Social (bounded context #7) has no destination yet — kept
                visible exactly as the Sidebar shows it, marked Soon. */}
            <span className="gc-tab" aria-disabled="true">
              Social <span className="gc-badge" style={{ marginLeft: 6, fontSize: 9 }}>Soon</span>
            </span>
          </nav>

          <div style={{ flex: 1, minWidth: 8 }} />

          {worldClock && (
            <div className="gc-topbar-kv">
              <span className="k">World clock</span>
              <span className="v num">
                S{worldClock.currentWeek.season} · W{worldClock.currentWeek.week} · DAY {worldClock.currentDay}/{worldClock.daysPerWeek}
              </span>
            </div>
          )}
          {worldClock && (
            <div className="gc-topbar-kv" style={{ textAlign: 'right' }}>
              <span className="k">Next day</span>
              <span className="v num" style={{ color: 'var(--accent)' }}>{formatCountdownClock(remainingMs)}</span>
            </div>
          )}
          {worldClock?.stale && (
            <span className="gc-badge" style={{ color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 55%, transparent)' }}>
              World stalled
            </span>
          )}

          {xpBalance !== undefined && (
            <span className="gc-xp">
              <span className="t-label" style={{ margin: 0 }}>XP</span>
              <span className="amt">{xpBalance.toLocaleString()}</span>
            </span>
          )}

          {tier !== undefined && (
            <span
              className="gc-badge"
              style={tier === 'pro' ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' } : undefined}
            >
              {tier === 'pro' ? 'MANAGER PRO' : 'FREE TIER'}
            </span>
          )}

          {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && <ClerkAuthControls variant="topbar" />}
        </div>
      </header>

      <main className="gc-main">{children}</main>
    </div>
  );
}
