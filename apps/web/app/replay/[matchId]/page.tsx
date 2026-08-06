'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  MatchLogDto,
  PlayerDto,
  TournamentDto,
  fetchMatchLog,
  fetchPlayersByIds,
  fetchTournament,
  matchIdForSlot,
  parseMatchId,
} from '../../../lib/api';
import { Sidebar } from '../../../components/Sidebar';
import { MatchReplayPlayer } from '../../../components/MatchReplayPlayer';
import { flagFor, matchRoundLabel } from '../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'oklch(58% 0.14 45)',
  grass: 'oklch(52% 0.12 142)',
  hard: 'oklch(55% 0.13 240)',
  indoor: 'oklch(48% 0.05 300)',
};

interface MatchContext {
  tournament: TournamentDto;
  roundNumber: number;
  matchIndex: number;
  entrantA: string;
  entrantB: string;
  playerA: PlayerDto | null;
  playerB: PlayerDto | null;
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
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="tournaments" />

      <div className="flex-1 p-8 max-w-[1040px] min-w-0">
        <div className="flex items-center gap-2 text-[13px] mb-[14px]" style={{ color: 'oklch(48% 0.006 75)' }}>
          <Link href={context ? `/tournaments/${context.tournament.id}` : '/tournaments'} className="font-semibold no-underline hover:underline" style={{ color: 'oklch(45% 0.12 240)' }}>
            ← Back to bracket
          </Link>
          {context && (
            <>
              <span>·</span>
              <span>{context.tournament.id}</span>
              <span>·</span>
              <span>{matchRoundLabel(context.tournament.drawSize / 2 ** context.roundNumber)}</span>
              <div
                className="text-[11px] font-bold tracking-[0.4px] uppercase px-2 py-[3px] rounded-[4px] text-white ml-[2px]"
                style={{ background: accent ?? 'oklch(50% 0.006 75)' }}
              >
                {context.tournament.surface}
              </div>
            </>
          )}
        </div>

        {error && !log && (
          <div className="text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}
        {!log && !error && (
          <div className="text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
            Loading replay…
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
    </div>
  );
}
