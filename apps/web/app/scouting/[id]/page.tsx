'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * The old standalone "scouting report" page is gone: free agents are
 * now real Players with a single canonical profile at /players/[id]
 * (see docs/CLAUDE.md's candidate/player unification). Any lingering
 * /scouting/[id] link just forwards to that profile.
 */
export default function ScoutingReportRedirect() {
  const params = useParams();
  const router = useRouter();

  useEffect(() => {
    const id = params?.id;
    if (typeof id === 'string') router.replace(`/players/${id}`);
  }, [params, router]);

  return null;
}
