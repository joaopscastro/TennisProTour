'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { MatchLogDto } from '../lib/api';
import { activeSetTag, replayOverlayCopy, replayScoreVisible, replayStartOffset } from '../lib/matchAir';
import { Flag } from './ui/Flag';
import { Icon } from './ui/Icon';

/**
 * The "fake live" replay player — CLAUDE.md principle #4 made
 * visible, and docs/ui-direction.md's most distinctive screen. The
 * whole match was simulated server-side long before this component
 * mounted; what it receives is one immutable JSON blob fetched over
 * plain HTTP. Everything here that feels alive — the ticking clock,
 * points and games arriving one by one, the commentary feed — is
 * manufactured client-side by advancing a local timer through the
 * log's offsetSeconds. No WebSocket, no SSE, no polling.
 *
 * Direction A (design/prototypes/a-broadcast-telemetry.html): the
 * scoreboard is the prototype's `.gc-scoreboard` — player names in the
 * display face, per-set mono numerals, a per-side Winner mark — and the
 * playback controls are flat `.gc-btn` / segmented-tab chrome. Values
 * snap as the replay advances; the reveal logic itself (the wall-clock
 * "Premiere" edge, the shared air-state predicate, the commentary
 * derivation) is unchanged.
 *
 * Never say "live": this is a replay of an already-decided result,
 * wall-clock-synced to a scheduled "premiere," not a real broadcast —
 * see the PREMIERE labeling and "Replay in progress" status text
 * throughout.
 */

// Game-seconds per wall-clock second, labeled by estimated watch time
// rather than the raw internal multiplier (docs/ui-direction.md: "an
// implementation detail and shouldn't leak into button labels").
const SPEEDS = [
  { multiplier: 120, label: 'Normal (~40s)' },
  { multiplier: 240, label: 'Fast (~20s)' },
  { multiplier: 960, label: 'Very fast (~5s)' },
] as const;

/** Neutral surface colour when the caller has none to hand. */
const DEFAULT_SURFACE = 'var(--clay)';

/** The wall-clock-synced "Premiere" live edge: in-game seconds since
 * `simulatedAt`, capped to the match's actual length. A missing/
 * unparseable `simulatedAt` is treated as "already fully aired." */
function computeLiveEdgeSeconds(simulatedAt: string, totalDurationSeconds: number, now: number = Date.now()): number {
  const simulatedAtMs = new Date(simulatedAt).getTime();
  if (Number.isNaN(simulatedAtMs)) return totalDurationSeconds;
  const realElapsedSeconds = (now - simulatedAtMs) / 1000;
  return Math.min(Math.max(realElapsedSeconds, 0), totalDurationSeconds);
}

interface Moment {
  offsetSeconds: number;
  type: 'break' | 'tiebreak' | 'set' | 'match';
  text: string;
}

/** A completed game is a break of serve exactly when its winner isn't
 * who served it — mirrors the domain's isBreakOfServe
 * (packages/domain/src/competition/CompetitionTypes.ts). The frontend
 * can't import that directly (it talks HTTP only, never
 * domain/application code — see lib/api.ts), but the predicate itself
 * is a one-line comparison of two fields the API already ships, not a
 * business rule worth re-deriving server-side. Excludes a
 * tiebreak-decided game (score 7-6/6-7 — the simulator only ever
 * reaches a tiebreak at 6-6, so that score uniquely identifies one):
 * "break" isn't a meaningful concept there since service rotates
 * every 2 points within a breaker. */
function isNotableBreakOfServe(entry: MatchLogDto['entries'][number]): boolean {
  const isTiebreakEntry = (entry.gamesForA === 7 && entry.gamesForB === 6) || (entry.gamesForA === 6 && entry.gamesForB === 7);
  return !isTiebreakEntry && entry.wonBy !== entry.server;
}

/** Curated, sparse commentary — breaks/set-ends/tiebreaks/match point,
 * not a full point-by-point transcript (docs/ui-direction.md). Break
 * moments come from `entries` (the game-level rollup — break-of-serve
 * is inherently a per-game concept, not per-point); set/match moments
 * from the same rollup; tiebreak moments from `points`. */
