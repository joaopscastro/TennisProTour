'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  MatchLogDto,
  PlayerDto,
  PlayerTournamentHistoryEntryDto,
  TournamentDto,
  fetchMatchLog,
  fetchPlayerProfile,
  fetchPlayersByIds,
  fetchTournament,
  matchIdForSlot,
  parseMatchId,
} from '../../../lib/api';
import { Sidebar } from '../../../components/Sidebar';
import { MatchReplayPlayer } from '../../../components/MatchReplayPlayer';
import { AppFrame } from '../../../components/ui/primitives';
import { VersusPlayer, PlayerCardRank } from '../../../components/ui/PlayerCard';
import { RANK_BAND_LABEL, flagFor, matchRoundLabel } from '../../../lib/format';
import { AirState, matchAirState } from '../../../lib/matchAir';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};

const KNOWN_SURFACES = ['clay', 'grass', 'hard', 'indoor'] as const;
type KnownSurface = (typeof KNOWN_SURFACES)[number];

/** The form band a value sits in — mirrors StatisticalMatchSimulator's
 * `formModifier` bands (rusty/warming/sharp/well-played/overplayed), the
 * same bands the roster's form gauge labels. Presentation only. */
function formBandLabel(form: number): string {
  if (form > 30) return 'overplayed';
  if (form >= 12 && form <= 25) return 'match sharp';
  if (form >= 26) return 'well-played';
  if (form >= 8) return 'warming up';
  return 'rusty';
}

interface DecidedItProps {
  tournament: TournamentDto;
  playerA: PlayerDto | null;
  playerB: PlayerDto | null;
  nameA: string;
  nameB: string;
  accent?: string;
}

/**
 * "What decided it" — the hidden rating inputs a reader of a scoreline
 * cannot see, made legible.
 *
 * **Honest data-availability note (a real gap, not glossed over here):**
 * the simulator's `effectiveRating` reads each player's fatigue and form
 * AT SIMULATION TIME, but neither is persisted with the match — the
 * `MatchLog` blob carries only points/games/duration, and the
 * `tournament_matches` row carries only the entrants, outcome and
 * reveal schedule. There is no per-match fatigue/form history anywhere.
 * So this panel deliberately does NOT present the values that actually
 * fed THIS match as if it did. What it renders is:
 *   - surface (the tournament's, stable),
 *   - home/away (derived from nationality vs. the tournament's host
 *     country — both stable, so this IS the match's real home bonus),
 *   - each player's CURRENT fatigue and form, and their CURRENT surface
 *     affinity, every one explicitly labelled "now".
 * Closing the gap for real needs a schema change (stamp the inputs onto
 * the match row or the log) and is deliberately left as its own scoped
 * piece of work rather than fabricated here.
 */
