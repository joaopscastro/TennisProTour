import { redirect } from 'next/navigation';

/**
 * The old standalone "scouting report" page is gone: free agents are
 * now real Players with a single canonical profile at /players/[id]
 * (see docs/CLAUDE.md's candidate/player unification). Any lingering
 * /scouting/[id] link just forwards to that profile.
 *
 * A server-side redirect (no client render, no flash): the route has no
 * visual design of its own to migrate — it is a forward, not a screen.
 */
export default async function ScoutingReportRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/players/${id}`);
}
