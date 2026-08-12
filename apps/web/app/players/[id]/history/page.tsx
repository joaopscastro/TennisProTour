'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PlayerProfileDto, fetchPlayerProfile } from '../../../../lib/api';
import { Sidebar } from '../../../../components/Sidebar';
import { Avatar } from '../../../../components/ui/Avatar';
import { AppFrame, Hero, Flag } from '../../../../components/ui/primitives';
import { tournamentHistoryResultLabel } from '../../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};

const JUNIOR_BADGE = { bg: 'oklch(45% 0.1 240 / 0.35)', fg: 'oklch(85% 0.08 240)' };

export default function PlayerHistoryPage() {
  const params = useParams<{ id: string }>();
  const playerId = params.id;
  const [profile, setProfile] = useState<PlayerProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPlayerProfile(playerId)
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId]);

  if (error) {
    return (
      <AppFrame>
        <Sidebar active="roster" />
        <div className="flex-1 p-8">
          <div className="text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)' }}>
            {error}
          </div>
        </div>
      </AppFrame>
    );
  }

  if (!profile) {
    return (
      <AppFrame>
        <Sidebar active="roster" />
        <div className="flex-1 p-8 text-[13.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
          Loading history…
        </div>
      </AppFrame>
    );
  }

  const titledCount = profile.titles.length;
  const heroSurface = profile.tournamentHistory[0]?.surface ?? null;

  return (
    <AppFrame>
      <Sidebar active="roster" />

      <div className="flex-1 p-8 max-w-[900px] min-w-0">
        <Link href={`/players/${playerId}`} className="text-[13px] font-semibold no-underline hover:underline" style={{ color: 'var(--gc-ball)' }}>
          ← Back to profile
        </Link>

        <div className="mt-[14px] mb-[24px]">
          <Hero surface={heroSurface} minHeight={130}>
            <div className="flex items-end gap-[18px]">
              <Avatar id={profile.playerId} name={profile.name} size={72} ring />
              <div className="pb-[2px]">
                <div className="text-[11px] font-extrabold tracking-[2px] uppercase text-white/70">Tournament history</div>
                <div className="text-[26px] font-extrabold tracking-[-0.4px] text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.4)] mt-[2px] flex items-center gap-[9px]">
                  <Flag code={profile.nationality} size={17} /> {profile.name}
                </div>
                <div className="text-[13px] mt-[6px] text-white/80">
                  {profile.tournamentHistory.length} tournament{profile.tournamentHistory.length === 1 ? '' : 's'} entered
                  {titledCount > 0 && <> · {titledCount} 🏆</>}
                </div>
              </div>
            </div>
          </Hero>
        </div>

        {profile.tournamentHistory.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--gc-ink-mute)' }}>
            No tournament entries yet.
          </div>
        ) : (
          <div className="flex flex-col gap-[8px]">
            {profile.tournamentHistory.map((entry) => (
              <Link
                key={entry.tournamentId}
                href={`/tournaments/${entry.tournamentId}`}
                className="flex items-center justify-between gc-card gc-card--hover rounded-[8px] px-[14px] py-[11px] no-underline"
                style={{ border: '1px solid var(--gc-line)', color: 'inherit' }}
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <div
                    className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[3px] rounded-[4px] text-white flex-none"
                    style={{ background: SURFACE_COLOR[entry.surface] ?? 'var(--gc-line)' }}
                  >
                    {entry.surface}
                  </div>
                  {entry.ageBand && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px] flex-none"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {entry.ageBand}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-[13.5px] overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--gc-ink-mute)' }}>
                      {entry.tier} · {entry.drawSize}-draw · Season {entry.weekScheduled.season}, Week {entry.weekScheduled.week}
                    </div>
                  </div>
                </div>
                <div className="text-[12px] font-semibold flex-none" style={{ color: entry.won ? 'oklch(80% 0.14 85)' : 'var(--gc-ink-mute)' }}>
                  {tournamentHistoryResultLabel(entry)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppFrame>
  );
}