function WhatDecidedIt({ tournament, playerA, playerB, nameA, nameB, accent }: DecidedItProps) {
  const surface = (KNOWN_SURFACES as readonly string[]).includes(tournament.surface)
    ? (tournament.surface as KnownSurface)
    : null;
  const affinityOf = (p: PlayerDto | null): number | null => (p && surface ? p.attributes.surfaceAffinities[surface] : null);
  const isHome = (p: PlayerDto | null): boolean => tournament.hostCountry != null && p?.nationality === tournament.hostCountry;

  const row = (label: string, a: React.ReactNode, b: React.ReactNode, hint?: string) => (
    <div key={label} className="grid items-center gap-x-[8px] px-[10px] py-[6px]" style={{ gridTemplateColumns: '1.3fr 1fr 1fr', borderTop: '1px solid var(--gc-line)' }}>
      <div className="text-[11px] font-semibold" style={{ color: 'var(--gc-ink-mute)' }}>
        {label}
        {hint && <div className="text-[9.5px] font-normal" style={{ color: 'var(--gc-ink-faint)' }}>{hint}</div>}
      </div>
      <div className="text-[12px] font-semibold text-right [font-variant-numeric:tabular-nums]">{a}</div>
      <div className="text-[12px] font-semibold text-right [font-variant-numeric:tabular-nums]">{b}</div>
    </div>
  );

  const formCell = (p: PlayerDto | null) =>
    p ? <>{p.form}<span className="font-normal" style={{ color: 'var(--gc-ink-faint)' }}> · {formBandLabel(p.form)}</span></> : '—';

  return (
    <div className="mb-[14px] gc-card rounded-[10px] overflow-hidden" style={{ border: '1px solid var(--gc-line)' }}>
      <div className="flex items-center gap-[8px] px-[10px] py-[8px]">
        <span className="text-[10.5px] font-extrabold tracking-[0.6px] uppercase" style={{ color: 'var(--gc-ink-mute)' }}>What decided it</span>
        {accent && (
          <span className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[6px] py-[1px] rounded-[3px] text-white" style={{ background: accent }}>
            {tournament.surface}
          </span>
        )}
        {tournament.hostCountry && <span className="text-[10.5px]" style={{ color: 'var(--gc-ink-faint)' }}>Host: {tournament.hostCountry}</span>}
      </div>
      <div className="grid gap-x-[8px] px-[10px] py-[5px] text-[10px] font-bold tracking-[0.4px] uppercase" style={{ gridTemplateColumns: '1.3fr 1fr 1fr', color: 'var(--gc-ink-faint)' }}>
        <span />
        <span className="text-right overflow-hidden text-ellipsis whitespace-nowrap">{nameA}</span>
        <span className="text-right overflow-hidden text-ellipsis whitespace-nowrap">{nameB}</span>
      </div>
      {row('Home / away', isHome(playerA) ? '🏠 Home' : tournament.hostCountry ? 'Away' : '—', isHome(playerB) ? '🏠 Home' : tournament.hostCountry ? 'Away' : '—', 'stable for this match')}
      {row('Fatigue', playerA ? `${playerA.fatigue}/100` : '—', playerB ? `${playerB.fatigue}/100` : '—', 'current, not at match time')}
      {row('Form', formCell(playerA), formCell(playerB), 'current, not at match time')}
      {row(
        surface ? `Surface affinity (${surface})` : 'Surface affinity',
        affinityOf(playerA) ?? '—',
        affinityOf(playerB) ?? '—',
        'current',
      )}
      <div className="px-[10px] py-[8px] text-[10.5px] leading-[1.5]" style={{ color: 'var(--gc-ink-mute)', borderTop: '1px solid var(--gc-line)' }}>
        The sim blends each player&apos;s technical, physical and mental ability, adds their surface affinity, then applies a fatigue penalty, a form modifier and a home bonus on the day. Fatigue and form shown here are their values <em>now</em> — they change as matches are played and are not recorded per match, so they are context, not the exact numbers that decided this one.
      </div>
    </div>
  );
}

interface MatchContext {
  tournament: TournamentDto;
  roundNumber: number;
  matchIndex: number;
  /** Which bracket this match belongs to — the replay of a qualifying
   * match and one from the main draw are indistinguishable from the
   * matchId alone, so parseMatchId recovers it and everything below
   * reads the right rounds array. */
  draw: 'main' | 'qualifying';
  entrantA: string;
  entrantB: string;
  playerA: PlayerDto | null;
  playerB: PlayerDto | null;
  /** Whether this match's premiere has started/ended, from the ONE shared
   * predicate (lib/matchAir.ts) the bracket also uses, so the replay and
   * the bracket can never disagree about "has this aired". */
  airState: AirState;
  scheduledStartAt: string | null;
  rankA: PlayerCardRank | null;
  rankB: PlayerCardRank | null;
  formA: PlayerTournamentHistoryEntryDto[];
  formB: PlayerTournamentHistoryEntryDto[];
  nextReplayHref: string | null;
  nextRoundHref: string | null;
  nextRoundLabel: string | null;
  roundLabel: string;
}

