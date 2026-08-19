'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  MatchOutcomeDto,
  PlayerDto,
  RosterDashboardEntryDto,
  TournamentDto,
  WorldClockDto,
  fetchPlayerProfile,
  fetchPlayersByIds,
  fetchRosterDashboard,
  fetchTournament,
  fetchWorldClock,
  matchIdForSlot,
  registerDoublesEntrant,
  simulateMatch,
} from '../../../lib/api';
import { Sidebar } from '../../../components/Sidebar';
import { AppFrame, Hero, Panel, SectionLabel } from '../../../components/ui/primitives';
import { CelebrationMoment, CelebrationOverlay } from '../../../components/ui/Celebration';
import { surfaceTheme } from '../../../lib/surfaces';
import { flagFor, formatScoreline } from '../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'var(--sf-clay)',
  grass: 'var(--sf-grass)',
  hard: 'var(--sf-hard)',
  indoor: 'var(--sf-indoor)',
};
const MUTED = 'oklch(42% 0.008 75)';

const CARD_H = 84;
const GAP0 = 14;
const COL_W = 232;
const GUT_W = 40;
const COLLAPSED_W = 210;

// ---------------------------------------------------------------------------
// Bracket-shape math — mirrors BracketGenerator.seedSlotOrder/orderBySeed
// (packages/domain) so round 1's bye slots can be reconstructed from public
// data (entrants + drawSize) without the backend needing to expose bracket
// placement as its own concept. From round 2 onward, byes never recur (see
// BracketGenerator's doc comment), so no equivalent reconstruction is needed
// there — round r's matches[i] connects directly from round(r-1)'s
// matches[2i] and matches[2i+1].
// ---------------------------------------------------------------------------

function seedSlotOrder(drawSize: number): number[] {
  let order = [1];
  while (order.length < drawSize) {
    const n = order.length;
    const next: number[] = [];
    for (const seed of order) next.push(seed, 2 * n + 1 - seed);
    order = next;
  }
  return order;
}

interface Entrant {
  playerId: string;
  seed: number | null;
}

function orderBySeed(entrants: Entrant[]): Entrant[] {
  return [...entrants].sort((a, b) => {
    if (a.seed === null && b.seed === null) return 0;
    if (a.seed === null) return 1;
    if (b.seed === null) return -1;
    return a.seed - b.seed;
  });
}

function roundLabel(matchesInRound: number): string {
  if (matchesInRound === 1) return 'Final';
  if (matchesInRound === 2) return 'Semifinals';
  if (matchesInRound === 4) return 'Quarterfinals';
  return `Round of ${matchesInRound * 2}`;
}

