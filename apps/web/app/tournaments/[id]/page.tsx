'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { fetchTournament, matchIdForSlot, simulateMatch, TournamentDto } from '../../../lib/api';

export default function TournamentPage() {
  const params = useParams<{ id: string }>();
  const tournamentId = params.id;
  const [tournament, setTournament] = useState<TournamentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTournament(await fetchTournament(tournamentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSimulate(roundNumber: number, matchIndex: number) {
    const slot = matchIdForSlot(tournamentId, roundNumber, matchIndex);
    setBusySlot(slot);
    setError(null);
    try {
      await simulateMatch(tournamentId, roundNumber, matchIndex);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySlot(null);
    }
  }

  if (error && !tournament) return <p style={{ color: '#b00020' }}>Error: {error}</p>;
  if (!tournament) return <p>Loading…</p>;

  return (
    <div>
      <h1>
        {tournament.id} <span style={{ fontWeight: 400, color: '#666' }}>
          {tournament.tier} · {tournament.surface} · S{tournament.weekScheduled.season}W{tournament.weekScheduled.week} ·
          draw {tournament.drawSize}
        </span>
      </h1>
      {error && <p style={{ color: '#b00020' }}>Error: {error}</p>}

      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', overflowX: 'auto' }}>
        {tournament.rounds.map((round) => (
          <section key={round.roundNumber} style={{ minWidth: 240 }}>
            <h2 style={{ fontSize: '1rem' }}>Round {round.roundNumber}</h2>
            {round.matches.map((match, matchIndex) => {
              const slot = matchIdForSlot(tournament.id, round.roundNumber, matchIndex);
              return (
                <div
                  key={slot}
                  style={{ border: '1px solid #ddd', borderRadius: 6, background: '#fff', padding: '0.5rem', marginBottom: '0.75rem' }}
                >
                  {[match.entrantA, match.entrantB].map((entrant) => (
                    <div
                      key={entrant}
                      style={{
                        padding: '0.15rem 0',
                        fontWeight: match.outcome?.winner === entrant ? 700 : 400,
                        color: match.outcome && match.outcome.winner !== entrant ? '#999' : 'inherit',
                      }}
                    >
                      {entrant}
                      {match.outcome?.winner === entrant && ' ✓'}
                    </div>
                  ))}
                  {match.outcome ? (
                    <div style={{ fontSize: '0.85rem', color: '#555' }}>
                      {match.outcome.setScores.map((s) => `${s.winnerGames}-${s.loserGames}`).join(', ')}{' '}
                      <a href={`/replay/${slot}`}>watch replay</a>
                    </div>
                  ) : (
                    <button onClick={() => onSimulate(round.roundNumber, matchIndex)} disabled={busySlot === slot}>
                      {busySlot === slot ? 'Simulating…' : 'Simulate'}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
