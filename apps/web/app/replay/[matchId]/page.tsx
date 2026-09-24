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
import { SURFACE_COLOR } from '../../../lib/ui/surfaces';
import { AirState, matchAirState } from '../../../lib/matchAir';
import { DecidedSide, resolveDecidedSide } from '../../../lib/decidedIt';
import { useDevManagerId } from '../../../lib/managerContext';
import { useEntitlement } from '../../../lib/entitlement';

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
  /** The match's recorded per-side inputs, when the log carries them.
   * Preferred over the players' current values (see resolveDecidedSide). */
  inputs?: MatchLogDto['inputs'] | null;
  accent?: string;
}

/**
 * "What decided it" — the hidden rating inputs a reader of a scoreline
 * cannot see, made legible.
 *
 * Since the simulator now records each side's actual inputs into the
 * replay log (`MatchLog.inputs`), this panel shows the REAL match-time
 * fatigue/form/surface-affinity/home flag whenever they are present, and
 * says so ("at match time"). For a replay blob written before that field
 * existed it falls back to each player's current values, labelled "now" —
 * never presenting a current value as if it had decided the match.
 */
function WhatDecidedIt({ tournament, playerA, playerB, nameA, nameB, inputs, accent }: DecidedItProps) {
  const surface = (KNOWN_SURFACES as readonly string[]).includes(tournament.surface)
    ? (tournament.surface as KnownSurface)
    : null;
  const sideA = resolveDecidedSide(inputs?.a, playerA, surface, tournament.hostCountry);
  const sideB = resolveDecidedSide(inputs?.b, playerB, surface, tournament.hostCountry);
  const atMatchTime = sideA.atMatchTime && sideB.atMatchTime;
  const fatigueHint = atMatchTime ? 'at match time' : 'current, not at match time';

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

  const formCell = (side: DecidedSide) =>
    side.form === null ? '—' : <>{side.form}<span className="font-normal" style={{ color: 'var(--gc-ink-faint)' }}> · {formBandLabel(side.form)}</span></>;

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
      {row('Home / away', sideA.homeAdvantage ? '🏠 Home' : tournament.hostCountry ? 'Away' : '—', sideB.homeAdvantage ? '🏠 Home' : tournament.hostCountry ? 'Away' : '—', 'stable for this match')}
      {row('Fatigue', sideA.fatigue === null ? '—' : `${sideA.fatigue}/100`, sideB.fatigue === null ? '—' : `${sideB.fatigue}/100`, fatigueHint)}
      {row('Form', formCell(sideA), formCell(sideB), fatigueHint)}
      {row(
        surface ? `Surface affinity (${surface})` : 'Surface affinity',
        sideA.surfaceAffinity ?? '—',
        sideB.surfaceAffinity ?? '—',
        atMatchTime ? 'at match time' : 'current',
      )}
      <div className="px-[10px] py-[8px] text-[10.5px] leading-[1.5]" style={{ color: 'var(--gc-ink-mute)', borderTop: '1px solid var(--gc-line)' }}>
        {atMatchTime ? (
          <>These are the exact numbers that decided this match — each player&apos;s fatigue, form and surface affinity at the moment it was simulated, plus whether the home bonus applied.</>
        ) : (
          <>The sim blends each player&apos;s technical, physical and mental ability, adds their surface affinity, then applies a fatigue penalty, a form modifier and a home bonus on the day. Fatigue and form shown here are their values <em>now</em> — this replay predates per-match recording, so they are context, not the exact numbers that decided this one.</>
        )}
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
  /** The match's scheduled reveal start, when known — used with
   * `revealSeconds` to re-evaluate the air state each tick via the ONE shared
   * predicate (lib/matchAir) the bracket also uses, so the replay and the
   * bracket can never disagree about "has this aired". */
  scheduledStartAt: string | null;
  /** Real-time seconds this match's reveal occupies (0 = not scheduled) —
   * kept so the page can re-evaluate the air state on a tick instead of
   * freezing the value it saw at first fetch. */
  revealSeconds: number;
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
  // Persistent chrome consistency: the replay is reached from a bracket, so
  // it shares the same manager context as every other screen and shows the
  // XP balance (the same shared entitlement source, not a second fetch).
  const devManagerId = useDevManagerId() ?? '';
  const { entitlement } = useEntitlement(devManagerId);

  // Ticking clock so the premiere label re-evaluates against the SAME shared
  // predicate the bracket uses, rather than freezing the state seen at fetch
  // time (a replay page left open would otherwise still say "Premieres at"
  // after the bracket had begun showing the score).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
          scheduledStartAt: match.scheduledStartAt,
          revealSeconds: match.revealSeconds ?? 0,
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
  // Re-evaluated each tick from the same shared predicate (lib/matchAir) the
  // bracket uses. A match log only exists once the match is decided, so
  // `decided` is true here; the reveal schedule decides aired vs upcoming/live.
  const liveAirState: AirState = context
    ? matchAirState({ decided: true, scheduledStartAt: context.scheduledStartAt, revealSeconds: context.revealSeconds }, now)
    : 'upcoming';

  return (
    <AppFrame>
      <Sidebar active="tournaments" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance} />

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
            inputs={log?.inputs ?? null}
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
            airState={liveAirState}
            scheduledStartAt={context?.scheduledStartAt ?? null}
          />
        )}
      </div>
    </AppFrame>
  );
}