function deriveMoments(log: MatchLogDto, aName: string, bName: string): Moment[] {
  const moments: Moment[] = [];
  const seenTiebreak = new Set<string>();

  for (const pt of log.points) {
    const key = `${pt.setNumber}-${pt.gameNumber}`;
    if (pt.gameNumber === 13 && !seenTiebreak.has(key)) {
      seenTiebreak.add(key);
      moments.push({ offsetSeconds: pt.offsetSeconds, type: 'tiebreak', text: `Set ${pt.setNumber} heads to a tiebreak.` });
    }
  }

  for (const entry of log.entries) {
    if (isNotableBreakOfServe(entry)) {
      const winnerName = entry.wonBy === 'A' ? aName : bName;
      moments.push({
        offsetSeconds: entry.offsetSeconds,
        type: 'break',
        text: `BREAK. ${winnerName} breaks serve — ${entry.gamesForA}-${entry.gamesForB} in set ${entry.setNumber}.`,
      });
    }
  }

  if (log.entries.length > 0) {
    const maxSet = Math.max(...log.entries.map((e) => e.setNumber));
    const lastEntryBySet = new Map<number, MatchLogDto['entries'][number]>();
    for (const e of log.entries) lastEntryBySet.set(e.setNumber, e);

    for (const [setNumber, entry] of lastEntryBySet) {
      const winnerName = entry.wonBy === 'A' ? aName : bName;
      if (setNumber === maxSet) {
        const finalScore = formatMatchScoreline(log, entry.wonBy);
        moments.push({ offsetSeconds: entry.offsetSeconds, type: 'match', text: `${winnerName} wins the match, ${finalScore}.` });
      } else {
        moments.push({
          offsetSeconds: entry.offsetSeconds,
          type: 'set',
          text: `${winnerName} takes set ${setNumber}, ${entry.gamesForA}-${entry.gamesForB}${tiebreakSuffix(log, setNumber, entry.wonBy)}.`,
        });
      }
    }
  }

  return moments.sort((a, b) => a.offsetSeconds - b.offsetSeconds);
}

/** The final tiebreak score for a set, if its deciding game was a
 * tiebreak (gameNumber 13) — derived from the last point recorded for
 * that game: its pointScoreA/B is the score BEFORE that point, so the
 * winner's final tally is one more, the loser's stays put. Returns
 * null when the set wasn't decided by a tiebreak. */
function tiebreakFinal(log: MatchLogDto, setNumber: number): { winner: number; loser: number } | null {
  const tiebreakPoints = log.points.filter((p) => p.setNumber === setNumber && p.gameNumber === 13);
  if (tiebreakPoints.length === 0) return null;
  const last = tiebreakPoints[tiebreakPoints.length - 1];
  const a = Number(last.pointScoreA);
  const b = Number(last.pointScoreB);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return last.wonBy === 'A' ? { winner: a + 1, loser: b } : { winner: b + 1, loser: a };
}

function tiebreakSuffix(log: MatchLogDto, setNumber: number, setWonBy: 'A' | 'B'): string {
  const tb = tiebreakFinal(log, setNumber);
  return tb ? ` (${tb.loser})` : '';
}

/** Full match scoreline from the match winner's perspective, e.g.
 * "6-4, 3-6, 7-6(4)" — same "winner's games first, always" convention
 * as the roster/bracket screens' tennis notation. */
function formatMatchScoreline(log: MatchLogDto, matchWinner: 'A' | 'B'): string {
  const lastEntryBySet = new Map<number, MatchLogDto['entries'][number]>();
  for (const e of log.entries) lastEntryBySet.set(e.setNumber, e);
  const sets = [...lastEntryBySet.entries()].sort(([a], [b]) => a - b);
  return sets
    .map(([setNumber, entry]) => {
      const winnerGames = matchWinner === 'A' ? entry.gamesForA : entry.gamesForB;
      const loserGames = matchWinner === 'A' ? entry.gamesForB : entry.gamesForA;
      return `${winnerGames}-${loserGames}${tiebreakSuffix(log, setNumber, entry.wonBy)}`;
    })
    .join(', ');
}

function pointLabel(a: string, b: string, aName: string, bName: string): { label: string; state: 'normal' | 'deuce' | 'advantage' } {
  if (a === '40' && b === '40') return { label: `40–40 · Deuce`, state: 'deuce' };
  if (a === 'Ad') return { label: `Advantage · ${aName}`, state: 'advantage' };
  if (b === 'Ad') return { label: `Advantage · ${bName}`, state: 'advantage' };
  return { label: `${a}–${b}`, state: 'normal' };
}

