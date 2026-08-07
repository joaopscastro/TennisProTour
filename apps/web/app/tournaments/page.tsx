'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchOpenTournaments, fetchStartedTournaments, TournamentDto } from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'oklch(58% 0.14 45)',
  grass: 'oklch(52% 0.12 142)',
  hard: 'oklch(55% 0.13 240)',
  indoor: 'oklch(48% 0.05 300)',
};

function TournamentRow({ t, cta }: { t: TournamentDto; cta: string }) {
  return (
    <Link
      href={`/tournaments/${t.id}`}
      className="flex items-center justify-between rounded-[8px] bg-white px-4 py-[14px] no-underline hover:opacity-90"
      style={{ border: '1px solid oklch(90% 0.005 75)', color: 'inherit' }}
    >
      <div className="flex items-center gap-3">
        <div
          className="text-[11px] font-bold tracking-[0.4px] uppercase px-[9px] py-[4px] rounded-[4px] text-white"
          style={{ background: SURFACE_COLOR[t.surface] ?? 'oklch(50% 0.006 75)' }}
        >
          {t.surface}
        </div>
        {t.ageBand && (
          <div
            className="text-[11px] font-bold tracking-[0.4px] uppercase px-[9px] py-[4px] rounded-[4px]"
            style={{ background: 'oklch(90% 0.1 240)', color: 'oklch(35% 0.14 240)' }}
          >
            {t.ageBand}
          </div>
        )}
        <div>
          <div className="text-[14px] font-semibold">{t.id}</div>
          <div className="text-[12px]" style={{ color: 'oklch(50% 0.006 75)' }}>
            {t.tier} · {t.drawSize}-draw · {t.entrants.length}/{t.drawSize} entrants · Season {t.weekScheduled.season}, week{' '}
            {t.weekScheduled.week}
          </div>
        </div>
      </div>
      <div className="text-[12.5px] font-semibold" style={{ color: 'oklch(45% 0.12 240)' }}>
        {cta} →
      </div>
    </Link>
  );
}

export default function TournamentsIndexPage() {
  const [open, setOpen] = useState<TournamentDto[] | null>(null);
  const [started, setStarted] = useState<TournamentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchOpenTournaments(), fetchStartedTournaments()])
      .then(([o, s]) => {
        setOpen(o);
        setStarted(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="tournaments" />

      <div className="flex-1 p-8 max-w-[900px] min-w-0">
        <div className="text-[23px] font-bold tracking-[-0.2px] mb-1">Tournaments</div>
        <div className="text-[13.5px] mb-6" style={{ color: 'oklch(48% 0.006 75)' }}>
          Open draws still accepting entrants, and brackets already underway.
        </div>

        {error && (
          <div className="mb-4 text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        <div className="mb-8">
          <div className="text-[12px] font-bold tracking-[0.4px] uppercase mb-2" style={{ color: 'oklch(48% 0.006 75)' }}>
            Open for entries
          </div>
          <div className="flex flex-col gap-2">
            {open === null && !error && <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>Loading…</div>}
            {open?.length === 0 && <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>Nothing open right now.</div>}
            {open?.map((t) => (
              <TournamentRow key={t.id} t={t} cta="View draw" />
            ))}
          </div>
        </div>

        <div>
          <div className="text-[12px] font-bold tracking-[0.4px] uppercase mb-2" style={{ color: 'oklch(48% 0.006 75)' }}>
            Brackets underway
          </div>
          <div className="flex flex-col gap-2">
            {started === null && !error && <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>Loading…</div>}
            {started?.length === 0 && <div className="text-[13px]" style={{ color: 'oklch(55% 0.006 75)' }}>No brackets underway.</div>}
            {started?.map((t) => (
              <TournamentRow key={t.id} t={t} cta="Open bracket" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
