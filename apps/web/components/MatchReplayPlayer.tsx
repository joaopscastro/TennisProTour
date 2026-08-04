'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MatchLogDto } from '../lib/api';

/**
 * The "fake live" replay player — CLAUDE.md principle #4 made
 * visible. The whole match was simulated server-side long before this
 * component mounted; what it receives is one immutable JSON blob
 * fetched over plain HTTP. Everything "live" here — the ticking
 * clock, games arriving one by one, the LIVE badge — is manufactured
 * client-side by advancing a local timer through the log's
 * offsetSeconds. No WebSocket, no SSE, no polling: the server was
 * involved exactly once, and a million concurrent viewers would cost
 * it nothing more than CDN traffic.
 */

// Game-seconds per wall-clock second, labeled by estimated watch time
// rather than the raw internal multiplier (docs/ui-direction.md: "an
// implementation detail and shouldn't leak into button labels").
// Watch-time estimates are the median across 500 real simulated
// matches — see the StatisticalMatchSimulator size/pacing measurement
// this was derived from, not a guess.
const SPEEDS = [
  { multiplier: 120, label: 'Normal (~40s)' },
  { multiplier: 240, label: 'Fast (~20s)' },
  { multiplier: 960, label: 'Very fast (~5s)' },
] as const;

/**
 * The wall-clock-synced "Premiere" live edge (docs/ui-direction.md):
 * in-game seconds since `simulatedAt`, capped to the match's actual
 * length. Pacing is calibrated so one in-game second of simulated
 * match time approximates one real second of an actual broadcast, so
 * this is a direct (not scaled) real-time-since-simulation reading.
 * A missing/unparseable `simulatedAt` (e.g. an older blob predating
 * this field) is treated as "already fully aired" rather than
 * crashing or permanently capping playback at zero.
 */
function computeLiveEdgeSeconds(simulatedAt: string, totalDurationSeconds: number, now: number = Date.now()): number {
  const simulatedAtMs = new Date(simulatedAt).getTime();
  if (Number.isNaN(simulatedAtMs)) return totalDurationSeconds;
  const realElapsedSeconds = (now - simulatedAtMs) / 1000;
  return Math.min(Math.max(realElapsedSeconds, 0), totalDurationSeconds);
}

interface Props {
  log: MatchLogDto;
  playerAName?: string;
  playerBName?: string;
}

export function MatchReplayPlayer({ log, playerAName = 'Player A', playerBName = 'Player B' }: Props) {
  const [elapsed, setElapsed] = useState(0); // in-game seconds
  // Default to the slowest/most watchable tier, not the middle one
  // (docs/ui-direction.md).
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]['multiplier']>(SPEEDS[0].multiplier);
  const [playing, setPlaying] = useState(true);
  const [liveEdgeSeconds, setLiveEdgeSeconds] = useState(() =>
    computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds),
  );
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const finished = elapsed >= log.totalDurationSeconds;
  // Consumed everything real time has "aired" so far, but the match
  // itself isn't over yet — distinct from `finished`.
  const caughtUp = !finished && elapsed >= liveEdgeSeconds;

  useEffect(() => {
    if (!playing || finished) return;
    const interval = setInterval(() => {
      // Recomputed every tick, not just on mount, so the cap loosens
      // on its own as real time passes — including while caught up,
      // which is what lets "waiting for the next point" resolve
      // itself without any user action.
      const edge = computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds);
      setLiveEdgeSeconds(edge);
      setElapsed((current) => Math.min(current + 0.1 * speedRef.current, log.totalDurationSeconds, edge));
    }, 100);
    return () => clearInterval(interval);
  }, [playing, finished, log.simulatedAt, log.totalDurationSeconds]);

  const visible = useMemo(() => log.entries.filter((e) => e.offsetSeconds <= elapsed), [log.entries, elapsed]);

  const setNumbers = useMemo(
    () => [...new Set(log.entries.map((e) => e.setNumber))].sort((a, b) => a - b),
    [log.entries],
  );

  // Current games-score of each set = its latest visible entry.
  const setScores = setNumbers.map((setNumber) => {
    const entries = visible.filter((e) => e.setNumber === setNumber);
    const last = entries[entries.length - 1];
    return { setNumber, gamesForA: last?.gamesForA ?? 0, gamesForB: last?.gamesForB ?? 0, started: entries.length > 0 };
  });

  const lastGame = visible[visible.length - 1];
  const minutes = Math.floor(elapsed / 60);

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, background: '#fff', padding: '1rem', maxWidth: 560 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <strong data-testid="live-state">
          {finished ? (
            'Final'
          ) : caughtUp ? (
            <span style={{ color: '#b8860b' }}>Caught up — waiting for the next point…</span>
          ) : (
            <span style={{ color: '#b00020' }}>● LIVE{playing ? '' : ' (paused)'}</span>
          )}
        </strong>
        <span style={{ color: '#666' }}>{minutes}&prime; elapsed</span>
      </div>

      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: '0.75rem' }} data-testid="scoreboard">
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.25rem', borderBottom: '1px solid #eee' }}></th>
            {setScores.map((s) => (
              <th key={s.setNumber} style={{ padding: '0.25rem', borderBottom: '1px solid #eee', color: '#666' }}>
                Set {s.setNumber}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: '0.25rem', fontWeight: 600 }}>{playerAName}</td>
            {setScores.map((s) => (
              <td key={s.setNumber} style={{ padding: '0.25rem', textAlign: 'center', fontSize: '1.2rem' }}>
                {s.started ? s.gamesForA : '–'}
              </td>
            ))}
          </tr>
          <tr>
            <td style={{ padding: '0.25rem', fontWeight: 600 }}>{playerBName}</td>
            {setScores.map((s) => (
              <td key={s.setNumber} style={{ padding: '0.25rem', textAlign: 'center', fontSize: '1.2rem' }}>
                {s.started ? s.gamesForB : '–'}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <p style={{ minHeight: '1.2em', color: '#333' }} data-testid="commentary">
        {lastGame
          ? `Game ${lastGame.wonBy === 'A' ? playerAName : playerBName} — ${lastGame.gamesForA}-${lastGame.gamesForB} in set ${lastGame.setNumber}`
          : 'Players are warming up…'}
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button onClick={() => setPlaying((p) => !p)} disabled={finished}>
          {playing ? 'Pause' : 'Resume'}
        </button>
        <button
          onClick={() => {
            setElapsed(0);
            setLiveEdgeSeconds(computeLiveEdgeSeconds(log.simulatedAt, log.totalDurationSeconds));
            setPlaying(true);
          }}
        >
          Restart
        </button>
        {SPEEDS.map(({ multiplier, label }) => (
          <button
            key={multiplier}
            onClick={() => setSpeed(multiplier)}
            style={{ fontWeight: speed === multiplier ? 700 : 400 }}
          >
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: '#999', fontSize: '0.8rem' }}>
          {visible.length}/{log.entries.length} games
        </span>
      </div>
    </div>
  );
}