interface Props {
  log: MatchLogDto;
  playerAName: string;
  playerBName: string;
  /** Two-letter nationality codes — rendered as the Direction A `Flag`. */
  playerANationality?: string;
  playerBNationality?: string;
  surfaceColor?: string;
  backToBracketHref?: string;
  nextReplayHref?: string;
  nextRoundHref?: string;
  nextRoundLabel?: string;
  /** Whether the match's staggered "Premiere" has started/ended — the SAME
   * predicate the bracket uses (lib/matchAir.ts), so the replay and the
   * bracket never disagree about "has this aired". Optional so a bare
   * player (no tournament context) still renders; defaults to 'upcoming'. */
  airState?: 'upcoming' | 'live' | 'aired';
  /** The match's scheduled premiere start (ISO), when known. */
  scheduledStartAt?: string | null;
}

export function MatchReplayPlayer({
  log,
  playerAName,
  playerBName,
  playerANationality,
  playerBNationality,
  surfaceColor = DEFAULT_SURFACE,
  backToBracketHref,
  nextReplayHref,
  nextRoundHref,
  nextRoundLabel,
  airState = 'upcoming',
  scheduledStartAt = null,
}: Props) {
  const [started, setStarted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]['multiplier']>(SPEEDS[0].multiplier);
  const [playing, setPlaying] = useState(false);
  // Ticking wall-clock so the live edge re-evaluates as the reveal progresses
  // (and, critically, so it stops being a value frozen at mount — see below).
  const [clock, setClock] = useState(() => Date.now());
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The wall-clock live edge, derived from the SAME air state the bracket and
  // replay share. Once the match has AIRED the whole replay is available (the
  // result is already public on the bracket), so the edge is the full duration
  // and the skip/scrub controls work. Deriving it — rather than freezing it at
  // mount — is the fix for a replay that said "Aired … already decided" while
  // every control stayed disabled because the edge was captured mid-reveal.
  const liveEdgeSeconds =
    airState === 'aired'
      ? log.totalDurationSeconds
      : computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds, clock);

  const finished = elapsed >= log.totalDurationSeconds;
  const caughtUp = started && !finished && elapsed >= liveEdgeSeconds;
  // When a match has already AIRED its result is public everywhere (the
  // bracket shows it), so the scoreboard renders the final score
  // immediately instead of a row of "–" that contradicts the "Aired …
  // Result already decided" overlay. Before it airs (upcoming/live) nothing
  // is revealed — that honesty is unchanged. Pure predicate lives in
  // lib/matchAir so the rule is unit-pinned.
  const showFinalScore = replayScoreVisible(finished, airState, started);

  useEffect(() => {
    if (!playing || finished) return;
    const interval = setInterval(() => {
      const edge =
        airState === 'aired'
          ? log.totalDurationSeconds
          : computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds);
      setElapsed((current) => Math.min(current + 0.1 * speedRef.current, log.totalDurationSeconds, edge));
    }, 100);
    return () => clearInterval(interval);
  }, [playing, finished, log.simulatedAt, log.totalDurationSeconds, airState]);

  const moments = useMemo(() => deriveMoments(log, playerAName, playerBName), [log, playerAName, playerBName]);
  const visibleMoments = useMemo(() => moments.filter((m) => m.offsetSeconds <= elapsed).slice().reverse(), [moments, elapsed]);

  const setNumbers = [1, 2, 3];
  const visibleEntries = useMemo(() => log.entries.filter((e) => e.offsetSeconds <= elapsed), [log.entries, elapsed]);

  const setCells = setNumbers.map((setNumber) => {
    const scoreEntries = showFinalScore ? log.entries : visibleEntries;
    const laterSetVisible = scoreEntries.some((e) => e.setNumber > setNumber);
    const completed = laterSetVisible || (showFinalScore && setNumber === setNumbers[setNumbers.length - 1]);
    const entriesForSet = (completed ? log.entries : scoreEntries).filter((e) => e.setNumber === setNumber);
    const last = entriesForSet[entriesForSet.length - 1];
    const active = !completed && !!last;
    const tb = completed ? tiebreakFinal(log, setNumber) : null;
    return {
      setNumber,
      completed,
      active,
      gamesForA: last?.gamesForA,
      gamesForB: last?.gamesForB,
      tieLoserPoints: tb?.loser ?? null,
    };
  });

  const nextPointIdx = log.points.findIndex((p) => p.offsetSeconds > elapsed);
  const currentPoint = started && !finished && nextPointIdx >= 0 ? log.points[nextPointIdx] : null;

  const overallWinnerSide = log.entries.length > 0 ? log.entries[log.entries.length - 1].wonBy : null;
  // The Winner mark (and the final score) only appear once the result is
  // visible — the same `showFinalScore` predicate the set numerals read.
  const winnerSide = showFinalScore ? overallWinnerSide : null;

  function jumpTo(offset: number) {
    setPlaying(false);
    const cap = Math.min(log.totalDurationSeconds, liveEdgeSeconds);
    setElapsed(Math.max(0, Math.min(cap, offset)));
  }
  function prevMoment() {
    const prior = [...moments].reverse().find((m) => m.offsetSeconds < elapsed - 0.05);
    jumpTo(prior ? prior.offsetSeconds : 0);
  }
  function nextMoment() {
    const cap = Math.min(log.totalDurationSeconds, liveEdgeSeconds);
    const next = moments.find((m) => m.offsetSeconds > elapsed + 0.05 && m.offsetSeconds <= cap);
    jumpTo(next ? next.offsetSeconds : cap);
  }

  // Status as a badge: the caught-up state carries the pulsing dot (it is
  // waiting on the premiere's next point); an active replay carries a
  // surface-coloured one. The words stay exactly as they were — this screen
  // never claims to be "live".
  let statusLabel: string;
  let statusDot: 'pulse' | 'static' | null = null;
  let statusWarn = false;
  if (!started) {
    statusLabel = 'Ready to watch';
  } else if (finished) {
    statusLabel = 'Replay complete';
  } else if (caughtUp) {
    statusLabel = "You're caught up — waiting for the next point";
    statusWarn = true;
    statusDot = 'pulse';
  } else {
    statusLabel = playing ? 'Replay in progress' : 'Replay paused';
    statusDot = playing ? 'pulse' : 'static';
  }

  const premiereTime = new Date(scheduledStartAt ?? log.simulatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // One predicate, three honest wordings — and crucially the note only claims
  // "Result already decided" once the match has AIRED, never alongside a
  // live/upcoming "premiere" (the exact "PREMIERING NOW · RESULT ALREADY
  // DECIDED" contradiction). See lib/matchAir.ts.
  const overlay = replayOverlayCopy(airState, premiereTime);

  const activeTag = activeSetTag(airState);

  return (
    <div>
      <div style={{ position: 'relative' }}>
        {/* Status strip */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <span
            data-testid="replay-status"
            className="gc-badge"
            style={statusWarn ? { color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' } : undefined}
          >
            {statusDot === 'pulse' && (
              <span className="gc-live-dot" style={{ background: statusWarn ? 'var(--warn)' : surfaceColor }} />
            )}
            {statusDot === 'static' && (
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: surfaceColor, display: 'inline-block', flex: '0 0 auto' }} />
            )}
            {statusLabel}
          </span>
          <span className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {started ? `${visibleEntries.length} of ${log.entries.length} games` : `${log.entries.length} games simulated`}
          </span>
        </div>

        {/* Broadcast scoreboard — 1fr auto 1fr: left player, sets, right player. */}
        <div className="gc-scoreboard" data-testid="set-scoreboard">
          <div className="gc-sb-side">
            <div className="gc-sb-name">
              {playerANationality && <Flag code={playerANationality} size={22} />}
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playerAName}</span>
            </div>
            {winnerSide === 'A' && (
              <div className="gc-sb-winner"><Icon name="check" size={14} /> Winner</div>
            )}
          </div>

          <div className="gc-sb-sets">
            {setCells.map((c) => {
              const unrevealed = !c.completed && !c.active;
              const aLostSet = c.completed && (c.gamesForA ?? 0) < (c.gamesForB ?? 0);
              const bLostSet = c.completed && (c.gamesForB ?? 0) < (c.gamesForA ?? 0);
              return (
                <div key={c.setNumber} className="gc-sb-set">
                  <span className={`g${aLostSet ? ' lose' : ''}`} style={unrevealed ? { color: 'var(--ink-4)' } : undefined}>
                    {c.gamesForA ?? '–'}
                    {c.completed && c.tieLoserPoints !== null && overallWinnerSide === 'A' && (
                      <sup style={{ fontSize: 12, marginLeft: 2 }}>{c.tieLoserPoints}</sup>
                    )}
                  </span>
                  <span className={`g${bLostSet ? ' lose' : ''}`} style={unrevealed ? { color: 'var(--ink-4)' } : undefined}>
                    {c.gamesForB ?? '–'}
                    {c.completed && c.tieLoserPoints !== null && overallWinnerSide === 'B' && (
                      <sup style={{ fontSize: 12, marginLeft: 2 }}>{c.tieLoserPoints}</sup>
                    )}
                  </span>
                  <span className="sl" style={c.active ? { color: 'var(--accent)' } : undefined}>
                    SET {c.setNumber}{c.active && activeTag ? ` · ${activeTag}` : ''}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="gc-sb-side right">
            <div className="gc-sb-name">
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playerBName}</span>
              {playerBNationality && <Flag code={playerBNationality} size={22} />}
            </div>
            {winnerSide === 'B' && (
              <div className="gc-sb-winner"><Icon name="check" size={14} /> Winner</div>
            )}
          </div>
        </div>

        {currentPoint && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="t-label" style={{ fontSize: 10 }}>Current game</span>
            {(() => {
              const pl = pointLabel(currentPoint.pointScoreA, currentPoint.pointScoreB, playerAName, playerBName);
              const isAdvantage = pl.state === 'advantage';
              return (
                <span
                  className="mono"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    padding: '3px 10px',
                    borderRadius: 'var(--r2)',
                    border: '1px solid var(--hair)',
                    fontWeight: pl.state === 'normal' ? 600 : 700,
                    // Deuce is the level state (neutral `--bg-4`); an advantage
                    // is point-deciding, so it wears the warn tint. The two must
                    // stay visually distinct — replay.spec.ts compares their
                    // computed backgrounds.
                    background: isAdvantage ? 'color-mix(in srgb, var(--warn) 22%, var(--bg-3))' : 'var(--bg-4)',
                    color: isAdvantage ? 'var(--warn)' : 'var(--ink-2)',
                  }}
                  data-testid="current-point"
                >
                  {pl.label}
                </span>
              );
            })()}
          </div>
        )}

        {!started && (
          <div className="gc-slate">
            <div className="t-label" style={{ color: 'var(--accent)', fontSize: 12 }}>{overlay.headline}</div>
            {overlay.note && (
              <div className="t-body-sm" style={{ fontSize: 12 }}>{overlay.note}</div>
            )}
            {/* Aired matches already show this result on the bracket, so
                state the final score here too rather than faking suspense
                the viewer can see through. Nothing is revealed pre-premiere. */}
            {airState === 'aired' && overallWinnerSide && (
              <div className="t-h3" style={{ fontSize: 22 }}>
                {overallWinnerSide === 'A' ? playerAName : playerBName} won {formatMatchScoreline(log, overallWinnerSide)}
              </div>
            )}
            <div className="t-body-sm" style={{ maxWidth: 420, lineHeight: 1.55 }}>
              {airState === 'aired'
                ? 'This match was simulated in full ahead of time and has already aired. Press play to watch it from the start — or skip ahead any time.'
                : 'This match was simulated in full ahead of time. Press play to watch it unfold in sync with its scheduled slot — you can skip ahead to catch up any time.'}
            </div>
            <button
              onClick={() => {
                setStarted(true);
                setPlaying(true);
                // Join at the live edge ONLY while the match is still airing
                // (a viewer arriving mid-reveal catches up); an aired match
                // starts from the beginning. Same air-state predicate as
                // everywhere else — see replayStartOffset.
                setElapsed(replayStartOffset(airState, liveEdgeSeconds, log.totalDurationSeconds));
              }}
              className="gc-btn gc-btn--primary"
            >
              <Icon name="play" size={13} />
              Watch replay
            </button>
          </div>
        )}
      </div>

      {/* PLAYBACK CONTROLS */}
      {started && (
        <div className="gc-panel" style={{ marginTop: 16, padding: '14px 16px' }}>
          <div style={{ position: 'relative', height: 20, marginBottom: 8 }} data-testid="scrub-bar">
            <input
              type="range"
              min={0}
              max={log.totalDurationSeconds}
              step={0.1}
              value={elapsed}
              onChange={(e) => jumpTo(Number(e.target.value))}
              className="w-full absolute top-[5px] m-0"
              style={{ accentColor: surfaceColor }}
            />
            {moments.map((m, i) => (
              <div
                key={i}
                style={{ position: 'absolute', top: 0, width: 2, height: 8, left: `${(m.offsetSeconds / log.totalDurationSeconds) * 100}%`, background: 'var(--accent)', transform: 'translateX(-1px)' }}
                data-testid="scrub-tick"
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                disabled={finished}
                className="gc-btn"
                aria-label={playing ? 'Pause' : 'Play'}
                title={playing ? 'Pause' : 'Play'}
              >
                <Icon name={playing ? 'pause' : 'play'} size={14} />
              </button>
              <button type="button" onClick={prevMoment} className="gc-btn gc-btn--ghost">
                ← Prev moment
              </button>
              <button type="button" onClick={nextMoment} disabled={caughtUp} className="gc-btn gc-btn--ghost">
                Next moment →
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="t-label" style={{ fontSize: 10, margin: 0 }}>Speed</span>
              <div className="gc-tabs gc-tabs--segmented" role="group" aria-label="Playback speed">
                {SPEEDS.map(({ multiplier, label }) => (
                  <button
                    key={multiplier}
                    type="button"
                    onClick={() => !caughtUp && setSpeed(multiplier)}
                    disabled={caughtUp}
                    aria-pressed={speed === multiplier}
                    className={`gc-tab${!caughtUp && speed === multiplier ? ' is-active' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => jumpTo(liveEdgeSeconds)}
                disabled={caughtUp}
                className="gc-btn gc-btn--ghost"
                style={{ marginLeft: 4 }}
              >
                {caughtUp ? 'Caught up' : 'Skip to now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MATCH COMPLETE BANNER */}
      {finished && (
        <div
          className="gc-band"
          data-testid="completion-banner"
          style={{ marginTop: 16, ['--surf' as string]: 'var(--win)', gap: 16 }}
        >
          <div style={{ minWidth: 220 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {overallWinnerSide === 'A' ? playerAName : playerBName} wins {formatMatchScoreline(log, overallWinnerSide ?? 'A')}
            </div>
            <div className="t-body-sm" style={{ fontSize: 12, marginTop: 3 }}>
              Replay complete{nextRoundLabel ? ` · advances to ${nextRoundLabel}` : ''}
            </div>
          </div>
          <div className="gc-band-meta" style={{ gap: 8 }}>
            {backToBracketHref && (
              <Link href={backToBracketHref} className="gc-btn">
                Back to bracket
              </Link>
            )}
            {(nextReplayHref || nextRoundHref) && nextRoundLabel && (
              <Link href={nextReplayHref ?? nextRoundHref!} className="gc-btn gc-btn--primary">
                View {nextRoundLabel} →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* COMMENTARY FEED */}
      <div style={{ marginTop: 16 }} data-testid="commentary-feed">
        <div className="t-label" style={{ marginBottom: 8 }}>Commentary</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', paddingRight: 4, maxHeight: 360 }}>
          {visibleMoments.map((m, i) => {
            const accent = m.type === 'match' ? 'var(--accent)' : m.type === 'tiebreak' ? 'var(--hard)' : m.type === 'set' ? 'var(--ink-4)' : surfaceColor;
            return (
              <div
                key={i}
                style={{ display: 'flex', gap: 12, padding: '8px 12px', borderRadius: '0 var(--r2) var(--r2) 0', borderLeft: `3px solid ${accent}`, background: 'var(--bg-2)' }}
              >
                <div className="num" style={{ fontSize: 11, color: 'var(--ink-3)', minWidth: 44 }}>
                  {formatElapsed(m.offsetSeconds)}
                </div>
                <div className="t-body-sm" style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                  {m.text}
                </div>
              </div>
            );
          })}
          {visibleMoments.length === 0 && (
            <div className="t-body-sm" style={{ padding: '10px 0' }}>
              {started ? 'Nothing notable yet — keep watching' : 'Commentary will appear here once you press play.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
