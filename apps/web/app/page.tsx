'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchRoster, PlayerDto } from '../lib/api';

function years(ageInWeeks: number): string {
  return (ageInWeeks / 52).toFixed(1);
}

function avg(values: number[]): number {
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

export default function RosterPage() {
  const [managerId, setManagerId] = useState('m1');
  const [input, setInput] = useState('m1');
  const [roster, setRoster] = useState<PlayerDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      setRoster(await fetchRoster(id));
    } catch (e) {
      setRoster(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(managerId);
  }, [managerId, load]);

  return (
    <div>
      <h1>Roster</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setManagerId(input.trim());
        }}
        style={{ marginBottom: '1rem' }}
      >
        <label>
          Manager id{' '}
          <input value={input} onChange={(e) => setInput(e.target.value)} style={{ padding: '0.25rem' }} />
        </label>{' '}
        <button type="submit">Load</button>
      </form>

      {error && <p style={{ color: '#b00020' }}>Error: {error}</p>}
      {roster && roster.length === 0 && <p>No players for manager “{managerId}”.</p>}

      {roster && roster.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%', background: '#fff' }}>
          <thead>
            <tr>
              {['Name', 'Age', 'Stage', 'Fatigue', 'Tech', 'Phys', 'Mental', 'Clay', 'Grass', 'Hard', 'Indoor'].map(
                (h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '2px solid #ccc' }}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {roster.map((p) => {
              const { technical, physical, mental, surfaceAffinities } = p.attributes;
              return (
                <tr key={p.id}>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                    {p.name} <span style={{ color: '#999' }}>({p.id})</span>
                  </td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{years(p.ageInWeeks)}</td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{p.stage}</td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{p.fatigue}</td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                    {avg([technical.serve, technical.forehand, technical.backhand, technical.volley])}
                  </td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                    {avg([physical.speed, physical.stamina, physical.strength])}
                  </td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                    {avg([mental.consistency, mental.clutch])}
                  </td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{surfaceAffinities.clay}%</td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{surfaceAffinities.grass}%</td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{surfaceAffinities.hard}%</td>
                  <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>{surfaceAffinities.indoor}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