function tierLabel(tier: string): string {
  if (/^j\d+$/.test(tier)) return tier.toUpperCase();
  if (tier === 'juniorMasters') return 'Junior Masters';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** Tournament "profile" details — circuit, level, points-per-round
 * ladder, and the logistical facts. Rendered both before the draw is
 * made (in place of the useless blank bracket) and alongside it during
 * play, so the profile is always available. Pure presentation. */
function TournamentDetailsPanel({ tournament }: { tournament: TournamentDto }) {
  const th = surfaceTheme(tournament.surface);
  const facts: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Circuit', value: tournament.circuit === 'junior' ? `Junior${tournament.ageBand ? ` · ${tournament.ageBand.toUpperCase()}` : ''}` : 'Senior tour' },
    { label: 'Level', value: tierLabel(tournament.tier) },
    { label: 'Surface', value: <span style={{ textTransform: 'capitalize' }}>{tournament.surface}</span> },
    { label: 'Draw', value: `${tournament.drawSize} players` },
    { label: 'Host', value: tournament.hostCountry ? `🏠 ${tournament.hostCountry}` : '—' },
    { label: 'Scheduled', value: `S${tournament.weekScheduled.season} W${tournament.weekScheduled.week}` },
  ];
  if (tournament.qualifierSlots > 0) {
    facts.push({ label: 'Qualifiers', value: `${tournament.qualifierSlots} [Q] slots` });
    facts.push({
      label: 'Qualifying draw',
      value: `${tournament.qualifyingDrawSize} players · ${tournament.qualifyingRoundCount} rounds`,
    });
  }
  return (
    <Panel style={{ padding: 18 }}>
      <SectionLabel>Tournament details</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12, marginTop: 12 }}>
        {facts.map((f) => (
          <div key={f.label}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--gc-ink-mute)' }}>{f.label}</div>
            <div style={{ fontSize: 14, fontWeight: 650, marginTop: 2, color: 'var(--gc-ink)' }}>{f.value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 8 }}>
          Ranking points by result
        </div>
        <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--gc-line)' }}>
          {tournament.pointsBreakdown.map((row, i) => {
            const isChampion = row.stageLabel === 'Champion';
            const zero = row.points === 0;
            return (
              <div
                key={row.matchesWon}
                className="flex items-center justify-between px-[12px] py-[7px]"
                style={{
                  borderBottom: i < tournament.pointsBreakdown.length - 1 ? '1px solid var(--gc-line)' : undefined,
                  background: isChampion ? 'linear-gradient(90deg, oklch(92% 0.09 85 / 0.5), transparent)' : undefined,
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: isChampion ? 800 : 550, color: zero ? 'var(--gc-ink-faint)' : 'var(--gc-ink)' }}>
                  {isChampion ? '★ ' : ''}{row.stageLabel}
                </div>
                <div className="[font-variant-numeric:tabular-nums]" style={{ fontSize: 12.5, fontWeight: 750, color: zero ? 'var(--gc-ink-faint)' : th.deep }}>
                  {zero ? 'No points' : `${row.points.toLocaleString()} pts`}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--gc-ink-mute)', marginTop: 7, lineHeight: 1.5 }}>
          Points scale to this tournament's {tournament.drawSize}-player draw. A first-round loss earns nothing — a ranking is earned by winning.
          {tournament.pointsArePlaceholder && ' Note: this tier\u2019s point values are a provisional placeholder, not a sourced figure.'}
          {tournament.obligatory
            ? ' This is a mandatory event: a top-100 player counts it toward their ranking even if they skip it \u2014 a skipped edition records a zero that still uses one of their counted results.'
            : ''}
          {tournament.qualifierSlots > 0
            ? ` Players outside the top 100 aren\u2019t accepted directly here \u2014 they enter the ${tournament.qualifyingDrawSize}-player qualifying draw and must win ${tournament.qualifyingRoundCount} rounds to claim one of the ${tournament.qualifierSlots} reserved main-draw places. Qualifying wins pay only a small amount of points; the real prize is the main-draw place.`
            : ''}
        </div>
      </div>
    </Panel>
  );
}

/** The registered-entrant list — deliberately HUMAN-managed players
 * only (managerId != null). Fill-only/free-agent players that pad a
 * draw at start time are never real "entries" a manager chose, so they
 * never appear here. Rendered before and during the tournament. */
function EntryList({
  tournament,
  players,
  draw = 'main',
}: {
  tournament: TournamentDto;
  players: Map<string, PlayerDto>;
  /** Which field to list. 'qualifying' lists the players still trying to
   * win their way in; 'main' lists the main draw (including any
   * qualifier who already came through, still tagged [Q]). */
  draw?: 'main' | 'qualifying';
}) {
  const humanEntrants = tournament.entrants
    .filter((e) => e.draw === draw)
    .map((e) => ({ entrant: e, player: players.get(e.playerId) }))
    .filter((x): x is { entrant: TournamentDto['entrants'][number]; player: PlayerDto } => !!x.player && x.player.managerId != null)
    .sort((a, b) => {
      if (a.entrant.seed === null && b.entrant.seed === null) return a.player.name.localeCompare(b.player.name);
      if (a.entrant.seed === null) return 1;
      if (b.entrant.seed === null) return -1;
      return a.entrant.seed - b.entrant.seed;
    });

  return (
    <Panel style={{ padding: 18 }}>
      <SectionLabel right={<span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-ink-mute)' }}>{humanEntrants.length}</span>}>
        {draw === 'qualifying' ? 'Qualifying entry list' : 'Entry list'}
      </SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--gc-ink-mute)', marginTop: 4, marginBottom: 10 }}>
        {draw === 'qualifying'
          ? `Players competing for ${tournament.qualifierSlots} main-draw place(s)`
          : 'Players entered by managers'}
        {tournament.hasStarted ? ' — the draw may also include filler players to complete the bracket.' : '.'}
      </div>
      {humanEntrants.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--gc-ink-faint)', padding: '14px 4px' }}>
          No managers have entered a player yet.
        </div>
      ) : (
        <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--gc-line)' }}>
          {humanEntrants.map(({ entrant, player }, i) => (
            <Link
              key={entrant.playerId}
              href={`/players/${encodeURIComponent(entrant.playerId)}`}
              className="flex items-center gap-[10px] px-[12px] py-[8px] no-underline hover:bg-[var(--gc-s3)]"
              style={{ borderBottom: i < humanEntrants.length - 1 ? '1px solid var(--gc-line)' : undefined, color: 'inherit' }}
            >
              <div className="[font-variant-numeric:tabular-nums] flex-none" style={{ width: 26, fontSize: 11, fontWeight: 700, color: 'var(--gc-ink-mute)' }}>
                {entrant.seed ? `#${entrant.seed}` : ''}
              </div>
              <span className="flex-none">{flagFor(player.nationality)}</span>
              <div className="text-[13.5px] font-semibold min-w-0 flex-1 truncate" style={{ color: 'var(--gc-ink)' }}>
                {player.name}
                {entrant.entryType === 'Q' && (
                  <span
                    title="Qualifier — came through qualifying rather than being accepted directly by ranking"
                    style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, color: 'var(--gc-ink-mute)' }}
                  >
                    [Q]
                  </span>
                )}
              </div>
              <div className="text-[11px] flex-none" style={{ color: 'var(--gc-ink-faint)' }}>View →</div>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}


/** The qualifying draw, as a compact results list rather than a second
 * graphical bracket: a qualifying event is a preliminary, and its only
 * outcome that matters to the main draw is WHO came through. Rows link
 * to the replay exactly like a decided main-draw match does, so nothing
 * about it is less inspectable — it just isn't given the same visual
 * weight as the tournament proper. */
function QualifyingPanel({
  tournament,
  players,
  tournamentId,
}: {
  tournament: TournamentDto;
  players: Map<string, PlayerDto>;
  tournamentId: string;
}) {
  const nameOf = (playerId: string) => players.get(playerId)?.name ?? playerId;
  const qualifiers = new Set(
    tournament.entrants.filter((e) => e.draw === 'main' && e.entryType === 'Q').map((e) => e.playerId),
  );

  return (
    <Panel style={{ padding: 18, marginBottom: 24 }}>
      <SectionLabel
        right={
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gc-ink-mute)' }}>
            {tournament.qualifyingComplete ? 'Complete' : 'In progress'}
          </span>
        }
      >
        Qualifying
      </SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--gc-ink-mute)', marginTop: 4, marginBottom: 10, lineHeight: 1.5 }}>
        {tournament.qualifyingDrawSize} players, {tournament.qualifyingRoundCount} rounds, for{' '}
        {tournament.qualifierSlots} main-draw place(s). Played on the tournament's opening days, before the main draw is
        made.
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {tournament.qualifyingRounds.map((round) => {
          const isFinalQualifyingRound = round.roundNumber === tournament.qualifyingRoundCount;
          return (
            <div key={round.roundNumber}>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: '0.4px',
                  textTransform: 'uppercase',
                  color: 'var(--gc-ink-mute)',
                  marginBottom: 6,
                }}
              >
                {isFinalQualifyingRound ? 'Final qualifying round' : `Qualifying round ${round.roundNumber}`}
              </div>
              <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--gc-line)' }}>
                {round.matches.map((match, i) => {
                  const winner = match.outcome?.winner ?? null;
                  const loser = match.outcome?.loser ?? null;
                  const text = match.outcome
                    ? `${nameOf(winner!)} def. ${nameOf(loser!)}`
                    : `${nameOf(match.entrantA)} v ${nameOf(match.entrantB)}`;
                  const score = match.outcome ? formatScoreline(match.outcome.setScores, true) : 'Pending';
                  const cameThrough = winner !== null && qualifiers.has(winner);
                  const row = (
                    <div
                      className="px-[10px] py-[6px] text-[11.5px] flex justify-between gap-2 whitespace-nowrap overflow-hidden"
                      style={{
                        borderBottom: i < round.matches.length - 1 ? '1px solid var(--gc-line)' : undefined,
                        color: match.outcome ? 'var(--gc-ink-dim)' : 'var(--gc-ink-faint)',
                      }}
                    >
                      <span className="overflow-hidden text-ellipsis">
                        {text}
                        {cameThrough && (
                          <span
                            title="Came through qualifying \u2014 promoted into the main draw"
                            style={{ marginLeft: 6, fontWeight: 800, color: 'var(--gc-ink-mute)' }}
                          >
                            [Q]
                          </span>
                        )}
                      </span>
                      <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>
                        {score}
                      </span>
                    </div>
                  );
                  return match.outcome ? (
                    <Link
                      key={i}
                      href={`/replay/${matchIdForSlot(tournamentId, round.roundNumber, i, 'qualifying')}`}
                      className="block no-underline hover:bg-[var(--gc-s3)]"
                      style={{ color: 'inherit' }}
                    >
                      {row}
                    </Link>
                  ) : (
                    <div key={i}>{row}</div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

interface DisplaySlot {
  entrant: Entrant | null;
  isWinner: boolean;
  isLoser: boolean;
  scoreline: string | null;
}

interface DisplayMatch {
  a: DisplaySlot;
  b: DisplaySlot;
  isBye: boolean;
  decided: boolean;
  outcome: MatchOutcomeDto | null;
  /** Real index within that round's dense matches[] array — what the
   * simulate/replay endpoints address by. Only meaningful when this
   * match actually exists server-side (not a not-yet-generated future
   * round placeholder). */
  matchIndex: number | null;
  /** The match's scheduled reveal start (ISO) — null before it's
   * simulated. Drives the "starts in X" countdown and the live/decided
   * transition (see matchRevealSeconds on the tournament). */
  scheduledStartAt: string | null;
  /** Real-time seconds this match's reveal occupies (0 = not scheduled). */
  revealSeconds: number;
}

interface DisplayRound {
  roundNumber: number;
  label: string;
  matches: DisplayMatch[];
  generated: boolean; // false = round hasn't been created server-side yet
}

function buildDisplayRounds(t: TournamentDto): DisplayRound[] {
  const totalRounds = Math.log2(t.drawSize);
  // Main-draw entrants ONLY: a qualifying loser stays in the 'qualifying'
  // draw forever and must never appear in the main bracket's seed order.
  // A non-qualifying tournament has every entrant in 'main', so this
  // filter is a no-op there.
  const seeded = orderBySeed(t.entrants.filter((e) => e.draw === 'main'));
  const slots = seedSlotOrder(t.drawSize);
  const entrantForSlot = (slotSeed: number): Entrant | null => (slotSeed <= seeded.length ? seeded[slotSeed - 1] : null);

  const round1Matches = t.rounds.find((r) => r.roundNumber === 1)?.matches ?? [];

  const slotToDisplay = (entrant: Entrant | null, outcome: MatchOutcomeDto | null): DisplaySlot => {
    if (!entrant) return { entrant: null, isWinner: false, isLoser: false, scoreline: null };
    const isWinner = outcome?.winner === entrant.playerId;
    const isLoser = !!outcome && !isWinner;
    return {
      entrant,
      isWinner,
      isLoser,
      scoreline: outcome ? formatScoreline(outcome.setScores, isWinner) : null,
    };
  };

  const round1: DisplayMatch[] = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = entrantForSlot(slots[i]);
    const b = entrantForSlot(slots[i + 1]);
    if (a && b) {
      const idx = round1Matches.findIndex((m) => m.entrantA === a.playerId && m.entrantB === b.playerId);
      const outcome = idx >= 0 ? round1Matches[idx].outcome : null;
      round1.push({
        a: slotToDisplay(a, outcome),
        b: slotToDisplay(b, outcome),
        isBye: false,
        decided: !!outcome,
        outcome,
        matchIndex: idx >= 0 ? idx : null,
        scheduledStartAt: idx >= 0 ? round1Matches[idx].scheduledStartAt : null,
        revealSeconds: idx >= 0 ? round1Matches[idx].revealSeconds : 0,
      });
    } else if (a || b) {
      const winner = a ?? b;
      round1.push({
        a: slotToDisplay(winner, null),
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: true,
        decided: true,
        outcome: null,
        matchIndex: null,
        scheduledStartAt: null,
        revealSeconds: 0,
      });
    } else {
      round1.push({
        a: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: false,
        decided: false,
        outcome: null,
        matchIndex: null,
        scheduledStartAt: null,
        revealSeconds: 0,
      });
    }
  }

  const rounds: DisplayRound[] = [{ roundNumber: 1, label: roundLabel(round1.length), matches: round1, generated: true }];

  for (let r = 2; r <= totalRounds; r++) {
    const matchCount = t.drawSize / 2 ** r;
    const serverRound = t.rounds.find((rd) => rd.roundNumber === r);
    if (serverRound) {
      const matches: DisplayMatch[] = serverRound.matches.map((m, idx) => ({
        a: slotToDisplay({ playerId: m.entrantA, seed: null }, m.outcome),
        b: slotToDisplay({ playerId: m.entrantB, seed: null }, m.outcome),
        isBye: false,
        decided: !!m.outcome,
        outcome: m.outcome,
        matchIndex: idx,
        scheduledStartAt: m.scheduledStartAt,
        revealSeconds: m.revealSeconds,
      }));
      rounds.push({ roundNumber: r, label: roundLabel(matchCount), matches, generated: true });
    } else {
      const matches: DisplayMatch[] = Array.from({ length: matchCount }, () => ({
        a: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        b: { entrant: null, isWinner: false, isLoser: false, scoreline: null },
        isBye: false,
        decided: false,
        outcome: null,
        matchIndex: null,
        scheduledStartAt: null,
        revealSeconds: 0,
      }));
      rounds.push({ roundNumber: r, label: roundLabel(matchCount), matches, generated: false });
    }
  }

  return rounds;
}

/** A match's reveal state (staggered-schedule feature), driven by its
 * scheduled start + the tournament's fixed reveal window and the current
 * wall-clock time. 'aired' also covers every match without a schedule
 * (not yet simulated, or a pre-feature row) — those are revealed the
 * instant they're decided, exactly as before. */
type AirState = 'upcoming' | 'live' | 'aired';

function matchAirState(m: DisplayMatch, now: number): AirState {
  if (!m.decided || !m.scheduledStartAt) return 'aired';
  const startMs = new Date(m.scheduledStartAt).getTime();
  if (Number.isNaN(startMs)) return 'aired';
  if (now < startMs) return 'upcoming';
  if (now < startMs + m.revealSeconds * 1000) return 'live';
  return 'aired';
}

/** "3:27"-style countdown to a future instant; never negative. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function computeGeometry(counts: number[]) {
  const steps: number[] = [];
  const top0s: number[] = [];
  steps[0] = CARD_H + GAP0;
  top0s[0] = 0;
  for (let r = 1; r < counts.length; r++) {
    steps[r] = steps[r - 1] * 2;
    top0s[r] = top0s[r - 1] + steps[r - 1] / 2;
  }
  return { steps, top0s };
}

// ---------------------------------------------------------------------------

export default function TournamentBracketPage() {
  const params = useParams<{ id: string }>();
  const tournamentId = params.id;
  const [tournament, setTournament] = useState<TournamentDto | null>(null);
  const [players, setPlayers] = useState<Map<string, PlayerDto>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);
  const firedTitleRef = useRef(false);

  // Ticking wall-clock for the staggered-schedule countdowns ("starts in
  // X:XX" → "live" → decided). One cheap 1s interval; only matters while a
  // match is upcoming or live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Doubles solo entry (P7b) — pick one of my players to sign up into
  // this tournament's doubles field (paired at draw formation).
  const devManagerId = process.env.NEXT_PUBLIC_DEV_MANAGER_ID ?? 'seed-m1';
  const [doublesRoster, setDoublesRoster] = useState<RosterDashboardEntryDto[] | null>(null);
  const [doublesPick, setDoublesPick] = useState<string | null>(null);
  const [doublesBusy, setDoublesBusy] = useState(false);
  const [doublesNotice, setDoublesNotice] = useState<string | null>(null);
  const [doublesError, setDoublesError] = useState<string | null>(null);

  const openDoublesEntry = useCallback(async () => {
    setDoublesError(null);
    if (doublesRoster === null) {
      try {
        setDoublesRoster(await fetchRosterDashboard(devManagerId));
      } catch (e) {
        setDoublesError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [devManagerId, doublesRoster]);

  async function submitDoublesEntry() {
    if (!doublesPick) return;
    setDoublesBusy(true);
    setDoublesError(null);
    try {
      await registerDoublesEntrant(tournamentId, doublesPick, devManagerId);
      setDoublesPick(null);
      setDoublesNotice('Player signed up for doubles.');
      await load();
    } catch (e) {
      setDoublesError(e instanceof Error ? e.message : String(e));
    } finally {
      setDoublesBusy(false);
    }
  }

  useEffect(() => {
    fetchWorldClock()
      .then(setWorldClock)
      .catch(() => setWorldClock(null));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await fetchTournament(tournamentId);
      setTournament(t);
      const ids = new Set<string>();
      t.entrants.forEach((e) => ids.add(e.playerId));
      t.rounds.forEach((r) => r.matches.forEach((m) => (ids.add(m.entrantA), ids.add(m.entrantB))));
      t.qualifyingRounds.forEach((r) => r.matches.forEach((m) => (ids.add(m.entrantA), ids.add(m.entrantB))));
      setPlayers(await fetchPlayersByIds(ids));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rounds = useMemo(() => (tournament ? buildDisplayRounds(tournament) : []), [tournament]);
  const accent = tournament ? (SURFACE_COLOR[tournament.surface] ?? 'oklch(50% 0.006 75)') : MUTED;

  const counts = rounds.map((r) => r.matches.length);
  const { steps, top0s } = computeGeometry(counts);
  const totalHeight = counts.length > 0 ? (counts[0] - 1) * steps[0] + CARD_H : 0;
  const positions = rounds.map((round, ri) => round.matches.map((_, i) => top0s[ri] + i * steps[ri]));

  async function onSimulate(roundNumber: number, matchIndex: number) {
    const slot = matchIdForSlot(tournamentId, roundNumber, matchIndex);
    setBusy(slot);
    setError(null);
    try {
      await simulateMatch(tournamentId, roundNumber, matchIndex);
      await load();
      void detectTitle();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Title-win celebration (GC-16): fires from the existing "a champion is
  // decided" signal — the final match transitioning to decided. Re-fetches
  // the tournament fresh (state from load() isn't visible synchronously here),
  // then reads the champion's profile to tell a maiden title from a repeat one
  // (titles.length === 1). fire-once guarded so a reload never re-fires it.
  const detectTitle = useCallback(async () => {
    if (firedTitleRef.current) return;
    try {
      const t = await fetchTournament(tournamentId);
      const dr = buildDisplayRounds(t);
      const fr = dr[dr.length - 1];
      const fm = fr?.matches[0];
      if (!fm?.decided) return;
      const winner = fm.outcome?.winner;
      if (!winner) return;
      firedTitleRef.current = true;
      const [prof, pl] = await Promise.all([
        fetchPlayerProfile(winner).catch(() => null),
        fetchPlayersByIds(new Set([winner])).catch(() => new Map<string, PlayerDto>()),
      ]);
      const name = prof?.name ?? pl.get(winner)?.name ?? winner;
      const nationality = prof?.nationality ?? pl.get(winner)?.nationality ?? '';
      setCelebrations([
        {
          kind: 'title',
          firstCareer: (prof?.titles.length ?? 0) <= 1,
          playerId: winner,
          playerName: name,
          nationality,
          tournamentName: t.name,
          surface: t.surface,
        },
      ]);
    } catch {
      /* celebration is best-effort chrome; never block the bracket on it */
    }
  }, [tournamentId]);

  function playerLabel(entrant: Entrant | null): { name: string; flag: string; seedLabel: string; fillOnly: boolean } {
    if (!entrant) return { name: '', flag: '', seedLabel: '', fillOnly: false };
    const p = players.get(entrant.playerId);
    return {
      name: p?.name ?? entrant.playerId,
      flag: p ? flagFor(p.nationality) : '',
      seedLabel: entrant.seed ? `(${entrant.seed})` : '',
      fillOnly: p?.fillOnly ?? false,
    };
  }

  const overallStatus = useMemo(() => {
    if (!tournament) return '';
    if (!tournament.hasStarted) return 'Registration open — draw not yet made';
    const activeRound = rounds.find((r) => r.generated && r.matches.some((m) => !m.decided));
    if (activeRound) return `${activeRound.label} in progress`;
    const lastGenerated = [...rounds].reverse().find((r) => r.generated);
    if (!lastGenerated) return 'Awaiting entrants';
    if (lastGenerated.roundNumber === rounds.length && lastGenerated.matches.every((m) => m.decided)) {
      return 'Tournament complete';
    }
    return `${lastGenerated.label} complete`;
  }, [tournament, rounds]);

  if (error && !tournament) {
    return (
      <AppFrame>
        <Sidebar active="tournaments" />
        <div className="flex-1 p-8" style={{ background: 'var(--gc-bg)' }}>
          <div className="text-[13px] rounded-[10px] px-4 py-3" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        </div>
      </AppFrame>
    );
  }
  if (!tournament) {
    return (
      <AppFrame>
        <Sidebar active="tournaments" />
        <div className="flex-1 p-8 text-[13.5px]" style={{ background: 'var(--gc-bg)', color: 'var(--gc-ink-mute)' }}>
          Loading bracket…
        </div>
      </AppFrame>
    );
  }

  const finalRound = rounds[rounds.length - 1];
  const champDecided = finalRound?.matches[0]?.decided ?? false;
  const champWinner = champDecided ? finalRound.matches[0].outcome?.winner ?? null : null;
  const champLabel = champWinner ? playerLabel({ playerId: champWinner, seed: null }) : null;
  const finalTop = positions[rounds.length - 1]?.[0] ?? 0;
  const finalMid = finalTop + CARD_H / 2;

  const th = surfaceTheme(tournament.surface);
  const championCopy = champDecided && champLabel
    ? `${champLabel.name} lifts the trophy.`
    : overallStatus;

  return (
    <AppFrame>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}
      <Sidebar active="tournaments" />

      <div className="flex-1 min-w-0" style={{ background: 'var(--gc-bg)', position: 'relative' }}>
        <div style={{ position: 'relative', padding: '30px 34px 60px', maxWidth: 1400, margin: '0 auto' }}>
          <Hero surface={tournament.surface} minHeight={148}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1.5px', textTransform: 'uppercase', padding: '4px 10px', borderRadius: 6, color: 'white', background: `linear-gradient(180deg, ${th.color}, ${th.deep})`, boxShadow: '0 2px 8px oklch(0% 0 0 / 0.3)' }}>
                    {tournament.surface}
                  </div>
                  {tournament.ageBand && (
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', padding: '4px 10px', borderRadius: 6, background: 'oklch(100% 0 0 / 0.16)', color: 'white' }}>
                      {tournament.ageBand}
                    </div>
                  )}
                  {tournament.hostCountry && (
                    <div title="Host country — a player of this nationality has home advantage here" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.5px', padding: '4px 10px', borderRadius: 6, background: 'oklch(100% 0 0 / 0.16)', color: 'white' }}>
                      🏠 {tournament.hostCountry}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 30, fontWeight: 850, letterSpacing: '-0.5px', color: 'white', marginTop: 8, textShadow: '0 2px 10px oklch(0% 0 0 / 0.45)' }}>{tournament.name}</div>
                <div style={{ fontSize: 13.5, color: 'white', opacity: 0.85, marginTop: 4 }}>
                  Single elimination · {tournament.entrants.length} players · {championCopy}
                </div>
                {worldClock && (
                  <div style={{ fontSize: 12, color: 'white', opacity: 0.6, marginTop: 3 }}>
                    Scheduled S{tournament.weekScheduled.season} W{tournament.weekScheduled.week} · now S{worldClock.currentWeek.season} W{worldClock.currentWeek.week}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'white', opacity: 0.9, alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: th.color }} /> Decided path
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.75 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: 'oklch(100% 0 0 / 0.4)' }} /> Pending / TBD
                </div>
                <div style={{ opacity: 0.75 }}>Decided cards link to replay →</div>
              </div>
            </div>
          </Hero>

        {error && (
          <div className="mt-3 text-[13px] rounded-[10px] px-4 py-3" style={{ color: 'oklch(85% 0.12 25)', background: 'oklch(40% 0.12 25 / 0.2)', border: '1px solid oklch(60% 0.15 25 / 0.35)' }}>
            {error}
          </div>
        )}

        {/* Net-line motif divider */}
        <div className="flex items-center gap-0 my-[18px] mb-[22px]">
          <div className="w-px h-[9px]" style={{ background: 'var(--gc-line-hi)' }} />
          <div className="flex-1 h-[1.5px]" style={{ background: 'var(--gc-line)' }} />
          <div className="w-px h-[9px]" style={{ background: 'var(--gc-line-hi)' }} />
          <div className="flex-1 h-[1.5px]" style={{ background: 'var(--gc-line)' }} />
          <div className="w-px h-[9px]" style={{ background: 'var(--gc-line-hi)' }} />
        </div>

        {/* Tournament profile — details + entry list(s). Always available,
            both before the draw is made and while the tournament plays. */}
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)' }}>
          <TournamentDetailsPanel tournament={tournament} />
          <EntryList tournament={tournament} players={players} />
          {tournament.qualifierSlots > 0 && (
            <EntryList tournament={tournament} players={players} draw="qualifying" />
          )}
        </div>

        {/* The qualifying draw itself, once it exists — the compact
            results list of who is winning their way through. Rendered
            above the main bracket (or in place of it, while qualifying
            is still being played and the main draw doesn't exist yet). */}
        {tournament.qualifierSlots > 0 && tournament.hasStarted && (
          <QualifyingPanel tournament={tournament} players={players} tournamentId={tournamentId} />
        )}

        {/* The doubles draw (P7b) — players sign up solo, are paired at
            draw formation, and the top pairs by combined ranking play.
            Compact, like the qualifying panel: the pair list + the
            pair-keyed bracket. */}
        {tournament.doublesDrawSize > 0 && (
          <Panel style={{ padding: 18, marginBottom: 24 }}>
            <SectionLabel
              right={
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gc-ink-mute)' }}>
                  {tournament.doublesComplete
                    ? 'Complete'
                    : tournament.doublesPairs.length > 0
                      ? `${tournament.doublesPairs.length} pairs`
                      : `${tournament.doublesEntrants.length} entrants`}
                </span>
              }
            >
              Doubles
            </SectionLabel>
            <div style={{ fontSize: 11, color: 'var(--gc-ink-mute)', marginTop: 4, marginBottom: 10, lineHeight: 1.5 }}>
              {tournament.doublesDrawSize}-pair draw. Players sign up solo and are paired when the tournament starts — the
              top pairs by combined ranking make the cut.
            </div>
            {!tournament.hasStarted && (
              <div className="flex items-center gap-[10px] flex-wrap" style={{ marginBottom: 10 }}>
                <button
                  onClick={openDoublesEntry}
                  className="rounded-[8px] px-[14px] py-[8px] text-[12.5px] font-extrabold cursor-pointer"
                  style={{ background: 'linear-gradient(180deg, var(--gc-ball), var(--gc-ball-d))', color: 'oklch(22% 0.05 150)', border: '1px solid oklch(100% 0 0 / 0.2)' }}
                >
                  {doublesRoster === null ? 'Enter a player in doubles' : 'Choose a player'}
                </button>
                {doublesRoster !== null && (
                  <>
                    <select className="gc-select" value={doublesPick ?? ''} onChange={(e) => setDoublesPick(e.target.value || null)} style={{ padding: '7px 10px', fontSize: 12.5 }}>
                      <option value="">Select player…</option>
                      {(doublesRoster ?? []).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={submitDoublesEntry}
                      disabled={!doublesPick || doublesBusy}
                      className="rounded-[8px] px-[12px] py-[8px] text-[12px] font-extrabold cursor-pointer disabled:opacity-50"
                      style={{ background: 'var(--gc-s3)', color: 'var(--gc-ink)', border: '1px solid var(--gc-line)' }}
                    >
                      {doublesBusy ? 'Signing up…' : 'Sign up'}
                    </button>
                  </>
                )}
              </div>
            )}
            {doublesError && <div className="text-[12px] mb-[8px]" style={{ color: 'oklch(75% 0.14 25)' }}>{doublesError}</div>}
            {doublesNotice && <div className="text-[12px] mb-[8px]" style={{ color: 'oklch(75% 0.12 150)' }}>{doublesNotice}</div>}
            {tournament.doublesPairs.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--gc-ink-faint)', padding: '10px 4px' }}>
                {tournament.doublesEntrants.length > 0
                  ? `${tournament.doublesEntrants.length} player${tournament.doublesEntrants.length === 1 ? '' : 's'} signed up — the draw is paired when the tournament starts.`
                  : 'No players have signed up for doubles yet.'}
              </div>
            ) : (
              <div className="flex flex-col gap-[6px]">
                {tournament.doublesPairs.map((p) => {
                  const a = players.get(p.playerA)?.name ?? p.playerA;
                  const b = players.get(p.playerB)?.name ?? p.playerB;
                  const ca = players.get(p.playerA);
                  const cb = players.get(p.playerB);
                  return (
                    <div key={p.pairId} className="flex items-center gap-[7px] px-[12px] py-[7px] rounded-[7px] text-[13px]" style={{ border: '1px solid var(--gc-line)', color: 'var(--gc-ink)' }}>
                      {ca && <span className="flex-none">{flagFor(ca.nationality)}</span>} <span className="font-semibold">{a}</span>
                      <span style={{ color: 'var(--gc-ink-mute)' }}>+</span>
                      {cb && <span className="flex-none">{flagFor(cb.nationality)}</span>} <span className="font-semibold">{b}</span>
                      {p.chemistry > 0 && (
                        <span className="ml-auto text-[10.5px] font-bold px-[6px] py-[2px] rounded-[4px]" style={{ background: 'oklch(45% 0.1 150 / 0.3)', color: 'oklch(85% 0.12 150)' }} title="Pair chemistry (built by playing together)">
                          chem {p.chemistry}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {tournament.doublesRounds.length > 0 && (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 12 }}>
                {tournament.doublesRounds.map((round) => {
                  const pairName = (pairId: string) => {
                    const p = tournament.doublesPairs.find((pp) => pp.pairId === pairId);
                    if (!p) return pairId;
                    return `${players.get(p.playerA)?.name ?? p.playerA} + ${players.get(p.playerB)?.name ?? p.playerB}`;
                  };
                  return (
                    <div key={round.roundNumber}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 6 }}>
                        {round.roundNumber === tournament.doublesRounds.length ? 'Doubles final' : `Doubles round ${round.roundNumber}`}
                      </div>
                      {round.matches.map((match, i) => {
                        const winner = match.outcome?.winner ?? null;
                        const text = match.outcome
                          ? `${pairName(winner!)} def. ${pairName(match.outcome!.loser)}`
                          : `${pairName(match.entrantA)} v ${pairName(match.entrantB)}`;
                        const score = match.outcome ? formatScoreline(match.outcome.setScores, true) : 'Pending';
                        return (
                          <div key={i} className="px-[10px] py-[6px] text-[11.5px] flex justify-between gap-2" style={{ borderBottom: i < round.matches.length - 1 ? '1px solid var(--gc-line)' : undefined, color: 'var(--gc-ink-dim)' }}>
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{text}</span>
                            <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>{score}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Doubles qualifying (P8) — the small bracket played on the
                opening days for the reserved main-draw places. */}
            {tournament.doublesQualifyingDrawSize > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gc-ink-mute)', marginBottom: 8 }}>
                  Doubles qualifying · {tournament.doublesQualifierSlots} main-draw place(s) at stake
                  {tournament.doublesQualifyingComplete ? ' · complete' : ''}
                </div>
                {tournament.doublesQualifyingPairs.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--gc-ink-faint)', padding: '6px 2px' }}>
                    Qualifying pairs are formed when the tournament starts.
                  </div>
                ) : (
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                    {tournament.doublesQualifyingRounds.map((round) => {
                      const pairName = (pairId: string) => {
                        const p = tournament.doublesQualifyingPairs.find((pp) => pp.pairId === pairId);
                        if (!p) return pairId;
                        return `${players.get(p.playerA)?.name ?? p.playerA} + ${players.get(p.playerB)?.name ?? p.playerB}`;
                      };
                      return (
                        <div key={round.roundNumber}>
                          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gc-ink-faint)', marginBottom: 5 }}>
                            Q{round.roundNumber}
                          </div>
                          {round.matches.map((match, i) => {
                            const winner = match.outcome?.winner ?? null;
                            const text = match.outcome
                              ? `${pairName(winner!)} def. ${pairName(match.outcome!.loser)}`
                              : `${pairName(match.entrantA)} v ${pairName(match.entrantB)}`;
                            const score = match.outcome ? formatScoreline(match.outcome.setScores, true) : 'Pending';
                            return (
                              <div key={i} className="px-[8px] py-[5px] text-[11px] flex justify-between gap-2" style={{ borderBottom: i < round.matches.length - 1 ? '1px solid var(--gc-line)' : undefined, color: 'var(--gc-ink-dim)' }}>
                                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{text}</span>
                                <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>{score}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </Panel>
        )}

        {!tournament.hasStarted ? (
          <Panel style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>🎾</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gc-ink)' }}>The draw hasn&apos;t been made yet</div>
            <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)', marginTop: 6, lineHeight: 1.5 }}>
              Seeding happens when the tournament starts
              {` — S${tournament.weekScheduled.season} W${tournament.weekScheduled.week}`}
              {worldClock ? ` (now S${worldClock.currentWeek.season} W${worldClock.currentWeek.week})` : ''}.
              Until then, managers can keep entering players above.
            </div>
          </Panel>
        ) : !tournament.hasMainDraw ? (
          <Panel style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>🎾</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--gc-ink)' }}>Qualifying in progress</div>
            <div style={{ fontSize: 13, color: 'var(--gc-ink-mute)', marginTop: 6, lineHeight: 1.5 }}>
              {tournament.qualifyingRoundCount} rounds of qualifying decide who claims the{' '}
              {tournament.qualifierSlots} reserved main-draw place(s). The main draw is made once qualifying is
              complete.
            </div>
          </Panel>
        ) : (
        <div className="overflow-x-auto pb-4">
          <div className="flex items-start" style={{ width: 'max-content' }}>
            {rounds.map((round, ri) => {
              const decidedCount = round.matches.filter((m) => m.decided).length;
              const allDecided = round.generated && decidedCount === round.matches.length;
              const allAired = round.generated && round.matches.every((m) => matchAirState(m, now) === 'aired');
              const noneDecided = decidedCount === 0;
              const statusLabel = !round.generated
                ? 'Upcoming'
                : allAired
                  ? 'Decided'
                  : noneDecided
                    ? 'Upcoming'
                    : allDecided
                      ? 'Airing'
                      : 'In progress';
              const statusBg = allAired ? 'var(--gc-ball)' : noneDecided ? 'transparent' : 'oklch(50% 0.1 60 / 0.3)';
              const statusFg = allAired ? 'oklch(22% 0.05 140)' : noneDecided ? 'var(--gc-ink-mute)' : 'oklch(82% 0.12 70)';
              const subtitle = !round.generated
                ? `${round.matches.length} match${round.matches.length === 1 ? '' : 'es'} scheduled`
                : `${decidedCount} of ${round.matches.length} played`;

              const collapsed = allAired;

              return (
                <div key={round.roundNumber} className="flex items-start">
                  {collapsed ? (
                    <div style={{ width: COLLAPSED_W, flexShrink: 0 }}>
                      <div className="h-14 flex flex-col gap-[5px] px-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-bold">{round.label}</div>
                          <div
                            className="text-[10.5px] font-bold tracking-[0.3px] px-[7px] py-[2px] rounded-[4px]"
                            style={{ background: statusBg, color: statusFg }}
                          >
                            {statusLabel}
                          </div>
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--gc-ink-mute)' }}>
                          {subtitle}
                        </div>
                      </div>
                      <div className="rounded-[8px] overflow-hidden" style={{ background: 'var(--gc-s1)', border: '1px solid var(--gc-line)' }}>
                        {round.matches.map((m, i) => {
                          // A bye has no outcome, so neither side is flagged
                          // `isWinner`; the advancing entrant sits on side `a`
                          // by construction (see the round-1 bye case). Resolve
                          // the winner as: the flagged winner, or (for a bye) the
                          // side that actually holds an entrant.
                          const winnerIsA = m.a.isWinner || (m.isBye && m.a.entrant != null);
                          const winnerLabel = winnerIsA ? playerLabel(m.a.entrant) : playerLabel(m.b.entrant);
                          const loserLabel = winnerIsA ? playerLabel(m.b.entrant) : playerLabel(m.a.entrant);
                          const text = m.isBye ? winnerLabel.name : `${winnerLabel.name} def. ${loserLabel.name}`;
                          const score = m.isBye ? 'Bye' : (m.a.isWinner ? m.a.scoreline : m.b.scoreline) ?? '';
                          const slot = m.matchIndex !== null ? matchIdForSlot(tournamentId, round.roundNumber, m.matchIndex) : null;
                          const row = (
                            <div
                              className="px-[10px] py-[6px] text-[11px] flex justify-between gap-2 whitespace-nowrap overflow-hidden"
                              style={{ borderBottom: i < round.matches.length - 1 ? '1px solid var(--gc-line)' : undefined, color: 'var(--gc-ink-dim)' }}
                            >
                              <span className="overflow-hidden text-ellipsis">{text}</span>
                              <span className="flex-none" style={{ color: 'var(--gc-ink-mute)' }}>
                                {score}
                              </span>
                            </div>
                          );
                          return slot ? (
                            <Link key={i} href={`/replay/${slot}`} className="block no-underline hover:bg-[var(--gc-s3)]" style={{ color: 'inherit' }}>
                              {row}
                            </Link>
                          ) : (
                            <div key={i}>{row}</div>
                          );
                        })}
                      </div>
                      <div className="text-[10.5px] mt-[6px] px-1" style={{ color: 'var(--gc-ink-faint)' }}>
                        Collapses automatically once every match has aired — keeps large draws from growing the page taller.
                      </div>
                    </div>
                  ) : (
                    <div style={{ width: COL_W, flexShrink: 0 }}>
                      <div className="h-14 flex flex-col gap-[5px] px-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-bold">{round.label}</div>
                          <div
                            className="text-[10.5px] font-bold tracking-[0.3px] px-[7px] py-[2px] rounded-[4px]"
                            style={noneDecided ? { border: '1px solid var(--gc-line)', color: statusFg } : { background: statusBg, color: statusFg }}
                          >
                            {statusLabel}
                          </div>
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--gc-ink-mute)' }}>
                          {subtitle}
                        </div>
                      </div>
                      <div className="relative" style={{ height: totalHeight }}>
                        {round.matches.map((m, i) => {
                          const top = positions[ri][i];
                          const aLabel = playerLabel(m.a.entrant);
                          const bLabel = playerLabel(m.b.entrant);
                          const slot = m.matchIndex !== null ? matchIdForSlot(tournamentId, round.roundNumber, m.matchIndex) : null;
                          const canSimulate = !m.isBye && m.a.entrant && m.b.entrant && !m.decided && m.matchIndex !== null;
                          const isBusy = slot !== null && busy === slot;
                          // Staggered-schedule state: a decided match is still
                          // "upcoming" (countdown) or "live" (airing) until its
                          // reveal window has passed; only then is the result shown.
                          const airState = matchAirState(m, now);
                          const revealed = airState === 'aired';

                          const cardInner = (
                            <>
                              {m.isBye && (
                                <div
                                  className="absolute -top-2 right-2 text-[9px] font-bold tracking-[0.4px] uppercase px-[6px] py-[1px] rounded-[3px]"
                                  style={{ background: 'var(--gc-s3)', border: '1px solid var(--gc-line)', color: 'var(--gc-ink-mute)' }}
                                >
                                  Bye
                                </div>
                              )}
                              <div className="flex items-center justify-between px-[10px] py-[7px] flex-1">
                                <div className="flex items-center gap-[7px] min-w-0">
                                  {m.a.entrant ? (
                                    <>
                                      <span className="flex-none">{aLabel.flag}</span>
                                      <div
                                        className="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
                                        style={{
                                          fontWeight: m.a.isWinner && revealed ? 700 : 500,
                                          color: m.a.isWinner && revealed ? 'var(--gc-ink)' : m.a.isLoser && revealed ? 'var(--gc-ink-faint)' : 'var(--gc-ink-dim)',
                                        }}
                                      >
                                        {aLabel.name} <span style={{ color: 'var(--gc-ink-mute)', fontWeight: 400 }}>{aLabel.seedLabel}</span>
                                        {aLabel.fillOnly && (
                                          <span
                                            className="ml-1 text-[9px] font-bold uppercase tracking-[0.3px] px-[5px] py-[1px] rounded-[3px]"
                                            style={{ background: 'var(--gc-s3)', border: '1px solid var(--gc-line)', color: 'var(--gc-ink-mute)' }}
                                            title="A free agent filling out the draw, not a manager's rostered player"
                                          >
                                            Filler
                                          </span>
                                        )}
                                      </div>
                                    </>
                                  ) : (
                                    <div className="text-[13px]" style={{ color: 'var(--gc-ink-faint)' }}>
                                      {m.isBye ? '— No opponent —' : 'TBD'}
                                    </div>
                                  )}
                                </div>
                                {m.a.isWinner && revealed && m.a.scoreline && (
                                  <div className="text-[11px] font-semibold [font-variant-numeric:tabular-nums]" style={{ color: 'var(--gc-ink)' }}>
                                    {m.a.scoreline}
                                  </div>
                                )}
                              </div>
                              <div className="h-px mx-[10px]" style={{ background: 'var(--gc-line)' }} />
                              <div className="flex items-center justify-between px-[10px] py-[7px] flex-1">
                                <div className="flex items-center gap-[7px] min-w-0">
                                  {m.b.entrant ? (
                                    <>
                                      <span className="flex-none">{bLabel.flag}</span>
                                      <div
                                        className="text-[13px] whitespace-nowrap overflow-hidden text-ellipsis"
                                        style={{
                                          fontWeight: m.b.isWinner && revealed ? 700 : 500,
                                          color: m.b.isWinner && revealed ? 'var(--gc-ink)' : m.b.isLoser && revealed ? 'var(--gc-ink-faint)' : 'var(--gc-ink-dim)',
                                        }}
                                      >
                                        {bLabel.name} <span style={{ color: 'var(--gc-ink-mute)', fontWeight: 400 }}>{bLabel.seedLabel}</span>
                                        {bLabel.fillOnly && (
                                          <span
                                            className="ml-1 text-[9px] font-bold uppercase tracking-[0.3px] px-[5px] py-[1px] rounded-[3px]"
                                            style={{ background: 'var(--gc-s3)', border: '1px solid var(--gc-line)', color: 'var(--gc-ink-mute)' }}
                                            title="A free agent filling out the draw, not a manager's rostered player"
                                          >
                                            Filler
                                          </span>
                                        )}
                                      </div>
                                    </>
                                  ) : (
                                    <div className="text-[13px]" style={{ color: 'var(--gc-ink-faint)' }}>
                                      {m.isBye ? '— No opponent —' : 'TBD'}
                                    </div>
                                  )}
                                </div>
                                {m.b.isWinner && revealed && m.b.scoreline && (
                                  <div className="text-[11px] font-semibold [font-variant-numeric:tabular-nums]" style={{ color: 'var(--gc-ink)' }}>
                                    {m.b.scoreline}
                                  </div>
                                )}
                              </div>
                              {airState !== 'aired' && m.decided && (
                                <div
                                  className="flex items-center justify-center gap-[6px] px-[10px] pb-[8px] text-[10.5px] font-bold"
                                  style={{ color: airState === 'live' ? 'oklch(80% 0.16 45)' : 'var(--gc-ink-mute)' }}
                                >
                                  {airState === 'live' ? (
                                    <>
                                      <span className="gc-live-dot" style={{ background: 'oklch(70% 0.17 45)' }} />
                                      Live now — follow
                                    </>
                                  ) : (
                                    <>Starts in {formatCountdown(new Date(m.scheduledStartAt!).getTime() - now)}</>
                                  )}
                                </div>
                              )}
                              {canSimulate && (
                                <div className="px-[10px] pb-[8px]">
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      void onSimulate(round.roundNumber, m.matchIndex!);
                                    }}
                                    disabled={isBusy}
                                    className="w-full border-none py-[5px] rounded-[5px] text-[10.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-60"
                                    style={{ background: 'var(--gc-ball)', color: 'oklch(22% 0.05 140)' }}
                                  >
                                    {isBusy ? 'Simulating…' : 'Simulate'}
                                  </button>
                                </div>
                              )}
                            </>
                          );

                          const cardStyle: React.CSSProperties = {
                            position: 'absolute',
                            top,
                            left: 0,
                            width: COL_W,
                            minHeight: CARD_H,
                            background: 'var(--gc-s1)',
                            border: '1px solid var(--gc-line)',
                            borderTop: `3px solid ${accent}`,
                            borderRadius: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                          };

                          return slot && m.decided ? (
                            <Link
                              key={i}
                              href={`/replay/${slot}`}
                              className="block no-underline hover:opacity-95"
                              style={{ ...cardStyle, color: 'inherit', cursor: 'pointer' }}
                            >
                              {cardInner}
                            </Link>
                          ) : (
                            <div key={i} className="relative" style={cardStyle}>
                              {cardInner}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Gutter to next column */}
                  {ri < rounds.length - 1 && (
                    <div style={{ width: GUT_W, flexShrink: 0 }}>
                      <div className="h-14" />
                      <div className="relative" style={{ height: totalHeight }}>
                        {collapsed || !rounds[ri + 1].generated ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: GUT_W,
                              height: totalHeight,
                              background: accent,
                              opacity: 0.35,
                              clipPath: 'polygon(0 8%, 100% 38%, 100% 62%, 0 92%)',
                            }}
                          />
                        ) : (
                          round.matches.map((_, i) => {
                            if (i % 2 !== 0) return null;
                            const midA = positions[ri][i] + CARD_H / 2;
                            const midB = positions[ri][i + 1] + CARD_H / 2;
                            const midTarget = positions[ri + 1][i / 2] + CARD_H / 2;
                            const aDecided = round.matches[i].decided;
                            const bDecided = round.matches[i + 1]?.decided ?? false;
                            const gmid = GUT_W / 2;
                            const colA = aDecided ? accent : MUTED;
                            const colB = bDecided ? accent : MUTED;
                            const colTarget = aDecided && bDecided ? accent : MUTED;
                            return (
                              <div key={i}>
                                <div style={{ position: 'absolute', left: 0, top: midA - 1, width: gmid, height: 2, background: colA }} />
                                <div style={{ position: 'absolute', left: 0, top: midB - 1, width: gmid, height: 2, background: colB }} />
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: gmid - 1,
                                    top: Math.min(midA, midB),
                                    width: 2,
                                    height: Math.abs(midB - midA),
                                    background: colTarget,
                                  }}
                                />
                                <div style={{ position: 'absolute', left: gmid, top: midTarget - 1, width: gmid, height: 2, background: colTarget }} />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Champion */}
            {rounds.length > 0 && (
              <div className="flex items-start">
                <div style={{ width: GUT_W, flexShrink: 0 }}>
                  <div className="h-14" />
                  <div className="relative" style={{ height: totalHeight }}>
                    <div style={{ position: 'absolute', left: 0, top: finalMid - 1, width: GUT_W, height: 2, background: champDecided ? accent : MUTED }} />
                  </div>
                </div>
                <div style={{ width: COL_W, flexShrink: 0 }}>
                  <div className="h-14 flex items-start px-1">
                    <div className="text-[13px] font-bold">Champion</div>
                  </div>
                  <div className="relative" style={{ height: totalHeight }}>
                    <div
                      style={{
                        position: 'absolute',
                        top: finalTop,
                        left: 0,
                        width: COL_W,
                        minHeight: CARD_H,
                        background: champDecided ? 'linear-gradient(135deg, oklch(35% 0.06 85), oklch(24% 0.04 85))' : 'var(--gc-s1)',
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: champDecided ? `1px solid var(--gc-gold)` : '1.5px dashed var(--gc-line)',
                        boxShadow: champDecided ? '0 6px 20px oklch(0% 0 0 / 0.4)' : 'none',
                      }}
                    >
                      {champDecided && champLabel ? (
                        <div className="flex flex-col items-center gap-1 p-3 text-center">
                          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--gc-gold)' }}>★ Champion</div>
                          <div className="flex items-center gap-2">
                            <span>{champLabel.flag}</span>
                            <div className="font-bold text-[15px]" style={{ color: 'white' }}>{champLabel.name}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[12px] font-semibold tracking-[0.4px] uppercase" style={{ color: 'var(--gc-ink-faint)' }}>
                          TBD
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        )}
        </div>
      </div>
    </AppFrame>
  );
}
