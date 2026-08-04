'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { MatchLogDto } from '../lib/api';

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

const ACCENT = 'oklch(58% 0.14 45)';
const DARK = 'oklch(20% 0.006 75)';

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
  type: 'deuce' | 'tiebreak' | 'set' | 'match';
  text: string;
}

/** Curated, sparse commentary — breaks/set-ends/tiebreaks/match point,
 * not a full point-by-point transcript (docs/ui-direction.md). Real
 * "break of serve" detection isn't possible: MatchLog carries no
 * server field, so "reached deuce" stands in as this replay's
 * tension-worthy sub-game moment instead. Set/match moments are
 * derived from `entries` (the game-level rollup, which the domain
 * guarantees ends exactly on the set/match-clinching game), tiebreak
 * and deuce moments from `points`. */
function deriveMoments(log: MatchLogDto, aName: string, bName: string): Moment[] {
  const moments: Moment[] = [];
  const seenDeuce = new Set<string>();
  const seenTiebreak = new Set<string>();

  for (const pt of log.points) {
    const key = `${pt.setNumber}-${pt.gameNumber}`;
    if (pt.gameNumber === 13 && !seenTiebreak.has(key)) {
      seenTiebreak.add(key);
      moments.push({ offsetSeconds: pt.offsetSeconds, type: 'tiebreak', text: `Set ${pt.setNumber} heads to a tiebreak.` });
    } else if (pt.pointScoreA === '40' && pt.pointScoreB === '40' && !seenDeuce.has(key)) {
      seenDeuce.add(key);
      moments.push({ offsetSeconds: pt.offsetSeconds, type: 'deuce', text: `Deuce, set ${pt.setNumber} game ${pt.gameNumber}.` });
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

function pointLabel(a: string, b: string, aName: string, bName: string): { label: string; tense: boolean } {
  if (a === '40' && b === '40') return { label: `40–40 · Deuce`, tense: true };
  if (a === 'Ad') return { label: `Advantage · ${aName}`, tense: true };
  if (b === 'Ad') return { label: `Advantage · ${bName}`, tense: true };
  return { label: `${a}–${b}`, tense: false };
}

interface Props {
  log: MatchLogDto;
  playerAName: string;
  playerBName: string;
  playerAFlag?: string;
  playerBFlag?: string;
  surfaceColor?: string;
  backToBracketHref?: string;
  nextReplayHref?: string;
  nextRoundLabel?: string;
}

export function MatchReplayPlayer({
  log,
  playerAName,
  playerBName,
  playerAFlag,
  playerBFlag,
  surfaceColor = ACCENT,
  backToBracketHref,
  nextReplayHref,
  nextRoundLabel,
}: Props) {
  const [started, setStarted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]['multiplier']>(SPEEDS[0].multiplier);
  const [playing, setPlaying] = useState(false);
  const [liveEdgeSeconds, setLiveEdgeSeconds] = useState(() => computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds));
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const finished = elapsed >= log.totalDurationSeconds;
  const caughtUp = started && !finished && elapsed >= liveEdgeSeconds;

  useEffect(() => {
    if (!playing || finished) return;
    const interval = setInterval(() => {
      const edge = computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds);
      setLiveEdgeSeconds(edge);
      setElapsed((current) => Math.min(current + 0.1 * speedRef.current, log.totalDurationSeconds, edge));
    }, 100);
    return () => clearInterval(interval);
  }, [playing, finished, log.simulatedAt, log.totalDurationSeconds]);

  const moments = useMemo(() => deriveMoments(log, playerAName, playerBName), [log, playerAName, playerBName]);
  const visibleMoments = useMemo(() => moments.filter((m) => m.offsetSeconds <= elapsed).slice().reverse(), [moments, elapsed]);

  const setNumbers = useMemo(() => [...new Set(log.entries.map((e) => e.setNumber))].sort((a, b) => a - b), [log.entries]);
  const visibleEntries = useMemo(() => log.entries.filter((e) => e.offsetSeconds <= elapsed), [log.entries, elapsed]);

  const setCells = setNumbers.map((setNumber) => {
    const laterSetVisible = visibleEntries.some((e) => e.setNumber > setNumber);
    const completed = laterSetVisible || (finished && setNumber === setNumbers[setNumbers.length - 1]);
    const entriesForSet = (completed ? log.entries : visibleEntries).filter((e) => e.setNumber === setNumber);
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
  const aLeading =
    finished && overallWinnerSide === 'A'
      ? true
      : finished
        ? false
        : setCells.filter((c) => c.completed && (c.gamesForA ?? 0) > (c.gamesForB ?? 0)).length >=
          setCells.filter((c) => c.completed && (c.gamesForB ?? 0) > (c.gamesForA ?? 0)).length;

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

  let statusLabel: string;
  let statusDotColor: string | null = null;
  let statusPulse = false;
  let statusBg = 'oklch(93% 0.006 75)';
  let statusFg = 'oklch(40% 0.006 75)';
  if (!started) {
    statusLabel = 'Ready to watch';
  } else if (finished) {
    statusLabel = 'Replay complete';
    statusDotColor = DARK;
    statusBg = 'oklch(90% 0.006 75)';
  } else if (caughtUp) {
    statusLabel = "You're caught up — waiting for the next point";
    statusDotColor = 'oklch(55% 0.13 240)';
    statusPulse = true;
    statusBg = 'oklch(93% 0.02 240)';
    statusFg = 'oklch(38% 0.1 240)';
  } else {
    statusLabel = playing ? 'Replay in progress' : 'Replay paused';
    statusDotColor = surfaceColor;
    statusPulse = playing;
  }

  const premiereTime = new Date(log.simulatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div>
      <style>{`@keyframes replay-pulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>

      {/* SCORE PANEL */}
      <div className="relative bg-white rounded-[10px] p-[22px_24px]" style={{ border: '1px solid oklch(90% 0.005 75)' }}>
        <div className="flex items-center justify-between mb-4">
          <div
            className="flex items-center gap-[7px] text-[12.5px] font-semibold px-[10px] py-[5px] rounded-full"
            style={{ background: statusBg, color: statusFg }}
          >
            {statusDotColor && (
              <div
                className="w-[7px] h-[7px] rounded-full"
                style={{ background: statusDotColor, animation: statusPulse ? 'replay-pulse 1.2s ease-in-out infinite' : undefined }}
              />
            )}
            {statusLabel}
          </div>
          <div className="text-[11px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            {started ? `${visibleEntries.length} of ${log.entries.length} games` : `${log.entries.length} games simulated`}
          </div>
        </div>

        <div className="grid gap-[10px_16px] items-center" style={{ gridTemplateColumns: '1fr auto' }}>
          <div className="flex items-center gap-[10px]">
            {playerAFlag && <span>{playerAFlag}</span>}
            <div className="text-[15px]" style={{ fontWeight: finished && aLeading ? 700 : 600, color: 'oklch(22% 0.006 75)' }}>
              {playerAName}
            </div>
          </div>
          <div className="flex gap-2">
            {setCells.map((c) => (
              <div key={c.setNumber} className="flex flex-col items-center gap-[3px]">
                <div
                  className="text-[8.5px] font-bold tracking-[0.4px]"
                  style={{ color: c.completed || c.active ? 'oklch(52% 0.006 75)' : 'oklch(80% 0.006 75)' }}
                >
                  SET {c.setNumber}
                  {c.active && ' · PREMIERE'}
                </div>
                <div
                  className="w-[34px] h-[34px] rounded-[6px] flex items-center justify-center text-[15px] [font-variant-numeric:tabular-nums]"
                  style={{
                    fontWeight: c.active ? 700 : 500,
                    background: c.active ? 'oklch(93% 0.02 45)' : 'oklch(96% 0.003 75)',
                    color: c.completed || c.active ? 'oklch(22% 0.006 75)' : 'oklch(75% 0.006 75)',
                  }}
                >
                  {c.gamesForA ?? '–'}
                  {c.completed && c.tieLoserPoints !== null && overallWinnerSide === 'A' && (
                    <sup className="text-[9px] ml-[1px]">{c.tieLoserPoints}</sup>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-[10px]">
            {playerBFlag && <span>{playerBFlag}</span>}
            <div className="text-[15px]" style={{ fontWeight: finished && !aLeading ? 700 : 600, color: 'oklch(22% 0.006 75)' }}>
              {playerBName}
            </div>
          </div>
          <div className="flex gap-2">
            {setCells.map((c) => (
              <div key={c.setNumber} className="flex flex-col items-center gap-[3px]">
                <div
                  className="w-[34px] h-[34px] rounded-[6px] flex items-center justify-center text-[15px] [font-variant-numeric:tabular-nums]"
                  style={{
                    fontWeight: c.active ? 700 : 500,
                    background: c.active ? 'oklch(93% 0.02 45)' : 'oklch(96% 0.003 75)',
                    color: c.completed || c.active ? 'oklch(22% 0.006 75)' : 'oklch(75% 0.006 75)',
                  }}
                >
                  {c.gamesForB ?? '–'}
                  {c.completed && c.tieLoserPoints !== null && overallWinnerSide === 'B' && (
                    <sup className="text-[9px] ml-[1px]">{c.tieLoserPoints}</sup>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {currentPoint && (
          <div className="mt-[14px] flex items-center gap-2">
            <div className="text-[11px]" style={{ color: 'oklch(55% 0.006 75)' }}>
              Current game
            </div>
            {(() => {
              const pl = pointLabel(currentPoint.pointScoreA, currentPoint.pointScoreB, playerAName, playerBName);
              return (
                <div
                  className="inline-flex items-center gap-[6px] text-[12.5px] px-[10px] py-1 rounded-[5px]"
                  style={{
                    fontWeight: pl.tense ? 700 : 600,
                    background: pl.tense ? 'oklch(90% 0.05 60)' : 'oklch(96% 0.003 75)',
                    color: pl.tense ? 'oklch(40% 0.12 45)' : 'oklch(45% 0.006 75)',
                  }}
                >
                  {pl.label}
                </div>
              );
            })()}
          </div>
        )}

        {!started && (
          <div
            className="absolute inset-0 rounded-[10px] flex flex-col items-center justify-center gap-[14px] text-center p-5"
            style={{ background: 'rgba(255,255,255,0.96)' }}
          >
            <div className="text-[11px] font-bold tracking-[0.5px] uppercase" style={{ color: 'oklch(52% 0.006 75)' }}>
              Premieres at {premiereTime} &middot; Result already decided
            </div>
            <div className="text-[14px] max-w-[380px] leading-[1.5]" style={{ color: 'oklch(35% 0.006 75)' }}>
              This match was simulated in full ahead of time. Press play to watch it unfold in sync with its scheduled
              slot — you can skip ahead to catch up any time.
            </div>
            <button
              onClick={() => {
                setStarted(true);
                setPlaying(true);
              }}
              className="flex items-center gap-2 text-white border-none px-[22px] py-[12px] rounded-[6px] text-[14px] font-semibold cursor-pointer hover:opacity-90"
              style={{ background: DARK }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <path d="M6 4l14 8-14 8V4z" />
              </svg>
              Watch replay
            </button>
          </div>
        )}
      </div>

      {/* PLAYBACK CONTROLS */}
      {started && (
        <div className="mt-4 bg-white rounded-[10px] p-[16px_20px]" style={{ border: '1px solid oklch(90% 0.005 75)' }}>
          <div className="relative h-5 mb-[6px]">
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
                className="absolute top-0 w-[2px] h-2"
                style={{ left: `${(m.offsetSeconds / log.totalDurationSeconds) * 100}%`, background: 'oklch(65% 0.006 75)', transform: 'translateX(-1px)' }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlaying((p) => !p)}
                disabled={finished}
                className="w-[34px] h-[34px] rounded-[6px] text-white border-none cursor-pointer flex items-center justify-center hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: DARK }}
              >
                {playing ? '⏸' : '▶'}
              </button>
              <button
                onClick={prevMoment}
                className="px-[10px] py-[7px] rounded-[6px] bg-transparent text-[12px] font-semibold cursor-pointer"
                style={{ border: '1px solid oklch(88% 0.006 75)', color: 'oklch(35% 0.006 75)' }}
              >
                &larr; Prev moment
              </button>
              <button
                onClick={nextMoment}
                disabled={caughtUp}
                className="px-[10px] py-[7px] rounded-[6px] bg-transparent text-[12px] font-semibold cursor-pointer disabled:cursor-not-allowed"
                style={{
                  border: `1px solid ${caughtUp ? 'oklch(92% 0.006 75)' : 'oklch(88% 0.006 75)'}`,
                  color: caughtUp ? 'oklch(78% 0.006 75)' : 'oklch(35% 0.006 75)',
                }}
              >
                Next moment &rarr;
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-[11px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                Speed
              </div>
              {SPEEDS.map(({ multiplier, label }) => (
                <button
                  key={multiplier}
                  onClick={() => !caughtUp && setSpeed(multiplier)}
                  disabled={caughtUp}
                  className="px-[9px] py-[6px] rounded-[5px] text-[11.5px] font-bold cursor-pointer disabled:cursor-not-allowed"
                  style={{
                    border: `1px solid ${caughtUp ? 'oklch(92% 0.006 75)' : speed === multiplier ? DARK : 'oklch(88% 0.006 75)'}`,
                    background: !caughtUp && speed === multiplier ? DARK : 'transparent',
                    color: caughtUp ? 'oklch(78% 0.006 75)' : speed === multiplier ? 'white' : 'oklch(40% 0.006 75)',
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                onClick={() => jumpTo(liveEdgeSeconds)}
                disabled={caughtUp}
                className="ml-1 px-[10px] py-[7px] rounded-[6px] bg-transparent text-[12px] font-semibold cursor-pointer disabled:cursor-not-allowed"
                style={{
                  border: `1px solid ${caughtUp ? 'oklch(92% 0.006 75)' : 'oklch(88% 0.006 75)'}`,
                  color: caughtUp ? 'oklch(78% 0.006 75)' : 'oklch(35% 0.006 75)',
                }}
              >
                {caughtUp ? 'Caught up' : 'Skip to now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MATCH COMPLETE BANNER */}
      {finished && (
        <div className="mt-4 text-white rounded-[10px] p-[18px_22px] flex items-center justify-between flex-wrap gap-3" style={{ background: DARK }}>
          <div>
            <div className="text-[13px] font-bold tracking-[0.3px]">
              {overallWinnerSide === 'A' ? playerAName : playerBName} wins {formatMatchScoreline(log, overallWinnerSide ?? 'A')}
            </div>
            <div className="text-[12px] mt-[3px]" style={{ color: 'oklch(75% 0.006 75)' }}>
              Replay complete{nextRoundLabel ? ` · advances to ${nextRoundLabel}` : ''}
            </div>
          </div>
          <div className="flex gap-2">
            {backToBracketHref && (
              <Link href={backToBracketHref} className="px-[14px] py-[9px] rounded-[6px] text-white text-[12.5px] font-semibold no-underline" style={{ background: 'oklch(30% 0.008 75)' }}>
                Back to bracket
              </Link>
            )}
            {nextReplayHref && nextRoundLabel && (
              <Link href={nextReplayHref} className="px-[14px] py-[9px] rounded-[6px] text-white text-[12.5px] font-semibold no-underline" style={{ background: 'oklch(76% 0.19 122)' }}>
                View {nextRoundLabel} &rarr;
              </Link>
            )}
          </div>
        </div>
      )}

      {/* COMMENTARY FEED */}
      <div className="mt-4">
        <div className="text-[13px] font-bold mb-2">Commentary</div>
        <div className="flex flex-col gap-2 overflow-y-auto pr-1" style={{ maxHeight: 360 }}>
          {visibleMoments.map((m, i) => {
            const accent = m.type === 'match' ? DARK : m.type === 'tiebreak' ? 'oklch(55% 0.13 240)' : m.type === 'set' ? 'oklch(30% 0.006 75)' : surfaceColor;
            return (
              <div
                key={i}
                className="flex gap-3 px-3 py-[10px] rounded-r-[6px]"
                style={{ borderLeft: `3px solid ${accent}`, background: 'oklch(97% 0.003 75)' }}
              >
                <div className="text-[10.5px] font-bold whitespace-nowrap" style={{ color: 'oklch(50% 0.006 75)', minWidth: 88 }}>
                  {formatElapsed(m.offsetSeconds)}
                </div>
                <div className="text-[13px] leading-[1.4]" style={{ color: 'oklch(28% 0.006 75)' }}>
                  {m.text}
                </div>
              </div>
            );
          })}
          {visibleMoments.length === 0 && (
            <div className="text-[13px] py-[10px]" style={{ color: 'oklch(55% 0.006 75)' }}>
              {started ? 'Nothing notable yet — keep watching.' : 'Commentary will appear here once you press play.'}
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