export default function ReplayPage() {
  const params = useParams<{ matchId: string }>();
  const matchId = params.matchId;
  const [log, setLog] = useState<MatchLogDto | null>(null);
  const [context, setContext] = useState<MatchContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // One plain GET for an immutable blob — the entirety of this
    // page's server interaction for the log itself (CLAUDE.md
    // principle #4). Tournament/player context is a separate, best-
    // effort fetch: the replay must still work even if it fails.
    fetchMatchLog(matchId)
      .then(setLog)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    const parsed = parseMatchId(matchId);
    if (!parsed) return;
    const { tournamentId, roundNumber, matchIndex, draw } = parsed;
    fetchTournament(tournamentId)
      .then(async (tournament) => {
        const rounds = draw === 'qualifying' ? tournament.qualifyingRounds : tournament.rounds;
        const match = rounds.find((r) => r.roundNumber === roundNumber)?.matches[matchIndex];
        if (!match) return;
        const airState = matchAirState({
          decided: match.outcome !== null,
          scheduledStartAt: match.scheduledStartAt,
          revealSeconds: match.revealSeconds ?? 0,
        });
        const players = await fetchPlayersByIds([match.entrantA, match.entrantB]);

        // Best-effort identity enrichment (rank + recent form) for the
        // facing participant cards — the replay must still render if
        // either profile fetch fails, so both degrade to null/empty.
        const [profA, profB] = await Promise.all([
          fetchPlayerProfile(match.entrantA).catch(() => null),
          fetchPlayerProfile(match.entrantB).catch(() => null),
        ]);
        const bestRank = (p: typeof profA): PlayerCardRank | null => {
          if (!p) return null;
          const ranked = p.currentRankings
            .filter((r) => r.rank !== null)
            .sort((a, b) => (a.rank as number) - (b.rank as number))[0];
          if (!ranked) return null;
          // Carry the band label with the rank — the "best" rank may come
          // from a different ladder than the other participant's, so an
          // unlabelled "#3" here would contradict a roster/profile rank.
          return { rank: ranked.rank, points: ranked.totalPoints, bandLabel: RANK_BAND_LABEL[ranked.band] };
        };

        let nextReplayHref: string | null = null;
        let nextRoundHref: string | null = null;
        let nextRoundLabel: string | null = null;
        const nextRoundNumber = roundNumber + 1;
        const totalRounds = draw === 'qualifying' ? tournament.qualifyingRoundCount : Math.log2(tournament.drawSize);
        if (nextRoundNumber <= totalRounds) {
          nextRoundHref = `/tournaments/${tournamentId}#round-${nextRoundNumber}`;
          nextRoundLabel = draw === 'qualifying'
            ? `Qualifying round ${nextRoundNumber}`
            : matchRoundLabel(tournament.drawSize / 2 ** nextRoundNumber);
        }
        const nextRound = rounds.find((r) => r.roundNumber === nextRoundNumber);
        if (nextRound) {
          const nextMatch = nextRound.matches[Math.floor(matchIndex / 2)];
          if (nextMatch?.outcome) {
            nextReplayHref = `/replay/${matchIdForSlot(tournamentId, nextRoundNumber, Math.floor(matchIndex / 2), draw)}`;
          }
        }

        setContext({
          tournament,
          roundNumber,
          matchIndex,
          draw,
          entrantA: match.entrantA,
          entrantB: match.entrantB,
          playerA: players.get(match.entrantA) ?? null,
          playerB: players.get(match.entrantB) ?? null,
          airState,
          scheduledStartAt: match.scheduledStartAt,
          rankA: bestRank(profA),
          rankB: bestRank(profB),
          formA: profA?.tournamentHistory ?? [],
          formB: profB?.tournamentHistory ?? [],
          nextReplayHref,
          nextRoundHref,
          nextRoundLabel,
          roundLabel: draw === 'qualifying'
            ? `Qualifying round ${roundNumber}`
            : matchRoundLabel(tournament.drawSize / 2 ** roundNumber),
        });
      })
      .catch(() => {
        // Best-effort: replay still works with generic player labels.
      });
  }, [matchId]);

  const playerAName = context?.playerA?.name ?? 'Player A';
  const playerBName = context?.playerB?.name ?? 'Player B';
  const accent = context ? (SURFACE_COLOR[context.tournament.surface] ?? undefined) : undefined;

  return (
    <AppFrame>
      <Sidebar active="tournaments" />

      <div className="flex-1 p-8 max-w-[1040px] min-w-0" style={{ background: 'var(--gc-bg)' }}>
        <div className="flex items-center gap-2 text-[13px] mb-[16px] flex-wrap" style={{ color: 'var(--gc-ink-mute)' }}>
          <Link href={context ? `/tournaments/${context.tournament.id}` : '/tournaments'} className="font-semibold no-underline hover:underline" style={{ color: 'var(--gc-ball)' }}>
            ← Back to bracket
          </Link>
          {context && (
            <>
              <span>·</span>
              <span style={{ color: 'var(--gc-ink-dim)' }}>{context.tournament.name}</span>
              <span>·</span>
              <span>{context.roundLabel}</span>
              <div
                className="text-[11px] font-bold tracking-[0.4px] uppercase px-2 py-[3px] rounded-[4px] text-white ml-[2px]"
                style={{ background: accent ?? 'var(--gc-s3)' }}
              >
                {context.tournament.surface}
              </div>
            </>
          )}
        </div>

        {error && !log && (
          <div className="text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}
        {!log && !error && (
          <div className="text-[13.5px]" style={{ color: 'var(--gc-ink-mute)' }}>
            Loading replay…
          </div>
        )}

        {context && (context.playerA || context.playerB) && (
          <div
            className="grid gap-[10px] mb-[14px] items-stretch"
            style={{ gridTemplateColumns: '1fr auto 1fr' }}
          >
            <VersusPlayer
              id={context.entrantA}
              name={playerAName}
              nationality={context.playerA?.nationality ?? '—'}
              rank={context.rankA ?? undefined}
              form={context.formA}
              accent={accent}
            />
            <div className="flex items-center justify-center px-[6px]">
              <span
                className="text-[13px] font-black tracking-[1px] uppercase"
                style={{ color: 'var(--gc-ink-mute)' }}
              >
                vs
              </span>
            </div>
            <VersusPlayer
              id={context.entrantB}
              name={playerBName}
              nationality={context.playerB?.nationality ?? '—'}
              rank={context.rankB ?? undefined}
              form={context.formB}
              accent={accent}
              mirror
            />
          </div>
        )}

        {context && (
          <WhatDecidedIt
            tournament={context.tournament}
            playerA={context.playerA}
            playerB={context.playerB}
            nameA={playerAName}
            nameB={playerBName}
            accent={accent}
          />
        )}

        {log && (
          <MatchReplayPlayer
            log={log}
            playerAName={playerAName}
            playerBName={playerBName}
            playerAFlag={context?.playerA ? flagFor(context.playerA.nationality) : undefined}
            playerBFlag={context?.playerB ? flagFor(context.playerB.nationality) : undefined}
            surfaceColor={accent}
            backToBracketHref={context ? `/tournaments/${context.tournament.id}` : undefined}
            nextReplayHref={context?.nextReplayHref ?? undefined}
            nextRoundHref={context?.nextRoundHref ?? undefined}
            nextRoundLabel={context?.nextRoundLabel ?? undefined}
            airState={context?.airState ?? 'upcoming'}
            scheduledStartAt={context?.scheduledStartAt ?? null}
          />
        )}
      </div>
    </AppFrame>
  );
}
