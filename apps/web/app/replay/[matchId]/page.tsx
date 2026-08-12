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
import { flagFor, matchRoundLabel } from '../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};

interface MatchContext {
  tournament: TournamentDto;
  roundNumber: number;
  matchIndex: number;
  entrantA: string;
  entrantB: string;
  playerA: PlayerDto | null;
  playerB: PlayerDto | null;
  rankA: PlayerCardRank | null;
  rankB: PlayerCardRank | null;
  formA: PlayerTournamentHistoryEntryDto[];
  formB: PlayerTournamentHistoryEntryDto[];
  nextReplayHref: string | null;
  nextRoundHref: string | null;
  nextRoundLabel: string | null;
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
    const { tournamentId, roundNumber, matchIndex } = parsed;
    fetchTournament(tournamentId)
      .then(async (tournament) => {
        const match = tournament.rounds.find((r) => r.roundNumber === roundNumber)?.matches[matchIndex];
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
          return { rank: ranked.rank, points: ranked.totalPoints };
        };

        let nextReplayHref: string | null = null;
        let nextRoundHref: string | null = null;
        let nextRoundLabel: string | null = null;
        const nextRoundNumber = roundNumber + 1;
        if (nextRoundNumber <= Math.log2(tournament.drawSize)) {
          nextRoundHref = `/tournaments/${tournamentId}#round-${nextRoundNumber}`;
          nextRoundLabel = matchRoundLabel(tournament.drawSize / 2 ** nextRoundNumber);
        }
        const nextRound = tournament.rounds.find((r) => r.roundNumber === nextRoundNumber);
        if (nextRound) {
          const nextMatch = nextRound.matches[Math.floor(matchIndex / 2)];
          if (nextMatch?.outcome) {
            nextReplayHref = `/replay/${matchIdForSlot(tournamentId, nextRoundNumber, Math.floor(matchIndex / 2))}`;
          }
        }

        setContext({
          tournament,
          roundNumber,
          matchIndex,
          entrantA: match.entrantA,
          entrantB: match.entrantB,
          playerA: players.get(match.entrantA) ?? null,
          playerB: players.get(match.entrantB) ?? null,
          rankA: bestRank(profA),
          rankB: bestRank(profB),
          formA: profA?.tournamentHistory ?? [],
          formB: profB?.tournamentHistory ?? [],
          nextReplayHref,
          nextRoundHref,
          nextRoundLabel,
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
              <span>{matchRoundLabel(context.tournament.drawSize / 2 ** context.roundNumber)}</span>
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
          />
        )}
      </div>
    </AppFrame>
  );
}
