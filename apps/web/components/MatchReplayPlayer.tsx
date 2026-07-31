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

const SPEEDS = [120, 240, 960] as const; // game-seconds per wall-clock second

interface Props {
  log: MatchLogDto;
  playerAName?: string;
  playerBName?: string;
}

export function MatchReplayPlayer({ log, playerAName = 'Player A', playerBName = 'Player B' }: Props) {
  const [elapsed, setElapsed] = useState(0); // in-game seconds
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(240);
  const [playing, setPlaying] = useState(true);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const finished = elapsed >= log.totalDurationSeconds;

  useEffect(() => {
    if (!playing || finished) return;
    const interval = setInterval(() => {
      setElapsed((current) => Math.min(current + 0.1 * speedRef.current, log.totalDurationSeconds));
    }, 100);
    return () => clearInterval(interval);
  }, [playing, finished, log.totalDurationSeconds]);

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
            setPlaying(true);
          }}
        >
          Restart
        </button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            style={{ fontWeight: speed === s ? 700 : 400 }}
          >
            ×{s}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: '#999', fontSize: '0.8rem' }}>
          {visible.length}/{log.entries.length} games
        </span>
      </div>
    </div>
  );
}
