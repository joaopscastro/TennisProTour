'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createProCheckoutSession,
  fetchNotificationPreferences,
  setNotificationPreferences,
} from '../../lib/api';
import { useDevManagerId } from '../../lib/managerContext';
import { useEntitlement } from '../../lib/entitlement';
import { AppShell } from '../../components/ui/AppShell';
import { PageShell, SectionLabel, Button } from '../../components/ui/primitives';
import { Icon } from '../../components/ui/Icon';

const CONVENIENCE_PERKS = [
  {
    title: 'Longer registration windows',
    body: "More time to enter tournaments around your schedule — the entry requirements and field are identical.",
  },
  {
    title: 'Extra stats & history pages',
    body: 'Deeper match history and long-run performance charts. Nothing here changes a single simulation.',
  },
  {
    title: 'Vacation delegate',
    body: "Hand your roster to another Pro manager while you're away, so fatigue and entries don't pile up untouched.",
  },
  {
    title: 'No banners',
    body: "Removes ad banners from your dashboard. That's it — no simulation changes.",
  },
];

export default function ManagerProPage() {
  const devManagerId = useDevManagerId();
  const [managerId, setManagerId] = useState(devManagerId ?? '');
  const [managerIdInput, setManagerIdInput] = useState(devManagerId ?? '');
  const { entitlement } = useEntitlement(managerId);
  const [error, setError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  // null = not loaded yet; the toggle is disabled until we know the real
  // preference rather than showing a guessed state.
  const [digestOptOut, setDigestOptOut] = useState<boolean | null>(null);
  const [savingPreference, setSavingPreference] = useState(false);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      setDigestOptOut((await fetchNotificationPreferences(id)).digestOptOut);
    } catch {
      // Leave the toggle disabled if the preference read failed — the
      // rest of the page is still usable.
      setDigestOptOut(null);
    }
  }, []);

  useEffect(() => {
    void load(managerId);
  }, [managerId, load]);

  const tier = entitlement?.tier ?? 'free';

  const handleToggleDigest = useCallback(async () => {
    if (digestOptOut === null) return;
    setSavingPreference(true);
    setError(null);
    try {
      const next = await setNotificationPreferences(!digestOptOut, managerId);
      setDigestOptOut(next.digestOptOut);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPreference(false);
    }
  }, [digestOptOut, managerId]);

  const handleUpgrade = useCallback(async () => {
    setCheckingOut(true);
    setError(null);
    try {
      const { url } = await createProCheckoutSession(managerId);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCheckingOut(false);
    }
  }, [managerId]);

  return (
    <AppShell active="manager-pro" tier={tier} xpBalance={entitlement?.xpBalance}>
      <PageShell>
        {/* Hero band — flat panel, 2px accent top rule. */}
        <div className="gc-band" style={{ ['--surf' as string]: 'var(--accent)', minHeight: 140, padding: '22px 24px', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', width: '100%' }}>
            <div style={{ maxWidth: 660 }}>
              <span
                className="gc-badge"
                style={{ color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)', marginBottom: 14 }}
              >
                <Icon name="diamond" size={11} />
                Membership
              </span>
              <h1 className="t-h1" style={{ margin: 0 }}>Manager Pro</h1>
              <div className="t-body-sm" style={{ marginTop: 10, lineHeight: 1.6 }}>
                More room to manage, less upkeep, and a modest coaching edge — never a better formula.
                The coaching system works identically for every manager; Pro just gets a second slot to run
                it with. Every perk that touches competitiveness is spelled out below in plain sight — nothing
                hidden in fine print.
              </div>
            </div>
            {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
              <form
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, flex: 'none', color: 'var(--ink-3)' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  setManagerId(managerIdInput.trim() || managerId);
                }}
              >
                Manager ID (dev)
                <input
                  value={managerIdInput}
                  onChange={(e) => setManagerIdInput(e.target.value)}
                  className="gc-input"
                  style={{ width: 110, padding: '5px 9px', fontSize: 12 }}
                />
              </form>
            )}
          </div>
        </div>

        {error && (
          <div
            className="gc-notice"
            style={{ marginTop: 20, color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)', background: 'color-mix(in srgb, var(--loss) 10%, transparent)' }}
          >
            {error}
          </div>
        )}

        {/* TIER CARDS */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, margin: '28px 0 32px' }}>
          <div className="gc-panel" style={{ padding: 24 }}>
            <div className="t-label">Free</div>
            <div className="num" style={{ fontSize: 30, fontWeight: 700, marginTop: 8, color: 'var(--ink)' }}>$0</div>
            <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
              Fully playable. Every tournament, every match sim, every core system — no crippled trial, no paywalled
              mechanics.
            </div>
            <div style={{ height: 1, margin: '20px 0', background: 'var(--hair)' }} />
            <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-2)' }}>
              <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icon name="check" size={13} /></span>
              2 roster slots, full decay rate
            </div>
            {tier === 'free' && (
              <div className="gc-badge" style={{ marginTop: 16, color: 'var(--ink-2)' }}>
                Your current plan
              </div>
            )}
          </div>

          <div className="gc-panel" style={{ padding: 24, border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)', borderTop: '2px solid var(--accent)' }}>
            <div className="t-label" style={{ color: 'var(--accent)' }}>Manager Pro</div>
            <div className="num" style={{ fontSize: 30, fontWeight: 700, marginTop: 8, color: 'var(--ink)' }}>
              $4.99<span style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-3)' }}>/mo</span>
            </div>
            <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
              More room to manage, less upkeep — and one honest tradeoff on the one perk that matters competitively.
            </div>
            <div style={{ height: 1, margin: '20px 0', background: 'var(--hair)' }} />
            {tier === 'pro' ? (
              <div
                style={{
                  width: '100%', textAlign: 'center', padding: '12px 0', borderRadius: 'var(--r2)',
                  fontSize: 13.5, fontWeight: 700, color: 'var(--accent)',
                  background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
                }}
              >
                You&rsquo;re on Manager Pro
              </div>
            ) : (
              <Button
                variant="primary"
                onClick={handleUpgrade}
                disabled={checkingOut}
                style={{ width: '100%', padding: '12px 0', fontSize: 13.5, justifyContent: 'center' }}
              >
                {checkingOut ? 'Redirecting to checkout…' : 'Upgrade to Manager Pro'}
              </Button>
            )}
          </div>
        </div>

        {/* EMAIL NOTIFICATIONS */}
        <SectionLabel>Email notifications</SectionLabel>
        <div className="gc-tbl-note" style={{ padding: 0, marginBottom: 12 }}>
          Your weekly results digest — a short recap of your players&rsquo; results, titles, and next matches.
        </div>
        <div className="gc-panel" style={{ padding: '18px 20px', marginBottom: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)' }}>
              Weekly results digest
            </div>
            <div className="t-body-sm" style={{ marginTop: 4, lineHeight: 1.55 }}>
              On by default. Every email carries a one-click unsubscribe link, and you can turn it off here any time.
            </div>
          </div>
          <Button
            type="button"
            role="switch"
            aria-checked={digestOptOut === false}
            aria-label="Weekly results digest"
            onClick={handleToggleDigest}
            disabled={digestOptOut === null || savingPreference}
            style={{
              minWidth: 96,
              flex: 'none',
              justifyContent: 'center',
              background: digestOptOut === false ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--bg-3)',
              color: digestOptOut === false ? 'var(--accent)' : 'var(--ink-2)',
              border: '1px solid var(--hair)',
            }}
          >
            {digestOptOut === null ? 'Loading…' : digestOptOut ? 'Off' : 'On'}
          </Button>
        </div>

        {/* THE ONE PERK WITH A REAL EDGE */}
        <SectionLabel>The one perk with a real edge</SectionLabel>
        <div className="gc-tbl-note" style={{ padding: 0, marginBottom: 12 }}>
          This does affect competitiveness — here&rsquo;s exactly what it is and why it&rsquo;s still fair.
        </div>
        <div
          className="gc-panel"
          style={{ padding: '22px 24px', marginBottom: 32, borderTop: '2px solid var(--hard)' }}
        >
          <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--ink)' }}>
            A 2nd coach slot
          </div>
          <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
            Run two coaches training two players at once instead of one. This is a real training-efficiency edge
            over a single-coach roster — not a hidden one, and not a bigger one than that.
          </div>
          <div className="t-body-sm" style={{ marginTop: 10, lineHeight: 1.55 }}>
            The coaching system itself is identical for every manager: same formulas, same training gains per coach,
            free or Pro. Manager Pro doesn&rsquo;t get a better coach — it gets a second one.
          </div>
        </div>

        {/* THE ONE PERK WITH A COST */}
        <SectionLabel>The one perk with a cost</SectionLabel>
        <div className="gc-tbl-note" style={{ padding: 0, marginBottom: 12 }}>
          The only part of Manager Pro with a real cost attached to it — and it&rsquo;s not a flat unlock.
        </div>
        <div
          className="gc-panel"
          style={{ padding: '22px 24px', marginBottom: 32, borderTop: '2px solid var(--clay)' }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 22, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--ink)' }}>
                4 roster slots instead of 2
              </div>
              <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
                Manage twice the players and enter twice the tournaments at once.
              </div>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--hair-2)' }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15.5, fontWeight: 700, color: 'var(--clay)' }}>
                <Icon name="alert" size={15} />
                Faster point decay on those slots
              </div>
              <div className="t-body-sm" style={{ marginTop: 6, lineHeight: 1.55 }}>
                Your 2 extra slots lose ranking points faster between tournaments than your base 2. More roster, more
                decay — not a free power gain.
              </div>
            </div>
          </div>
        </div>

        {/* PURE CONVENIENCE */}
        <SectionLabel>Everything else is convenience</SectionLabel>
        <div className="gc-tbl-note" style={{ padding: 0, marginBottom: 12 }}>
          Zero effect on competitiveness — quality-of-life for managers who play a lot, not an edge for managers who
          pay.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          {CONVENIENCE_PERKS.map((perk) => (
            <div key={perk.title} className="gc-card" style={{ padding: '18px 20px' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{perk.title}</div>
              <div className="t-body-sm" style={{ marginTop: 4, lineHeight: 1.55 }}>
                {perk.body}
              </div>
            </div>
          ))}
        </div>

        <details className="gc-details" style={{ marginTop: 28, maxWidth: 660 }}>
          <summary>Why Manager Pro is priced this way</summary>
          <div className="t-body-sm" style={{ marginTop: 8, lineHeight: 1.65 }}>
            We built Manager Pro this way on purpose: of the two perks that touch competitiveness, one (roster slots)
            carries an equal and opposite cost, so paying never buys a stronger roster — only a bigger, faster-aging
            one. The other (a 2nd coach slot) is a modest, fully disclosed training-efficiency edge running the same
            coaching system every manager uses — not a better version of it.
          </div>
        </details>
      </PageShell>
    </AppShell>
  );
}
