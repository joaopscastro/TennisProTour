'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { fetchMatchLog, MatchLogDto } from '../../../lib/api';
import { MatchReplayPlayer } from '../../../components/MatchReplayPlayer';

export default function ReplayPage() {
  const params = useParams<{ matchId: string }>();
  const [log, setLog] = useState<MatchLogDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // One plain GET for an immutable blob — the entirety of this
    // page's server interaction (CLAUDE.md principle #4).
    fetchMatchLog(params.matchId)
      .then(setLog)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [params.matchId]);

  return (
    <div>
      <h1 style={{ fontSize: '1.2rem' }}>Replay: {params.matchId}</h1>
      {error && <p style={{ color: '#b00020' }}>Error: {error}</p>}
      {!log && !error && <p>Loading replay…</p>}
      {log && <MatchReplayPlayer log={log} />}
    </div>
  );
}
