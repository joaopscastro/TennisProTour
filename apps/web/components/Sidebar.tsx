'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClerkAuthControls } from './ClerkAuthControls';
import { fetchWorldClock, WorldClockDto } from '../lib/api';
import { useCountdown, formatCountdown } from '../lib/useCountdown';
import { AnimatedNumber, Delta } from './ui/motion';

export type NavKey = 'roster' | 'scouting' | 'tournaments' | 'managers' | 'manager-pro';

const NAV_ITEMS: Array<{ key: NavKey; label: string; href: string; icon: string }> = [
  { key: 'roster', label: 'Roster', href: '/', icon: 'M4 7h16M4 12h16M4 17h10' },
  { key: 'scouting', label: 'Scouting', href: '/scouting', icon: 'M11 4a7 7 0 1 0 4.9 12l4.1 4.1M11 4a7 7 0 0 1 0 14' },
  { key: 'tournaments', label: 'Tournaments', href: '/tournaments', icon: 'M6 3h12v4a6 6 0 0 1-12 0zM10 14h4v5h-4zM8 21h8' },
  { key: 'managers', label: 'Managers', href: '/managers', icon: 'M3 20l4-8 4 5 3-9 4 12M3 20h18' },
  { key: 'manager-pro', label: 'Manager Pro', href: '/manager-pro', icon: 'M4 8l4 3 4-6 4 6 4-3-2 10H6z' },
];

interface Props {
  active: NavKey;
  /** Omit on pages with no single-manager context (bracket, replay). */
  tier?: 'free' | 'pro';
  /** Current XP balance — persistent chrome, omitted on manager-less pages. */
  xpBalance?: number;
}

/** The persistent nav shell. Ball logo + net-line motif are structural
 *  conventions carried through every screen. Living world clock (ticking
 *  countdown) is treated as chrome, per ui-direction-v2-game-feel.md §1. */
export function Sidebar({ active, tier, xpBalance }: Props) {
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchWorldClock().then((clock) => { if (!cancelled) setWorldClock(clock); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const remainingMs = useCountdown(worldClock?.nextTickAt ?? null);

  return (
    <div
      className="w-[240px] flex-none flex flex-col gc-grain"
      style={{
        padding: '20px 14px 16px',
        color: 'var(--gc-ink)',
        background: 'linear-gradient(180deg, oklch(19% 0.014 150), oklch(13% 0.011 150))',
        borderRight: '1px solid var(--gc-line)',
        position: 'sticky', top: 0, height: '100vh',
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 8px 22px' }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', flex: 'none',
          background: 'radial-gradient(circle at 35% 30%, oklch(90% 0.19 122), oklch(66% 0.17 122))',
          boxShadow: '0 2px 8px oklch(66% 0.17 122 / 0.4), 0 1px 0 oklch(100% 0 0 / 0.3) inset',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path d="M5.2 3.6c3 3.4 3 13.4 0 16.8" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M18.8 3.6c-3 3.4-3 13.4 0 16.8" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </div>
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, letterSpacing: '0.2px' }}>Grand Circuit</div>
          <div style={{ fontSize: 10.5, color: 'var(--gc-ink-faint)', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600 }}>Tennis Manager</div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {NAV_ITEMS.map((item) => {
          const on = item.key === active;
          return (
            <Link key={item.key} href={item.href}
              style={{
                display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 9,
                fontSize: 14, textDecoration: 'none', fontWeight: on ? 700 : 550,
                color: on ? 'var(--gc-ink)' : 'var(--gc-ink-mute)',
                background: on ? 'linear-gradient(180deg, var(--gc-s3), var(--gc-s2))' : 'transparent',
                border: on ? '1px solid var(--gc-line)' : '1px solid transparent',
                boxShadow: on ? '0 1px 0 var(--gc-hi) inset' : 'none',
                position: 'relative',
              }}>
              {on && <span style={{ position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 3, background: 'var(--gc-ball)', boxShadow: '0 0 8px var(--gc-ball)' }} />}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={on ? 'var(--gc-ball)' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d={item.icon} />
              </svg>
              {item.label}
            </Link>
          );
        })}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', fontSize: 14, color: 'var(--gc-ink-faint)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M17 20a5 5 0 0 0-10 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8" /></svg>
            Social
          </span>
          <span className="gc-badge" style={{ fontSize: 9 }}>Soon</span>
        </div>
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {worldClock && (
          <div className="gc-panel" style={{ padding: '11px 13px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
              <span className="gc-live-dot" style={{ background: 'var(--gc-ball)', boxShadow: '0 0 8px var(--gc-ball)' }} />
              <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--gc-ink-dim)' }}>
                Season {worldClock.currentWeek.season} · Week {worldClock.currentWeek.week}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: 'var(--gc-ink-mute)' }}>Day</span>
              <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--gc-ink)', fontVariantNumeric: 'tabular-nums' }}>{worldClock.currentDay} / {worldClock.daysPerWeek}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--gc-ink-mute)' }}>Next day</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--gc-gold)', fontVariantNumeric: 'tabular-nums' }}>{formatCountdown(remainingMs)}</span>
            </div>
          </div>
        )}

        {xpBalance !== undefined && (
          <div className="gc-panel" style={{ padding: '11px 13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--gc-ink-mute)' }}>XP Balance</span>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <AnimatedNumber
                value={xpBalance}
                mountFrom={xpBalance}
                style={{ fontSize: 16, fontWeight: 850, color: 'var(--gc-gold)' }}
              />
              <Delta value={xpBalance} suffix="XP" side="left" />
            </span>
          </div>
        )}

        <div className="gc-panel" style={{ padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="gc-net" style={{ marginBottom: 2 }}><span /></div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.8px', textTransform: 'uppercase', color: tier === 'pro' ? 'var(--gc-ball)' : 'var(--gc-ink-mute)' }}>
            {tier === 'pro' ? 'Manager Pro' : 'Free Tier'}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--gc-ink-mute)' }}>
            {tier === 'pro' ? '4 roster slots · faster point decay applies' : '2 roster slots · upgrade for more room'}
          </div>
        </div>
      </div>
      {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && <ClerkAuthControls />}
    </div>
  );
}
