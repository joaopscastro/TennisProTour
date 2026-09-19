import { ManagerId, PlayerId } from '@tennis-manager/domain';
import {
  DigestNextMatch,
  DigestPlayerData,
  DigestResult,
  DigestTitle,
} from '../queries/ManagerDigestQuery';

/**
 * Notifications bounded context (STAGE 1) — the pure digest logic.
 * Everything here is a function of its arguments: no I/O, no clock
 * reads, no randomness. The DB read lives in DrizzleManagerDigestQuery;
 * the orchestration (cursors, claiming, sending) lives in
 * SendManagerDigestsUseCase; this module is the part worth unit-testing
 * against literals.
 */

/**
 * Lookback for a manager who has NEVER received a successful digest: a
 * single day, so a first-ever digest covers an honest recent window
 * rather than dredging the whole season. PLACEHOLDER.
 */
export const FIRST_DIGEST_LOOKBACK_MS = 86_400_000;

/** The `notification_deliveries.kind` value this stage sends. */
export const RESULTS_DIGEST_KIND = 'results_digest';

/** A player's current standing, resolved by the use case from the
 * band-scoped RankPositionQuery — carried into the digest as context. */
export interface DigestPlayerRank {
  rank: number | null;
  totalPoints: number;
}

/** One player's assembled digest entry (window-filtered, with rank). */
export interface DigestPlayer {
  playerId: PlayerId;
  name: string;
  rank: number | null;
  totalPoints: number;
  results: DigestResult[];
  titles: DigestTitle[];
  next: DigestNextMatch | null;
}

export interface ManagerDigest {
  managerId: ManagerId;
  since: Date;
  until: Date;
  players: DigestPlayer[];
}

export interface RenderedDigestEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Human round name for a round number in a bracket of `drawSize` — the
 * round number relative to the final, e.g. in a 16-draw round 1 is
 * "Round of 16", round 3 is "Semifinal", round 4 is "Final". Mirrors
 * apps/web's singular round labels so the email and the UI agree.
 */
export function roundLabel(roundNumber: number, drawSize: number): string {
  const totalRounds = Math.round(Math.log2(drawSize));
  if (!Number.isFinite(totalRounds) || totalRounds < 1) return `Round ${roundNumber}`;
  const fromFinal = totalRounds - roundNumber;
  if (fromFinal <= 0) return 'Final';
  if (fromFinal === 1) return 'Semifinal';
  if (fromFinal === 2) return 'Quarterfinal';
  return `Round of ${2 ** (fromFinal + 1)}`;
}

const inWindow = (at: Date, since: Date, until: Date): boolean =>
  at.getTime() > since.getTime() && at.getTime() <= until.getTime();

/**
 * Assembles a manager's digest from raw query data. Window-filters
 * results by their real `airedAt` and titles by `createdAt` (both
 * `(since, until]` — half-open so consecutive windows never
 * double-count the boundary instant), attaches each player's rank, drops
 * players with nothing to report, and returns null when the manager has
 * no news at all. A null result is the signal the use case must SKIP
 * WITHOUT claiming — an empty digest must never advance the cursor.
 */
export function buildManagerDigest(input: {
  managerId: ManagerId;
  since: Date;
  until: Date;
  players: DigestPlayerData[];
  ranks: ReadonlyMap<PlayerId, DigestPlayerRank>;
}): ManagerDigest | null {
  const players: DigestPlayer[] = input.players
    .map((player) => {
      const results = player.results
        .filter((r) => inWindow(r.airedAt, input.since, input.until))
        .sort((a, b) => b.airedAt.getTime() - a.airedAt.getTime());
      const titles = player.titles
        .filter((t) => inWindow(t.createdAt, input.since, input.until))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const standing = input.ranks.get(player.playerId) ?? { rank: null, totalPoints: 0 };
      return {
        playerId: player.playerId,
        name: player.name,
        rank: standing.rank,
        totalPoints: standing.totalPoints,
        results,
        titles,
        next: player.next,
      };
    })
    .filter((player) => player.results.length > 0 || player.titles.length > 0 || player.next !== null);

  if (players.length === 0) return null;

  return { managerId: input.managerId, since: input.since, until: input.until, players };
}

/** Scoreline from the digesting player's perspective (setScores are
 * stored winner-first). */
function perspectiveScore(setScores: readonly { winnerGames: number; loserGames: number }[], won: boolean): string {
  return setScores.map((s) => (won ? `${s.winnerGames}-${s.loserGames}` : `${s.loserGames}-${s.winnerGames}`)).join(', ');
}

function rankText(rank: number | null, totalPoints: number): string {
  return rank === null ? 'Unranked' : `Rank #${rank} (${totalPoints} pts)`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the transport-ready subject/text/html for a digest. Pure, so
 * the copy is unit-testable without sending anything.
 */
export function renderDigestEmail(digest: ManagerDigest): RenderedDigestEmail {
  const subject = 'Tennis Manager - your weekly results digest';

  const textLines: string[] = [
    'Tennis Manager - your weekly results digest',
    `Covering ${digest.since.toISOString()} to ${digest.until.toISOString()}`,
  ];
  const htmlParts: string[] = [
    '<h1>Tennis Manager - your weekly results digest</h1>',
    `<p>Covering ${escapeHtml(digest.since.toISOString())} to ${escapeHtml(digest.until.toISOString())}</p>`,
  ];

  for (const player of digest.players) {
    textLines.push('');
    textLines.push(`${player.name} - ${rankText(player.rank, player.totalPoints)}`);
    htmlParts.push(`<h2>${escapeHtml(player.name)} <small>${escapeHtml(rankText(player.rank, player.totalPoints))}</small></h2>`);

    if (player.results.length > 0) {
      textLines.push('Results:');
      htmlParts.push('<ul>');
      for (const result of player.results) {
        const outcome = result.won ? 'W' : 'L';
        const line = `${outcome} ${perspectiveScore(result.setScores, result.won)} vs ${result.opponentName} - ${roundLabel(result.roundNumber, result.drawSize)} - ${result.tournamentName} (${result.tier})`;
        textLines.push(`  ${line}`);
        htmlParts.push(`<li>${escapeHtml(line)}</li>`);
      }
      htmlParts.push('</ul>');
    }

    if (player.titles.length > 0) {
      textLines.push('Titles:');
      htmlParts.push('<ul>');
      for (const title of player.titles) {
        const line = `Won ${title.tournamentName} (${title.tier})`;
        textLines.push(`  ${line}`);
        htmlParts.push(`<li>${escapeHtml(line)}</li>`);
      }
      htmlParts.push('</ul>');
    }

    if (player.next) {
      const when = player.next.scheduledStartAt ? ` starts ${player.next.scheduledStartAt.toISOString()}` : '';
      const line = `vs ${player.next.opponentName} - ${roundLabel(player.next.roundNumber, player.next.drawSize)} - ${player.next.tournamentName}${when}`;
      textLines.push(`Up next: ${line}`);
      htmlParts.push(`<p>Up next: ${escapeHtml(line)}</p>`);
    }
  }

  return { subject, text: textLines.join('\n'), html: htmlParts.join('\n') };
}
